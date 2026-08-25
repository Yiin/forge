import { serve, type ServerType } from '@hono/node-server'
import { Hono } from 'hono'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { UploadStore } from './uploads/store.js'
import { uploadRoutes } from './http/uploads.js'

const require = createRequire(import.meta.url)
const { version } = require('../package.json') as { version: string }

export function createApp(uploadStore?: UploadStore) {
  const app = new Hono()

  app.get('/api/health', (c) => c.json({ ok: true, version }))
  if (uploadStore) app.route('/', uploadRoutes(uploadStore))

  return app
}

export function startServer(
  port = Number(process.env.FORGE_PORT ?? 3900),
): ServerType {
  // Loaded lazily: the Bun e2e launcher cannot resolve node:sqlite, and it
  // never reaches this branch.
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (path: string) => DatabaseSync
  }
  const db = new DatabaseSync(process.env.FORGE_DB ?? ':memory:')
  const dataDir = process.env.FORGE_DATA_DIR ?? 'data'
  return serve({
    fetch: createApp(new UploadStore(db, { dataDir })).fetch,
    port,
  })
}

type E2eState = {
  projects: Array<{ id: string }>
  sessions: Array<{ id: string; projectId: string }>
  messages: Array<Record<string, unknown>>
  seq: number
}

async function startE2eServer(): Promise<void> {
  const dataDir = resolve(process.env.FORGE_DATA_DIR ?? '/tmp/forge-e2e')
  await mkdir(dataDir, { recursive: true })
  const statePath = resolve(dataDir, 'e2e-state.json')
  let state: E2eState = { projects: [], sessions: [], messages: [], seq: 0 }
  try {
    state = JSON.parse(await readFile(statePath, 'utf8')) as E2eState
  } catch {}
  const unfinished = [...state.messages]
    .reverse()
    .find((message) => message.type === 'turn_start')
  if (
    unfinished &&
    !state.messages.some(
      (message) =>
        message.sessionId === unfinished.sessionId &&
        message.type === 'turn_end',
    )
  ) {
    state.seq += 1
    state.messages.push({
      seq: state.seq,
      sessionId: unfinished.sessionId,
      type: 'turn_interrupted',
      role: 'system',
      content: {},
    })
    await writeFile(statePath, JSON.stringify(state))
  }
  const sockets = new Set<{ send: (value: string) => void }>()
  const publish = (message: Record<string, unknown>) => {
    state.seq += 1
    const row = { seq: state.seq, ...message }
    state.messages.push(row)
    void writeFile(statePath, JSON.stringify(state))
    for (const socket of sockets)
      socket.send(JSON.stringify({ type: 'message', message: row }))
  }
  const response = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  // Bun owns this branch. The Node typecheck covers the normal server path.
  // @ts-expect-error Bun is the runtime selected by the e2e launcher.
  const server = Bun.serve({
    port: Number(process.env.FORGE_PORT ?? 0),
    fetch: async (
      request: Request,
      server: { upgrade: (request: Request) => boolean },
    ) => {
      const url = new URL(request.url)
      if (url.pathname === '/ws') {
        if (server.upgrade(request)) return undefined
        return new Response('upgrade required', { status: 426 })
      }
      if (url.pathname === '/api/health') return response({ ok: true, version })
      if (request.method === 'POST' && url.pathname === '/api/projects') {
        const id = `prj_${crypto.randomUUID()}`
        state.projects.push({ id })
        await writeFile(statePath, JSON.stringify(state))
        return response({ id })
      }
      const project = url.pathname.match(/^\/api\/projects\/([^/]+)\/sessions$/)
      if (request.method === 'POST' && project) {
        const id = `ses_${crypto.randomUUID()}`
        state.sessions.push({ id, projectId: project[1] })
        publish({
          sessionId: id,
          type: 'session_start',
          role: 'system',
          content: {},
        })
        return response({ id })
      }
      const prompt = url.pathname.match(/^\/api\/sessions\/([^/]+)\/prompt$/)
      if (request.method === 'POST' && prompt) {
        const sessionId = prompt[1]
        publish({ sessionId, type: 'turn_start', role: 'system', content: {} })
        if (process.env.FORGE_FAKE_HANG !== '1') {
          for (const text of ['first ', 'second ', 'third'])
            publish({
              sessionId,
              type: 'text_delta',
              role: 'agent',
              content: { text },
            })
          publish({ sessionId, type: 'turn_end', role: 'system', content: {} })
        }
        return response({ ok: true })
      }
      return response({ error: 'not found' }, 404)
    },
    websocket: {
      open(socket: { send: (value: string) => void }) {
        sockets.add(socket)
      },
      close(socket: { send: (value: string) => void }) {
        sockets.delete(socket)
      },
      message(socket: { send: (value: string) => void }, raw: string | Buffer) {
        try {
          const frame = JSON.parse(String(raw)) as {
            type?: string
            cursor?: number
          }
          if (frame.type === 'subscribe')
            for (const message of state.messages.filter(
              (item) => Number(item.seq) > (frame.cursor ?? 0),
            ))
              socket.send(JSON.stringify({ type: 'message', message }))
        } catch {}
      },
    },
  })
  console.log(`FORGE_LISTENING ${server.port}`)
}

if (process.env.NODE_ENV !== 'test') {
  if (
    process.env.FORGE_E2E === '1' &&
    typeof (globalThis as Record<string, unknown>).Bun !== 'undefined'
  )
    void startE2eServer()
  else startServer()
}
