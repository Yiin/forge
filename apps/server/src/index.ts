import { serve, type ServerType } from '@hono/node-server'
import { Hono } from 'hono'
import { createRequire } from 'node:module'
import { createNodeWebSocket } from '@hono/node-ws'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { UploadStore } from './uploads/store.js'
import { uploadRoutes } from './http/uploads.js'
import { attachmentRoutes } from './http/attachments.js'
import { projectFileRoutes } from './http/projectFiles.js'
import { statusRoutes } from './http/status.js'
import { migrate } from './db/migrate.js'
import { EventBus } from './events/bus.js'
import { searchRoutes } from './http/search.js'
import { questionRoutes } from './http/questions.js'
import type { QuestionManager } from './acp/questions.js'
import { QuestionManager as ServerQuestionManager } from './acp/questions.js'
import { websocketRoute } from './ws.js'
import { projectRoutes } from './http/projects.js'
import { sessionRoutes } from './http/sessions.js'
import { SessionManager } from './sessions/manager.js'
import type { HarnessFactory } from './sessions/harness.js'
import { workspaceRoutes } from './http/workspace.js'
import { epicRoutes } from './http/epics.js'
import type { EpicRunner } from './epics/runner.js'
import { recoverSessions } from './sessions/recovery.js'

const require = createRequire(import.meta.url)
const { version } = require('../package.json') as { version: string }

export function createApp(
  uploadStore?: UploadStore,
  status?: Parameters<typeof statusRoutes>[0],
  questions?: QuestionManager,
  manager?: SessionManager,
  runner?: EpicRunner,
) {
  const app = new Hono()

  if (status) app.route('/', statusRoutes(status))
  else app.get('/api/health', (c) => c.json({ ok: true, version }))
  if (uploadStore) {
    app.route('/', projectRoutes(uploadStore.database))
    if (manager) app.route('/', sessionRoutes(manager))
    app.route('/', uploadRoutes(uploadStore))
    app.route('/', attachmentRoutes(uploadStore))
    app.route('/', projectFileRoutes(uploadStore.database))
    app.route('/', searchRoutes(uploadStore.database))
  }
  if (questions) app.route('/', questionRoutes(questions))
  if (status) app.route('/', workspaceRoutes(status.db))
  if (runner && status)
    app.route(
      '/',
      epicRoutes({
        runner,
        projectPath: (projectId) =>
          (
            status.db
              .prepare('SELECT path FROM projects WHERE id = ?')
              .get(projectId) as { path?: string } | undefined
          )?.path,
        db: status.db,
      }),
    )

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
  migrate(db)
  const dataDir = process.env.FORGE_DATA_DIR ?? 'data'
  const bus = new EventBus()
  const uploadStore = new UploadStore(db, { dataDir, bus })
  const questions = new ServerQuestionManager({ db, bus })
  const factory: HarnessFactory = () => ({
    spawn: async (_session, _onItem, onExit) => ({
      prompt: async () => {
        onExit(new Error('No harness adapter configured'))
      },
      cancel: () => undefined,
      kill: () => undefined,
    }),
  })
  const manager = new SessionManager(db, bus, factory)
  // Settle persisted turns before exposing the port. Respawn work continues
  // from the settled state without delaying health checks.
  void recoverSessions(db, manager, bus)
  const app = createApp(
    uploadStore,
    {
      db,
      bus,
      version: process.env.FORGE_VERSION ?? version,
      dataDir,
    },
    questions,
    manager,
  )
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })
  app.get('/ws', websocketRoute(upgradeWebSocket, db, bus))
  const server = serve({ fetch: app.fetch, port })
  injectWebSocket(server)
  return server
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
      if (request.method === 'POST' && url.pathname === '/api/sessions') {
        const body = (await request.json()) as { projectId?: string }
        const id = `ses_${crypto.randomUUID()}`
        state.sessions.push({ id, projectId: body.projectId ?? '' })
        publish({
          sessionId: id,
          type: 'session_start',
          role: 'system',
          content: {},
        })
        return response({ id })
      }
      const prompt = url.pathname.match(/^\/api\/sessions\/([^/]+)\/prompt$/)
      const messages = url.pathname.match(
        /^\/api\/sessions\/([^/]+)\/messages$/,
      )
      if (request.method === 'GET' && messages)
        return response(
          state.messages.filter((message) => message.sessionId === messages[1]),
        )
      if (request.method === 'POST' && prompt) {
        const sessionId = prompt[1]
        publish({ sessionId, type: 'turn_start', role: 'system', content: {} })
        if (process.env.FORGE_FAKE_HANG !== '1') {
          for (const text of ['first ', 'second ', 'third']) {
            const delay = Number(process.env.FORGE_FAKE_DELAY_MS ?? 0)
            if (delay)
              await new Promise((resolveDelay) =>
                setTimeout(resolveDelay, delay),
              )
            publish({
              sessionId,
              type: 'text_delta',
              role: 'agent',
              content: { text },
            })
          }
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
