import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import type { Server } from 'node:http'
import { WebSocket } from 'ws'
import { migrate } from '../src/db/migrate.js'
import { WorkspaceTargets } from '../src/workspace/target.js'
import { TerminalManager } from '../src/terminals/manager.js'
import { LinuxPty } from '../src/terminals/linux-pty.js'
import { TerminalAuthority } from '../src/terminals/origin.js'
import { terminalRoutes, TerminalRequests } from '../src/http/terminals.js'
import { WebSocketUpgrades } from '../src/ws-upgrade.js'
import { ServerShutdown } from '../src/shutdown.js'
import {
  terminalDescriptorSchema,
  terminalEventSchema,
  terminalInputOutcomeSchema,
  type TerminalEvent,
} from '@forge/protocol/terminal'

const directory = process.argv[2]!
assert.ok(directory.startsWith('/var/tmp/forge-comet-terminal-implementation-'))
assert.equal(existsSync(directory), false)
mkdirSync(directory)
const workspace = join(directory, 'workspace'),
  home = join(directory, 'home'),
  shell = join(directory, 'synthetic-shell')
mkdirSync(workspace)
mkdirSync(home)
writeFileSync(shell, '#!/bin/sh\nexec /bin/bash --noprofile --norc\n', {
  mode: 0o755,
})
const db = new DatabaseSync(join(directory, 'forge.db'))
migrate(db)
const columns = db.prepare('PRAGMA table_info(sessions)').all()
console.log(JSON.stringify({ columns }))
db.prepare('INSERT INTO projects(id,name,path,created_at) VALUES(?,?,?,?)').run(
  'project-terminal',
  'Synthetic terminal',
  workspace,
  Date.now(),
)
db.prepare(
  "INSERT INTO sessions(id,project_id,harness,cwd,title,status,created_at,last_activity_at,kind,auto_resume) VALUES(?,?,?,?,?,'idle',?,?,'chat',0)",
).run(
  'session-terminal',
  'project-terminal',
  'synthetic',
  workspace,
  'Synthetic session',
  Date.now(),
  Date.now(),
)
db.prepare(
  "INSERT INTO sessions(id,project_id,harness,cwd,title,status,created_at,last_activity_at,kind,auto_resume) VALUES(?,?,?,?,?,'idle',?,?,'chat',0)",
).run(
  'second-terminal',
  'project-terminal',
  'synthetic',
  workspace,
  'Synthetic second session',
  Date.now(),
  Date.now(),
)
const targets = new WorkspaceTargets(db)
const natives: LinuxPty[] = []
const nativeApi = createRequire(import.meta.url)('node-pty').native
const originals: Array<{ pid: number; token: never }> = []
for (const name of ['spawnOwnedV1', 'spawnOwnedProbeV1']) {
  const spawn = nativeApi[name]
  nativeApi[name] = (...args: unknown[]) => {
    const receipt = spawn(...args)
    originals.push(receipt)
    console.log(
      JSON.stringify({
        originalNative: {
          kind: name,
          pid: receipt.pid,
          fd: receipt.fd,
          state: nativeApi.ownedStateV1(receipt.token),
        },
      }),
    )
    return receipt
  }
}
class CapturedPty extends LinuxPty {
  constructor(...args: ConstructorParameters<typeof LinuxPty>) {
    super(...args)
    natives.push(this)
    console.log(
      JSON.stringify({
        original: this.api.ownedStateV1(this.receipt.token),
        pid: this.receipt.pty?.pid,
      }),
    )
  }
  override async cleanup() {
    const complete = await super.cleanup()
    console.log(
      JSON.stringify({
        cleanupAttempt: {
          pid: this.receipt.pty?.pid,
          complete,
          state: this.api.ownedStateV1(this.receipt.token),
        },
      }),
    )
    return complete
  }
}
const manager = new TerminalManager(db, targets, {
  native: CapturedPty,
  limits: {
    inputDeadlineMs: 100,
    batchBytes: 1024,
    replayBytes: 4096,
    replayEvents: 8,
  },
  environment: () => ({ SHELL: shell, HOME: home, PATH: '/usr/bin:/bin' }),
})
const app = new Hono(),
  upgrades = new WebSocketUpgrades(app),
  authority = new TerminalAuthority({ mode: 'loopback' }),
  requests = new TerminalRequests(32, 6000)
app.route('/', terminalRoutes(manager, authority, upgrades, requests))
const server = serve(
  { fetch: app.fetch, hostname: '127.0.0.1', port: 0 },
  (info) => authority.bind(info.port),
) as Server
upgrades.install(server)
const shutdown = new ServerShutdown(
  server,
  () => {
    manager.stopAccepting()
    requests.stopAccepting()
    upgrades.stopAccepting()
  },
  () => {
    console.log('stopped')
  },
)
shutdown.addCleanupHook(() => requests.settled())
shutdown.addCleanupHook(async () => {
  assert.equal(await manager.closeAll(), true)
})
shutdown.addCleanupHook(async () => {
  assert.equal(await upgrades.close(), true)
})
shutdown.addCleanupHook(() => targets.close())
await once(server, 'listening')
const port = (server.address() as { port: number }).port
const base = `http://127.0.0.1:${port}`,
  route = `${base}/api/sessions/session-terminal/terminals`
const headers = { origin: base, 'content-type': 'application/json' }
let socket: WebSocket | undefined
const extraSockets: WebSocket[] = []
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check: () => boolean, label: string, deadlineMs = 3000) {
  const end = performance.now() + deadlineMs
  while (performance.now() < end) {
    if (check()) return
    await delay(10)
  }
  throw new Error(`Physical probe did not observe ${label}`)
}
async function extra(sessionId: string) {
  const selected = await targets.resolve({ kind: 'session', sessionId })
  const prefix = `${base}/api/sessions/${sessionId}/terminals`
  const response = await fetch(prefix, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      expectedWorkspaceId: selected.workspaceId,
      expectedWorkspaceRevision: selected.workspaceRevision,
    }),
  })
  assert.equal(response.status, 201)
  const descriptor = terminalDescriptorSchema.parse(await response.json()),
    path = `${prefix}/${descriptor.id}`
  const events: TerminalEvent[] = []
  const ws = new WebSocket(`${path.replace(/^http/, 'ws')}/events`, {
    headers: { origin: base },
  })
  extraSockets.push(ws)
  ws.on('message', (bytes) => {
    events.push(terminalEventSchema.parse(JSON.parse(String(bytes))))
    assert.ok(events.length < 16384)
  })
  await once(ws, 'open')
  const output = () =>
    Buffer.concat(
      events.flatMap((event) =>
        event.type === 'data' ? [Buffer.from(event.data, 'base64')] : [],
      ),
    )
  const send = async (text: string) => {
    const response = await fetch(`${path}/input`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ data: Buffer.from(text).toString('base64') }),
    })
    const result = await response.json()
    assert.equal(response.status, 200, JSON.stringify(result))
    return result
  }
  await send('stty -echo -onlcr; printf \'READY_%s\\n\' "$$"\n')
  await until(
    () =>
      output().includes(
        Buffer.from(`READY_${natives.at(-1)!.receipt.pty!.pid}`),
      ),
    'shell setup',
  )
  return {
    sessionId,
    descriptor,
    path,
    ws,
    events,
    output,
    send,
    native: natives.at(-1)!,
  }
}
try {
  const selected = await targets.resolve({
    kind: 'session',
    sessionId: 'session-terminal',
  })
  const created = await fetch(route, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      expectedWorkspaceId: selected.workspaceId,
      expectedWorkspaceRevision: selected.workspaceRevision,
    }),
  })
  const result = await created.json()
  console.log(JSON.stringify({ created: created.status, result }))
  assert.equal(created.status, 201)
  const descriptor = terminalDescriptorSchema.parse(result)
  const terminal = `${route}/${descriptor.id}`
  socket = new WebSocket(
    `${terminal.replace(/^http/, 'ws')}/events?afterSeq=0`,
    { headers: { origin: base } },
  )
  const events: unknown[] = []
  socket.on('message', (data) =>
    events.push(terminalEventSchema.parse(JSON.parse(String(data)))),
  )
  await once(socket, 'open')
  const input = await fetch(`${terminal}/input`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      data: Buffer.from(
        'printf \'SYNTHETIC:%s:%s\\n\' "$PWD" "$TERM_PROGRAM"\n',
      ).toString('base64'),
    }),
  })
  const outcome = terminalInputOutcomeSchema.parse(await input.json())
  assert.equal(input.status, 200)
  assert.equal(outcome.status, 'written')
  const resize = await fetch(`${terminal}/resize`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ cols: 93, rows: 31 }),
  })
  assert.equal(resize.status, 200)
  await new Promise((resolve) => setTimeout(resolve, 50))
  console.log(JSON.stringify({ events }))
  const encodedOutput = events
    .filter(
      (event): event is { type: 'data'; data: string } =>
        (event as { type: string }).type === 'data',
    )
    .map((event) => Buffer.from(event.data, 'base64').toString())
    .join('')
  assert.ok(encodedOutput.includes(`SYNTHETIC:${workspace}:Forge`))
  const one = await extra('session-terminal'),
    two = await extra('second-terminal'),
    three = await extra('second-terminal')
  assert.equal(manager.resourceState().terminals, 4)
  assert.equal(manager.list('session-terminal').terminals.length, 2)
  assert.equal(manager.list('second-terminal').terminals.length, 2)
  await one.send(
    "printf '\\033[31mA\\033[0m\\342\\202\\254\\377\\000'; printf '\\342'; sleep .03; printf '\\202\\254BYTE_END\\n'\n",
  )
  const bytes = Buffer.concat([
    Buffer.from('\u001b[31mA\u001b[0m€'),
    Buffer.from([255, 0]),
    Buffer.from('€BYTE_END\n'),
  ])
  await until(() => one.output().includes(bytes), 'exact raw terminal bytes')
  assert.equal(two.output().includes(bytes), false)
  assert.equal(three.output().includes(bytes), false)
  assert.equal(
    (
      await fetch(`${one.path}/resize`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ cols: 93, rows: 31 }),
      })
    ).status,
    200,
  )
  await one.send("stty size; printf 'SIZE_END\\n'\n")
  await until(
    () => one.output().includes(Buffer.from('31 93\n')),
    'actual PTY dimensions',
  )
  await one.send('sleep 20\n')
  let job: import('node-pty').MemberIdentity | undefined
  const foregroundDeadline = performance.now() + 3000
  while (!job && performance.now() < foregroundDeadline) {
    const foreground = await one.native.api.inspectOwnedV1(
      one.native.receipt.token,
      {
        maxEntries: 65536,
        maxBytes: 268435456,
        maxStatBytes: 4096,
        maxMembers: 256,
        deadlineMs: 1000,
      },
    )
    job = foreground.members.find(
      (member) => member.pid !== one.native.receipt.pty!.pid,
    )
    if (!job) await delay(10)
  }
  assert.ok(job)
  console.log(JSON.stringify({ originalForegroundJob: job }))
  await one.send('\u0003')
  await until(
    () => !existsSync(`/proc/${job.pid}`),
    'foreground job exit after Ctrl-C',
  )
  await one.send("printf 'INTERRUPTED_JOB\\n'\n")
  await until(
    () => one.output().includes(Buffer.from('INTERRUPTED_JOB')),
    'foreground Ctrl-C',
  )
  const last = one.events.reduce(
    (seq, event) => ('seq' in event ? Math.max(seq, event.seq) : seq),
    0,
  )
  const originalPid = one.native.receipt.pty!.pid
  const detached = once(one.ws, 'close')
  one.ws.close()
  await detached
  await one.send("printf 'DETACHED_SUFFIX\\n'\n")
  await delay(30)
  const replayed: TerminalEvent[] = []
  const replay = new WebSocket(
    `${one.path.replace(/^http/, 'ws')}/events?afterSeq=${last}`,
    { headers: { origin: base } },
  )
  extraSockets.push(replay)
  replay.on('message', (data) =>
    replayed.push(terminalEventSchema.parse(JSON.parse(String(data)))),
  )
  await once(replay, 'open')
  await one.send("printf 'LIVE_SUFFIX\\n'\n")
  await until(
    () =>
      replayed.some(
        (event) =>
          event.type === 'data' &&
          Buffer.from(event.data, 'base64').includes(
            Buffer.from('LIVE_SUFFIX'),
          ),
      ),
    'replay and live suffix',
  )
  const suffix = Buffer.concat(
    replayed.flatMap((event) =>
      event.type === 'data' ? [Buffer.from(event.data, 'base64')] : [],
    ),
  )
  assert.ok(
    suffix.indexOf('DETACHED_SUFFIX') >= 0 &&
      suffix.indexOf('LIVE_SUFFIX') > suffix.indexOf('DETACHED_SUFFIX'),
  )
  assert.equal(one.native.receipt.pty!.pid, originalPid)
  const sequences = replayed.flatMap((event) =>
    'seq' in event ? [event.seq] : [],
  )
  assert.deepEqual(
    sequences,
    Array.from({ length: sequences.length }, (_, index) => last + 1 + index),
  )
  await two.send("stty raw -echo; printf 'HELD_READER'; sleep 20\n")
  await until(
    () => two.output().includes(Buffer.from('HELD_READER')),
    'held reader',
  )
  const held = fetch(`${two.path}/input`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ data: Buffer.alloc(65536, 120).toString('base64') }),
  })
  await three.send("printf 'FAIR_OTHER\\n'\n")
  await until(
    () => three.output().includes(Buffer.from('FAIR_OTHER')),
    'other terminal during held write',
  )
  const heldResponse = await held,
    heldBody = await heldResponse.json()
  assert.equal(heldResponse.status, 409, JSON.stringify(heldBody))
  const partial = terminalInputOutcomeSchema.parse(heldBody.error.details.input)
  assert.equal(partial.status, 'timed_out')
  assert.equal(partial.requestedBytes, 65536)
  assert.ok(partial.writtenBytes > 0 && partial.writtenBytes < 65536)
  assert.equal(manager.resourceState().inputBytes, 0)
  console.log(
    JSON.stringify({
      physical: {
        fourTerminals: true,
        rawBytes: bytes.toString('base64'),
        actualResize: true,
        ctrlC: true,
        replaySequences: sequences,
        originalPid,
        partialInput: partial,
      },
    }),
  )
  const scan = await two.native.api.inspectOwnedV1(two.native.receipt.token, {
    maxEntries: 65536,
    maxBytes: 268435456,
    maxStatBytes: 4096,
    maxMembers: 256,
    deadlineMs: 1000,
  })
  console.log(JSON.stringify({ heldSessionMembers: scan }))
  assert.ok(scan.members.length >= 2)
  assert.equal(
    (await fetch(two.path, { method: 'DELETE', headers })).status,
    200,
  )
  assert.equal(
    manager.get(three.sessionId, three.descriptor.id).state,
    'running',
  )
  await three.send('sleep 20 & printf \'BACKGROUND:%s\\n\' "$!"; exit 0\n')
  await until(
    () =>
      manager.get(three.sessionId, three.descriptor.id).cleanup === 'complete',
    'natural exit background cleanup',
    manager.limits.cleanupDeadlineMs + 1000,
  )
  assert.equal(three.events.at(-1)?.type, 'exit')
  assert.equal(
    one.native.api.ownedStateV1(one.native.receipt.token).phase,
    'released',
  )
  console.log(
    JSON.stringify({
      physicalBackgroundCleanup: true,
      otherTerminalAlive: true,
      backgroundFinal: three.events.at(-1),
    }),
  )
  const closed = await fetch(terminal, { method: 'DELETE', headers })
  console.log(
    JSON.stringify({
      closed: closed.status,
      body: await closed.json(),
      resources: manager.resourceState(),
    }),
  )
  assert.equal(closed.status, 200)
} catch (error) {
  console.error(
    JSON.stringify({
      physicalFailure: {
        message: String(error),
        stack: (error as Error).stack,
      },
      resources: manager.resourceState(),
      states: natives.map((native) =>
        native.api.ownedStateV1(native.receipt.token),
      ),
    }),
  )
  process.exitCode = 1
} finally {
  for (const ws of extraSockets)
    if (ws.readyState !== WebSocket.CLOSED) {
      const closed = once(ws, 'close')
      ws.terminate()
      await closed
    }
  if (socket && socket.readyState !== WebSocket.CLOSED) {
    const closed = once(socket, 'close')
    socket.terminate()
    await closed
  }
  let shutdownFailure: Error | undefined
  for (let attempt = 0; attempt < 8; attempt++) {
    shutdownFailure = await new Promise<Error | undefined>((resolve) =>
      server.close(resolve),
    )
    if (!shutdownFailure) break
    console.error(
      JSON.stringify({
        shutdownRefusal: { attempt, message: shutdownFailure.message },
        resources: manager.resourceState(),
        states: natives.map((native) =>
          native.api.ownedStateV1(native.receipt.token),
        ),
      }),
    )
    await Promise.all(natives.map((native) => native.joinCleanup()))
  }
  if (shutdownFailure) {
    console.error(
      'Original cleanup owners remain retained. This probe cannot admit another batch.',
    )
    await new Promise(() => {})
  }
  for (const native of natives) {
    const state = native.api.ownedStateV1(native.receipt.token)
    console.log(
      JSON.stringify({
        cleanup: state,
        pidAbsent: !existsSync(`/proc/${native.receipt.pty?.pid}`),
        resources: manager.resourceState(),
      }),
    )
    assert.equal(state.phase, 'reaped')
  }
  for (const receipt of originals) {
    const state = nativeApi.ownedStateV1(receipt.token)
    assert.equal(state.phase, 'reaped')
    assert.equal(state.waitWorkerSettled, true)
    assert.equal(state.pendingOperations, 0)
    assert.equal(state.socketClosed, true)
    assert.equal(state.leaderPidfdOpen, false)
    assert.equal(state.openControlEndpoints, 0)
    assert.equal(existsSync(`/proc/${receipt.pid}`), false)
    console.log(
      JSON.stringify({
        originalCleanup: { pid: receipt.pid, state, pidAbsent: true },
      }),
    )
  }
  assert.deepEqual(manager.resourceState(), {
    terminals: 0,
    startups: 0,
    removals: 0,
    subscriptions: 0,
    subscriptionBytes: 0,
    inputBytes: 0,
  })
  assert.deepEqual(upgrades.resourceState(), {
    openings: 0,
    sessionSockets: 0,
    terminalSockets: 0,
  })
  db.close()
}
