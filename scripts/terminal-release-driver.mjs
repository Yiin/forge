import assert from 'node:assert/strict'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { createHash, randomBytes } from 'node:crypto'
import { request } from 'node:http'
import { once } from 'node:events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const [entry, data] = process.argv.slice(2)
assert.ok(entry && data)
const require = createRequire(import.meta.url)
const nativePath = resolve(entry, '../build/Release/pty.node')
const native = require(nativePath)
assert.equal(native.forgeOwnedApiVersion, 1)
const manifest = JSON.parse(
  readFileSync(resolve(nativePath, '../forge-owned-build.json'), 'utf8'),
)
assert.equal(
  createHash('sha256').update(readFileSync(nativePath)).digest('hex'),
  manifest.output.sha256,
)
const originals = []
for (const name of ['spawnOwnedV1', 'spawnOwnedProbeV1']) {
  const spawn = native[name]
  native[name] = (...args) => {
    const receipt = spawn(...args)
    originals.push(receipt)
    console.log(
      JSON.stringify({
        kind: name,
        originalPid: receipt.pid,
        originalFd: receipt.fd,
        state: native.ownedStateV1(receipt.token),
      }),
    )
    return receipt
  }
}
const ordinary = [],
  fork = native.fork
native.fork = (...args) => {
  const receipt = fork(...args)
  ordinary.push(receipt)
  console.log(
    JSON.stringify({ ordinaryOriginal: { pid: receipt.pid, fd: receipt.fd } }),
  )
  return receipt
}
const tty = require('node:tty'),
  ReadStream = tty.ReadStream
tty.ReadStream = function (...args) {
  const socket = Reflect.construct(ReadStream, args)
  const receipt = ordinary.find(
    (value) => value.fd === args[0] && !value.socket,
  )
  if (receipt) receipt.socket = socket
  return socket
}
tty.ReadStream.prototype = ReadStream.prototype
syncBuiltinESMExports()
const workspace = join(data, 'workspace'),
  shell = join(data, 'shell')
mkdirSync(workspace, { recursive: true })
writeFileSync(shell, '#!/bin/sh\nexec /bin/bash --noprofile --norc\n', {
  mode: 0o755,
})
process.env.SHELL = shell
writeFileSync(
  process.env.FORGE_CONFIG,
  `port = 0\n[harness.synthetic]\nname = "Synthetic"\ncommand = "${shell}"\nargs = []\nprotocol = "pty"\nenabled = true\n[harness.synthetic.env]\n`,
)
const { startServer } = await import(pathToFileURL(entry).href)
const server = startServer(0)
await once(server, 'listening')
const base = `http://127.0.0.1:${server.address().port}`
const headers = { origin: base, 'content-type': 'application/json' }
async function json(
  path,
  method = 'GET',
  value,
  expected = 200,
  customHeaders = headers,
) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: customHeaders,
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  })
  const body = await response.json()
  assert.equal(response.status, expected, JSON.stringify(body))
  return body
}
function events(path) {
  const frames = []
  const key = randomBytes(16).toString('base64')
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, {
      headers: {
        Origin: base,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
      },
    })
    req.on('error', reject)
    req.on('response', (response) => {
      response.resume()
      reject(new Error(`Upgrade refused: ${response.statusCode}`))
    })
    req.on('upgrade', (response, socket, head) => {
      assert.equal(
        response.headers['sec-websocket-accept'],
        createHash('sha1')
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest('base64'),
      )
      let buffer = Buffer.alloc(0)
      const decode = (bytes) => {
        buffer = Buffer.concat([buffer, bytes])
        assert.ok(buffer.length <= 524288)
        while (buffer.length >= 2) {
          const opcode = buffer[0] & 15
          let length = buffer[1] & 127,
            offset = 2
          assert.equal(buffer[1] & 128, 0)
          if (length === 126) {
            if (buffer.length < 4) return
            length = buffer.readUInt16BE(2)
            offset = 4
          }
          if (length === 127) {
            if (buffer.length < 10) return
            length = Number(buffer.readBigUInt64BE(2))
            offset = 10
          }
          assert.ok(length <= 262144)
          if (buffer.length < offset + length) return
          const payload = buffer.subarray(offset, offset + length)
          buffer = buffer.subarray(offset + length)
          if (opcode === 1) {
            frames.push(JSON.parse(payload.toString()))
            assert.ok(frames.length <= 4096)
          }
          if (opcode === 8) {
            socket.end(Buffer.from([0x88, 0x80, 0, 0, 0, 0]))
            return
          }
        }
      }
      socket.on('data', decode)
      socket.on('error', () => {})
      if (head.length) decode(head)
      resolve({ frames, socket })
    })
    req.end()
  })
}
let subscription
try {
  const project = await json(
    '/api/projects',
    'POST',
    { name: 'Extracted terminal', path: workspace },
    201,
  )
  const session = await json(
    '/api/sessions',
    'POST',
    {
      projectId: project.id,
      harness: 'synthetic',
      title: 'Extracted terminal',
      cwd: workspace,
    },
    201,
  )
  const selected = await json(
    `/api/workspace/target?kind=session&sessionId=${session.id}`,
  )
  await json(`/api/sessions/${session.id}/prompt`, 'POST', {
    text: "printf 'EXTRACTED_ORDINARY\\n'; exit 0",
  })
  for (let attempt = 0; attempt < 300; attempt++) {
    if (
      ordinary.length === 1 &&
      ordinary[0].socket?.closed &&
      !existsSync(`/proc/${ordinary[0].pid}`)
    )
      break
    assert.ok(attempt < 299, 'Ordinary production harness did not close')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  console.log(
    JSON.stringify({
      ordinaryProductionCaller: {
        pid: ordinary[0].pid,
        socketClosed: ordinary[0].socket.closed,
        pidAbsent: true,
      },
    }),
  )
  const prefix = `/api/sessions/${session.id}/terminals`
  const create = {
    expectedWorkspaceId: selected.workspace.workspaceId,
    expectedWorkspaceRevision: selected.workspace.workspaceRevision,
  }
  await json(prefix, 'POST', create, 403, {
    'content-type': 'application/json',
  })
  const terminal = await json(prefix, 'POST', create, 201)
  assert.equal(terminal.state, 'running')
  assert.equal(terminal.workspace.cwd, workspace)
  const path = `${prefix}/${terminal.id}`
  subscription = await events(`${path}/events?afterSeq=0`)
  const text = 'printf \'EXTRACTED:%s:%s\\n\' "$PWD" "$TERM_PROGRAM"\n'
  const input = await json(`${path}/input`, 'POST', {
    data: Buffer.from(text).toString('base64'),
  })
  assert.deepEqual(input, {
    requestedBytes: Buffer.byteLength(text),
    writtenBytes: Buffer.byteLength(text),
    status: 'written',
  })
  assert.equal(
    (await json(`${path}/resize`, 'POST', { cols: 97, rows: 37 })).cols,
    97,
  )
  for (let attempt = 0; attempt < 100; attempt++) {
    const output = subscription.frames
      .filter((frame) => frame.type === 'data')
      .map((frame) => Buffer.from(frame.data, 'base64').toString())
      .join('')
    if (output.includes(`EXTRACTED:${workspace}:Forge`)) break
    assert.ok(attempt < 99, output)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(subscription.frames[0].type, 'snapshot')
  await json(path, 'DELETE')
  if (!subscription.socket.closed) await once(subscription.socket, 'close')
  assert.equal(subscription.frames.at(-1).type, 'exit')
  assert.equal(subscription.frames.at(-1).cleanup, 'complete')
  console.log(
    JSON.stringify({ route: { terminal, input, frames: subscription.frames } }),
  )
} finally {
  if (subscription && !subscription.socket.closed) {
    const closed = once(subscription.socket, 'close')
    subscription.socket.destroy()
    await closed
  }
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  const db = new DatabaseSync(join(data, 'forge.db'))
  assert.ok(
    db.prepare('SELECT stopped_at FROM server_boots WHERE id=1').get()
      .stopped_at,
  )
  db.close()
  for (const receipt of originals) {
    const state = native.ownedStateV1(receipt.token)
    assert.equal(state.phase, 'reaped')
    assert.equal(state.leaderPidfdOpen, false)
    assert.equal(state.socketClosed, true)
    assert.equal(state.openControlEndpoints, 0)
    assert.equal(state.pendingOperations, 0)
    assert.equal(existsSync(`/proc/${receipt.pid}`), false)
    console.log(
      JSON.stringify({ cleanup: { pid: receipt.pid, state, pidAbsent: true } }),
    )
  }
  for (const receipt of ordinary) {
    assert.equal(receipt.socket.closed, true)
    assert.equal(existsSync(`/proc/${receipt.pid}`), false)
  }
}
