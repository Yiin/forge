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
})
