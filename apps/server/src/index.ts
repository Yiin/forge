import { serve, type ServerType } from '@hono/node-server'
import { Hono } from 'hono'
import { createRequire } from 'node:module'
import { createNodeWebSocket } from '@hono/node-ws'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { DatabaseSync } from 'node:sqlite'
import { UploadStore } from './uploads/store.js'
import { uploadRoutes } from './http/uploads.js'
import { attachmentRoutes } from './http/attachments.js'
import { fsBrowseRoutes } from './http/fsBrowse.js'
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
import { forkRoutes } from './http/forks.js'
import { sideChatRoutes } from './http/sidechats.js'
import { SessionManager } from './sessions/manager.js'
import type { HarnessFactory } from './sessions/harness.js'
import { workspaceRoutes } from './http/workspace.js'
import { epicRoutes } from './http/epics.js'
import {
  EpicRunner,
  type EpicSessionInput,
  type WorkerSession,
} from './epics/runner.js'
import { recoverSessions } from './sessions/recovery.js'
import { harnessRoutes } from './http/harnesses.js'
import {
  harnessHealthRoutes,
  createHarnessHealthReader,
} from './http/harnessHealth.js'
import { harnessAccountRoutes } from './http/harnessAccounts.js'
import { serverConfigRoutes } from './http/config.js'
import {
  defaultConfig,
  loadConfigSync,
  reconcileConfig,
  saveConfigSync,
  type ConfigState,
} from './config.js'
import { ptyHarness } from './pty/harness.js'
import { acpHarness } from './acp/harness.js'
import {
  HarnessAccountStore,
  accountKindForHarness,
  deriveAccountHarness,
} from './accounts/store.js'
import { clearExpiredLimits } from './accounts/limits.js'
import { LoginManager } from './accounts/login.js'
import { unsupportedUsageProbe, UsagePoller } from './accounts/usagePoller.js'
import { codexUsageProbe } from './accounts/probes/codex.js'
import { claudeUsageProbe } from './accounts/probes/claude.js'

const require = createRequire(import.meta.url)
const { version } = require('../package.json') as { version: string }

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

function productionWebDir() {
  return resolve(
    process.env.FORGE_WEB_DIR ??
      resolve(dirname(fileURLToPath(import.meta.url)), '../../../web'),
  )
}

function webAssets(webDir: string) {
  const root = resolve(webDir)
  return async (request: Request) => {
    const url = new URL(request.url)
    const pathname = decodeURIComponent(url.pathname)
    const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1)
    const candidate = resolve(root, relativePath)
    if (candidate !== root && !candidate.startsWith(`${root}/`))
      return new Response('not found', { status: 404 })

    try {
      const info = await stat(candidate)
      if (!info.isFile()) throw new Error('not a file')
      return new Response(await readFile(candidate), {
        headers: {
          'content-type':
            contentTypes[extname(candidate)] ?? 'application/octet-stream',
        },
      })
    } catch {
      if (pathname.startsWith('/assets/'))
        return new Response('asset not found', { status: 404 })
      try {
        return new Response(await readFile(resolve(root, 'index.html')), {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      } catch {
        return new Response('web assets are not installed', { status: 503 })
      }
    }
  }
}

export function createApp(
  uploadStore?: UploadStore,
  status?: Parameters<typeof statusRoutes>[0],
  questions?: QuestionManager,
  manager?: SessionManager,
  runner?: EpicRunner,
  webDir?: string,
  configState?: ConfigState,
  loginManager?: LoginManager,
  usagePoller?: UsagePoller,
) {
  const app = new Hono()

  if (status) app.route('/', statusRoutes(status))
  else app.get('/api/health', (c) => c.json({ ok: true, version }))
  if (uploadStore) {
    app.route('/', projectRoutes(uploadStore.database, uploadStore))
    if (manager) {
      app.route('/', sessionRoutes(manager, uploadStore))
      app.route('/', forkRoutes(manager))
      app.route('/', sideChatRoutes(manager))
    }
    app.route('/', uploadRoutes(uploadStore))
    app.route('/', attachmentRoutes(uploadStore))
    app.route('/', projectFileRoutes(uploadStore.database))
    app.route('/', fsBrowseRoutes())
    app.route('/', searchRoutes(uploadStore.database))
    app.route('/', harnessRoutes({ configState, db: uploadStore.database }))
    if (manager && configState)
      app.route(
        '/',
        harnessHealthRoutes({
          db: uploadStore.database,
          configState,
          manager,
        }),
      )
    app.route(
      '/',
      harnessAccountRoutes(uploadStore.database, {
        bus: status?.bus,
        configState,
        loginManager,
        usagePoller,
      }),
    )
    app.route('/', serverConfigRoutes())
  }
  if (questions) app.route('/', questionRoutes(questions))
  if (status) app.route('/', workspaceRoutes(status.db, uploadStore))
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
  if (webDir) {
    const assets = webAssets(webDir)
    app.get('*', async (c, next) => {
      if (
        c.req.path === '/api' ||
        c.req.path.startsWith('/api/') ||
        c.req.path === '/ws'
      )
        return next()
      return assets(c.req.raw)
    })
  }

  return app
}

export function createEpicSessionAdapter(manager: SessionManager) {
  return {
    async create(input: EpicSessionInput) {
      const session = manager.create(input)
      const worker: WorkerSession = {
        id: session.id,
        prompt: (text) => manager.prompt(session.id, text),
        cancel: async () => {
          await manager.interrupt(session.id)
          await manager.discard(session.id)
        },
      }
      return worker
    },
  }
}

export function startServer(
  port = Number(process.env.FORGE_PORT ?? 3900),
): ServerType {
  // Loaded lazily: the Bun e2e launcher cannot resolve node:sqlite, and it
  // never reaches this branch.
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (path: string) => DatabaseSync
  }
  const dataDir = resolve(process.env.FORGE_DATA_DIR ?? 'data')
  mkdirSync(dataDir, { recursive: true })
  const db = new DatabaseSync(process.env.FORGE_DB ?? join(dataDir, 'forge.db'))
  migrate(db)
  clearExpiredLimits(db, Date.now())
  const bus = new EventBus()
  const uploadStore = new UploadStore(db, { dataDir, bus })
  const questions = new ServerQuestionManager({ db, bus })
  const configPath = resolve(
    process.env.FORGE_CONFIG ?? resolve(homedir(), '.forge/forge.toml'),
  )
  let config: ReturnType<typeof defaultConfig>
  try {
    const loaded = loadConfigSync(configPath)
    config = reconcileConfig(loaded, defaultConfig())
    if (JSON.stringify(loaded.harness) !== JSON.stringify(config.harness))
      saveConfigSync(configPath, config)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      config = defaultConfig()
      saveConfigSync(configPath, config)
    } else {
      console.error(error instanceof Error ? error.message : String(error))
      config = defaultConfig()
    }
  }
  const configState: ConfigState = { current: config, path: configPath }
  const accountStore = new HarnessAccountStore(db)
  const factory: HarnessFactory = (key, accountId) => {
    const entry = configState.current.harness[key]
    if (!entry) throw new Error(`Harness ${key} is not configured`)
    const account = accountId ? accountStore.get(accountId) : undefined
    if (account && account.harnessKey !== key)
      throw new Error('Account does not belong to harness')
    const derived = account ? deriveAccountHarness(entry, account) : entry
    if (derived?.protocol === 'pty') return ptyHarness(derived)
    if (derived?.protocol === 'acp')
      return acpHarness(derived, { db, bus, questions, accountId })
    throw new Error(`Harness ${key} is not configured`)
  }
  const manager = new SessionManager(
    db,
    bus,
    factory,
    undefined,
    (harness) =>
      accountKindForHarness(harness, configState.current.harness[harness]) !==
      null,
  )
  const runner = new EpicRunner(
    db,
    createEpicSessionAdapter(manager),
    bus,
    (harness) =>
      accountKindForHarness(harness, configState.current.harness[harness]) !==
      null,
  )
  const loginManager = new LoginManager(
    accountStore,
    bus,
    (key) => configState.current.harness[key],
  )
  const usagePoller = new UsagePoller({
    db,
    probes: new Map([
      ['claude', claudeUsageProbe],
      ['codex', codexUsageProbe],
      ['kimi', unsupportedUsageProbe],
      ['opencode', unsupportedUsageProbe],
      ['grok', unsupportedUsageProbe],
      ['pi', unsupportedUsageProbe],
    ]),
  })
  const harnessHealth = createHarnessHealthReader({ db, configState, manager })
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
      harnesses: () =>
        harnessHealth().map(({ key, protocol, liveProcesses }) => ({
          key,
          protocol,
          liveProcesses,
        })),
    },
    questions,
    manager,
    runner,
    productionWebDir(),
    configState,
    loginManager,
    usagePoller,
  )
  usagePoller.start()
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })
  app.get('/ws', websocketRoute(upgradeWebSocket, db, bus))
  const server = serve({ fetch: app.fetch, port })
  injectWebSocket(server)
  server.on('close', () => {
    loginManager.close()
    usagePoller.stop()
  })
  return server
}

type E2eState = {
  projects: Array<{ id: string }>
  sessions: Array<{ id: string; projectId: string }>
  messages: Array<Record<string, unknown>>
  seq: number
}

type E2eQuestion = {
  questionId: string
  question: {
    header: string
    question: string
    options: Array<{ label: string; description?: string }>
    multiSelect?: boolean
  }
}

// Scroll checks need a reply that overflows the viewport, so the repeat count
// is a knob. One repeat keeps the default reply short.
function e2eReplyChunks(): string[] {
  const repeat = Math.max(1, Number(process.env.FORGE_E2E_REPLY_REPEAT ?? 1))
  return Array.from({ length: repeat }, (_value, index) => [
    index === 0 ? 'first ' : ' first ',
    'second ',
    'third',
  ]).flat()
}

function e2eQuestions(): E2eQuestion[] {
  if (process.env.FORGE_MOCK_ASK_QUESTION !== '1') return []
  const mode = process.env.FORGE_MOCK_ASK_QUESTION_MODE ?? 'single'
  const multiSelect = mode === 'multi'
  const questions: E2eQuestion['question'][] = multiSelect
    ? [
        {
          header: 'Toppings',
          question: 'Choose your toppings',
          options: [
            { label: 'Cheese', description: 'A classic choice' },
            { label: 'Mushrooms', description: 'A savoury choice' },
          ],
          multiSelect: true,
        },
      ]
    : [
        {
          header: 'Choice',
          question: 'Pick one',
          options: [
            { label: 'First', description: 'The first option' },
            { label: 'Second', description: 'The second option' },
          ],
        },
      ]
  if (mode === 'queued')
    questions.push({
      header: 'Second choice',
      question: 'Pick another one',
      options: [{ label: 'Third' }, { label: 'Fourth' }],
    })
  return questions.map((question) => ({
    questionId: `question-${crypto.randomUUID()}`,
    question,
  }))
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
      if (request.method === 'GET' && url.pathname === '/api/projects') {
        return response(
          state.projects.map((project) => ({
            ...project,
            name: 'E2E project',
            path: '/tmp/e2e-project',
            createdAt: 1,
          })),
        )
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
      const promote = url.pathname.match(/^\/api\/drafts\/([^/]+)\/promote$/)
      const sessionRow = url.pathname.match(/^\/api\/sessions\/([^/]+)$/)
      const shapeSession = (session: E2eState['sessions'][number]) => ({
        ...session,
        title: 'New session',
        harness: 'fake-acp-agent',
        status: 'idle',
        createdAt: new Date().toISOString(),
      })
      if (request.method === 'GET' && url.pathname === '/api/sessions') {
        const projectId = url.searchParams.get('projectId')
        return response(
          state.sessions
            .filter((session) => !projectId || session.projectId === projectId)
            .map(shapeSession),
        )
      }
      if (request.method === 'GET' && sessionRow) {
        const session = state.sessions.find(
          (entry) => entry.id === sessionRow[1],
        )
        return session
          ? response(shapeSession(session))
          : response({ error: 'Session not found' }, 404)
      }
      const answer = url.pathname.match(
        /^\/api\/sessions\/([^/]+)\/questions\/([^/]+)\/answer$/,
      )
      const messages = url.pathname.match(
        /^\/api\/sessions\/([^/]+)\/messages$/,
      )
      if (request.method === 'GET' && messages)
        return response(
          state.messages.filter((message) => message.sessionId === messages[1]),
        )
      if (request.method === 'POST' && promote) {
        const body = (await request.json()) as {
          projectId?: string
          text?: string
          clientItemId?: string
        }
        const id = `ses_${crypto.randomUUID()}`
        state.sessions.push({ id, projectId: body.projectId ?? '' })
        await writeFile(statePath, JSON.stringify(state))
        if (body.text)
          publish({
            sessionId: id,
            itemId: body.clientItemId ?? `item_${crypto.randomUUID()}`,
            type: 'text_delta',
            role: 'user',
            content: { text: body.text },
          })
        publish({
          sessionId: id,
          type: 'turn_start',
          role: 'system',
          content: {},
        })
        for (const text of e2eReplyChunks())
          publish({
            sessionId: id,
            type: 'text_delta',
            role: 'agent',
            content: { text },
          })
        publish({
          sessionId: id,
          type: 'turn_end',
          role: 'system',
          content: {},
        })
        return response({ sessionId: id })
      }
      if (request.method === 'POST' && prompt) {
        const sessionId = prompt[1]
        const body = (await request.json()) as {
          text?: string
          clientItemId?: string
        }
        if (body.text)
          publish({
            sessionId,
            itemId: body.clientItemId ?? `item_${crypto.randomUUID()}`,
            type: 'text_delta',
            role: 'user',
            content: { text: body.text },
          })
        publish({ sessionId, type: 'turn_start', role: 'system', content: {} })
        for (const question of e2eQuestions())
          publish({
            sessionId,
            type: 'ask_user_question',
            role: 'agent',
            turnId: `turn-${state.seq}`,
            itemId: question.questionId,
            content: {
              type: 'ask_user_question',
              questionId: question.questionId,
              questions: [question.question],
            },
          })
        if (process.env.FORGE_MOCK_HANG_PROMPT !== '1') {
          for (const text of e2eReplyChunks()) {
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
      if (request.method === 'POST' && answer) {
        const body = (await request.json()) as {
          questionId?: string
          answer?: string
          answers?: unknown
        }
        if (!body.questionId || body.questionId !== answer[2])
          return response({ error: 'invalid question' }, 400)
        publish({
          sessionId: answer[1],
          type: 'user_answer',
          role: 'user',
          content: {
            type: 'user_answer',
            questionId: body.questionId,
            ...(body.answers !== undefined
              ? { answers: body.answers }
              : { answer: body.answer }),
          },
        })
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
