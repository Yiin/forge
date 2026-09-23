import { DatabaseSync } from 'node:sqlite'
import { createNodeWebSocket } from '@hono/node-ws'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { appendMessage, createProject, createSession } from './db/queries.js'
import { migrate } from './db/migrate.js'
import { EventBus } from './events/bus.js'
import { websocketRoute } from './ws.js'

const servers: Array<{ close(): void }> = []
const databases: DatabaseSync[] = []

afterEach(() => {
  for (const server of servers.splice(0)) server.close()
  for (const db of databases.splice(0)) db.close()
})

function fixture() {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  migrate(db)
  const project = createProject(db, { name: 'Forge', path: '/tmp/forge' })
  const session = createSession(db, {
    projectId: project.id,
    harness: 'default',
    title: 'Chat',
    cwd: '/tmp',
  })
  const bus = new EventBus()
  const app = new Hono()
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })
  app.get('/ws', websocketRoute(upgradeWebSocket, db, bus))
  const server = serve({ fetch: app.fetch, port: 0 })
  injectWebSocket(server)
  servers.push(server)
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('server did not bind')
  return { db, bus, session, port: address.port }
}

function append(db: DatabaseSync, bus: EventBus, sessionId: string, n: number) {
  return appendMessage(db, {
    sessionId,
    turnId: `turn-${n}`,
    itemId: `item-${n}`,
    role: 'agent',
    type: 'text_delta',
    content: { type: 'text_delta', text: String(n) },
    eventBus: bus,
  })
}

function appendMany(
  db: DatabaseSync,
  bus: EventBus,
  sessionId: string,
  start: number,
  count: number,
) {
  for (let n = start; n < start + count; n++) append(db, bus, sessionId, n)
}

function receive(
  socket: WebSocket,
  count: number,
): Promise<Array<{ seq: number }>> {
  return new Promise((resolve, reject) => {
    const events: Array<{ seq: number }> = []
    socket.addEventListener('message', (event) => {
      events.push(JSON.parse(String(event.data)) as { seq: number })
      if (events.length === count) resolve(events)
    })
    socket.addEventListener('error', () => reject(new Error('websocket error')))
  })
}

// Every named subscription opens with a sessionStatus frame. Most tests count
// only the frames that follow it, so they leave `withStatus` off.
function receiveWithTimeout(
  socket: WebSocket,
  count: number,
  timeoutMs = 5_000,
  withStatus = false,
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const events: Array<Record<string, unknown>> = []
    const timeout = setTimeout(
      () => reject(new Error(`received ${events.length}/${count} events`)),
      timeoutMs,
    )
    socket.addEventListener('message', (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>
      if (!withStatus && frame.type === 'sessionStatus') return
      events.push(frame)
      if (events.length === count) {
        clearTimeout(timeout)
        resolve(events.slice())
      }
    })
    socket.addEventListener('error', () => {
      clearTimeout(timeout)
      reject(new Error('websocket error'))
    })
  })
}

function openSocket(port: number) {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    socket.addEventListener('open', () => resolve(socket))
    socket.addEventListener('error', () => reject(new Error('websocket error')))
  })
}

describe('event websocket', () => {
  it('replays persisted rows in global sequence order', async () => {
    const { db, bus, session, port } = fixture()
    for (let n = 1; n <= 50; n++) append(db, bus, session.id, n)
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const events = receive(socket, 50)
    await new Promise<void>((resolve) =>
      socket.addEventListener('open', () => {
        socket.send(
          JSON.stringify({ type: 'subscribe', sessions: 'all', cursor: 0 }),
        )
        resolve()
      }),
    )
    expect((await events).map((event) => event.seq)).toEqual(
      Array.from({ length: 50 }, (_, index) => index + 1),
    )
    socket.close()
  })

  it('skips persisted rows that fail the message schema', async () => {
    const { db, bus, session, port } = fixture()
    append(db, bus, session.id, 1)
    db.prepare(
      `INSERT INTO messages
        (session_id, turn_id, item_id, role, type, content, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      session.id,
      'turn-bad',
      'item-bad',
      'user',
      'attachment_ref',
      JSON.stringify({ attachmentId: 'legacy', relPath: 'legacy.txt' }),
      Date.now(),
    )
    append(db, bus, session.id, 3)

    const socket = await openSocket(port)
    const events = receiveWithTimeout(socket, 2)
    socket.send(
      JSON.stringify({ type: 'subscribe', sessions: [session.id], cursor: 0 }),
    )

    expect((await events).map((event) => event.seq)).toEqual([1, 3])
    socket.close()
  })

  it('routes context window frames only to subscribed sessions', async () => {
    const { bus, session, port } = fixture()
    const other = `${session.id}-other`
    const subscribed = await openSocket(port)
    const unsubscribed = await openSocket(port)
    const received = receiveWithTimeout(subscribed, 1)
    const notReceived = receiveWithTimeout(unsubscribed, 1, 50).then(
      () => true,
      () => false,
    )
    subscribed.send(
      JSON.stringify({ type: 'subscribe', sessions: [session.id], cursor: 0 }),
    )
    unsubscribed.send(
      JSON.stringify({ type: 'subscribe', sessions: [other], cursor: 0 }),
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    bus.publishEphemeral({
      type: 'contextWindow',
      seq: null,
      sessionId: session.id,
      usage: { usedTokens: 1, source: 'test', observedAt: Date.now() },
    })
    expect((await received)[0].sessionId).toBe(session.id)
    expect(await notReceived).toBe(false)
    subscribed.close()
    unsubscribed.close()
  })

  it('sends the current status of each named session on subscribe', async () => {
    const { db, bus, session, port } = fixture()
    // The status changed before this client subscribed, so its ephemeral
    // frame went to nobody. A client that read `running` over HTTP must still
    // learn that the turn ended.
    db.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(
      session.id,
    )
    db.prepare("UPDATE sessions SET status = 'idle' WHERE id = ?").run(
      session.id,
    )
    append(db, bus, session.id, 1)
    const socket = await openSocket(port)
    const events = receiveWithTimeout(socket, 2, 5_000, true)
    socket.send(
      JSON.stringify({
        type: 'subscribe',
        sessions: [session.id, 'ses_missing'],
        cursor: 0,
      }),
    )
    expect(await events).toEqual([
      {
        type: 'sessionStatus',
        seq: null,
        sessionId: session.id,
        status: 'idle',
      },
      expect.objectContaining({ seq: 1, sessionId: session.id }),
    ])
    socket.close()
  })

  it('replays a stale cursor in bounded batches without gaps or duplicates', async () => {
    const { db, bus, session, port } = fixture()
    const count = 2_000
    appendMany(db, bus, session.id, 1, count)
    const socket = await openSocket(port)
    const started = performance.now()
    const events = receiveWithTimeout(socket, count)
    socket.send(
      JSON.stringify({ type: 'subscribe', sessions: [session.id], cursor: 0 }),
    )
    const received = await events
    const elapsedMs = performance.now() - started
    const seqs = received.map((event) => event.seq)
    expect(seqs).toEqual(Array.from({ length: count }, (_, index) => index + 1))
    console.info(
      `stale cursor replay: ${count} rows in ${elapsedMs.toFixed(1)}ms`,
    )
    socket.close()
  })

  it('recovers exactly after a socket is closed mid-replay', async () => {
    const { db, bus, session, port } = fixture()
    const count = 1_000
    appendMany(db, bus, session.id, 1, count)
    const first = await openSocket(port)
    const firstEvents = receiveWithTimeout(first, 100)
    first.send(
      JSON.stringify({ type: 'subscribe', sessions: [session.id], cursor: 0 }),
    )
    const firstBatch = await firstEvents
    first.close()
    const second = await openSocket(port)
    const remaining = receiveWithTimeout(second, count - 100)
    second.send(
      JSON.stringify({
        type: 'subscribe',
        sessions: [session.id],
        cursor: 100,
      }),
    )
    const secondBatch = await remaining
    expect([...firstBatch, ...secondBatch].map((event) => event.seq)).toEqual(
      Array.from({ length: count }, (_, index) => index + 1),
    )
    second.close()
  })

  it('streams a chatty delta storm and replaces subscriptions cleanly', async () => {
    const { db, bus, session, port } = fixture()
    const project = createProject(db, { name: 'Other', path: '/tmp/other' })
    const other = createSession(db, {
      projectId: project.id,
      harness: 'default',
      title: 'Other chat',
      cwd: '/tmp',
    })
    const socket = await openSocket(port)
    const storm = receiveWithTimeout(socket, 500)
    socket.send(
      JSON.stringify({ type: 'subscribe', sessions: 'all', cursor: 0 }),
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    // Chunk the burst with yields: a fully synchronous 500-write burst
    // overflows the writer's 256-event queue and it closes the socket by
    // design. A real storm arrives over many ticks.
    for (let base = 0; base < 250; base += 25) {
      appendMany(db, bus, session.id, 1 + base, 25)
      appendMany(db, bus, other.id, 251 + base, 25)
      await new Promise((resolve) => setImmediate(resolve))
    }
    const stormEvents = await storm
    expect(new Set(stormEvents.map((event) => event.seq)).size).toBe(500)
    console.info('delta storm: 500 rows, no duplicates')

    const replaced = receiveWithTimeout(socket, 1)
    socket.send(
      JSON.stringify({ type: 'subscribe', sessions: [other.id], cursor: 500 }),
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    append(db, bus, session.id, 501)
    append(db, bus, other.id, 502)
    const [event] = await replaced
    expect(event.sessionId).toBe(other.id)
    expect(event.seq).toBe(502)
    socket.close()
  })
})
