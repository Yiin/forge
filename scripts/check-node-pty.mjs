import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, writeSync } from 'node:fs'

if (
  process.platform !== 'linux' ||
  process.versions.node !== '24.21.0' ||
  process.versions.bun
)
  throw new Error('native:check requires actual Node 24.21.0 on Linux')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(resolve(root, 'apps/server/package.json'))
const pty = require('node-pty')
assert.equal(pty.native.forgeOwnedApiVersion, 1)
const api = pty.ownedLinuxV1
const limits = {
  maxEntries: 65536,
  maxBytes: 268435456,
  maxStatBytes: 4096,
  maxMembers: 256,
  deadlineMs: 1000,
}
const receipts = []
for (const name of ['spawnOwnedV1', 'spawnOwnedProbeV1']) {
  const spawn = pty.native[name]
  pty.native[name] = (...args) => {
    const receipt = spawn(...args)
    receipts.push(receipt)
    console.log(
      JSON.stringify({
        original: { pid: receipt.pid, fd: receipt.fd },
        kind: name,
        state: api.ownedStateV1(receipt.token),
      }),
    )
    return receipt
  }
}
const diagnostics = setTimeout(
  () =>
    console.error(
      JSON.stringify({
        deadline: true,
        retained: receipts.map((receipt) => api.ownedStateV1(receipt.token)),
      }),
    ),
  10000,
)
try {
  const originalReap = pty.native.reapOwnedV1
  let capability
  try {
    pty.native.reapOwnedV1 = (token, bound) =>
      originalReap(token, { ...bound, maxEntries: 1 })
    capability = await api.probeOwnedLinuxV1(1000)
  } finally {
    pty.native.reapOwnedV1 = originalReap
  }
  assert.equal(capability.supported, true)
  assert.equal(capability.cleanupComplete, true)
  console.log(JSON.stringify({ trustedProbeWithConstrainedScan: capability }))
  const receipt = pty.spawnOwnedLinuxV1(
    '/bin/sh',
    ['-c', 'printf "owned:"; read value; printf "%s" "$value"'],
    {
      cwd: '/var/tmp',
      env: { PATH: '/usr/bin:/bin', HOME: '/var/empty' },
      cols: 80,
      rows: 24,
      encoding: null,
      name: 'xterm-256color',
      startupDeadlineMs: 1000,
    },
  )
  let output = ''
  receipt.pty.onData((bytes) => {
    assert.ok(Buffer.isBuffer(bytes))
    output += bytes.toString()
  })
  await receipt.ready
  assert.equal(output, '')
  assert.equal(api.releaseOwnedV1(receipt.token).released, true)
  writeSync(receipt.pty.fd, Buffer.from('synthetic\n'))
  assert.deepEqual(await receipt.leaderExit, { exitCode: 0, signal: null })
  assert.equal(api.ownedStateV1(receipt.token).anchorRetained, true)
  const socket = receipt.pty._socket
  if (!socket.closed)
    await new Promise((resolve) => {
      socket.once('close', resolve)
      socket.destroy()
    })
  const constrained = await api.reapOwnedV1(receipt.token, {
    ...limits,
    maxEntries: 1,
  })
  assert.notEqual(constrained.status, 'complete')
  assert.equal(api.ownedStateV1(receipt.token).anchorRetained, true)
  console.log(JSON.stringify({ ordinaryOwnedConstrainedScan: constrained }))
  let reaped
  for (let round = 0; round < 8; round++) {
    reaped = await api.reapOwnedV1(receipt.token, limits)
    if (reaped.status === 'complete') break
  }
  assert.equal(reaped.status, 'complete')
  assert.match(output, /owned:synthetic/)
  for (const original of receipts) {
    const state = api.ownedStateV1(original.token)
    assert.equal(state.phase, 'reaped')
    assert.equal(state.leaderPidfdOpen, false)
    assert.equal(state.socketClosed, true)
    assert.equal(state.pendingOperations, 0)
    assert.equal(existsSync(`/proc/${original.pid}`), false)
    console.log(
      JSON.stringify({ cleanup: { pid: original.pid, state, absent: true } }),
    )
  }
  const ordinary = pty.spawn('/bin/sh', ['-c', 'printf ordinary'], {
    cwd: '/var/tmp',
    env: { PATH: '/usr/bin:/bin', HOME: '/var/empty' },
    cols: 80,
    rows: 24,
  })
  console.log(
    JSON.stringify({ ordinary: { pid: ordinary.pid, fd: ordinary.fd } }),
  )
  let ordinaryOutput = ''
  ordinary.onData((data) => {
    ordinaryOutput += data
  })
  await new Promise((resolve) => ordinary.onExit(resolve))
  assert.equal(ordinaryOutput, 'ordinary')
  console.log(
    JSON.stringify({
      ordinaryClosed: ordinary._socket.closed,
      ordinaryPidAbsent: !existsSync(`/proc/${ordinary.pid}`),
    }),
  )
} finally {
  clearTimeout(diagnostics)
}
