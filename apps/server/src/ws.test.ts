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

function receiveWithTimeout(
  socket: WebSocket,
  count: number,
  timeoutMs = 5_000,
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const events: Array<Record<string, unknown>> = []
    const timeout = setTimeout(
      () => reject(new Error(`received ${events.length}/${count} events`)),
      timeoutMs,
    )
    socket.addEventListener('message', (event) => {
      events.push(JSON.parse(String(event.data)) as Record<string, unknown>)
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
    appendMany(db, bus, session.id, 1, 250)
    appendMany(db, bus, other.id, 251, 250)
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
