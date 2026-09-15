import { serve, type ServerType } from '@hono/node-server'
import { Hono } from 'hono'
import { createRequire } from 'node:module'
import type { Server } from 'node:http'
import { WebSocketUpgrades } from './ws-upgrade.js'
import { TerminalManager } from './terminals/manager.js'
import { TerminalAuthority } from './terminals/origin.js'
import { TerminalError } from './terminals/error.js'
import { TerminalRequests, terminalRoutes } from './http/terminals.js'
import { ServerShutdown } from './shutdown.js'
import { readFile, stat } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { DatabaseSync } from 'node:sqlite'
import { UploadStore } from './uploads/store.js'
import { uploadRoutes } from './http/uploads.js'
import { attachmentRoutes } from './http/attachments.js'
import { fsBrowseRoutes } from './http/fsBrowse.js'
import { WorkspaceFiles } from './workspace/files.js'
import { workspaceFileRoutes } from './http/workspaceFiles.js'
import { projectFileRoutes } from './http/projectFiles.js'
import { skillRoutes } from './http/skills.js'
import { gitRoutes } from './http/git.js'
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
import {
  recoverSessions,
  type PreviousServerBoot,
} from './sessions/recovery.js'
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
import { createNativeAttachmentLoader } from './uploads/native.js'
import { nativeHarness } from './sessions/native.js'
import { NativeInteractions } from './sessions/native-interactions.js'
import { discoverNativeModels } from './sessions/native-models.js'
import { NativeCleanupError } from './harnesses/native-cleanup.js'
import {
  createProductionNativeAdapter,
  createNativeResources,
  harnessTransport,
} from './sessions/native-factory.js'
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
import { refreshAccountModels } from './accounts/models.js'
import { pruneWorktreesForRepositories } from './git/worktrees.js'
import { RequestGuard } from './request-guard.js'
import { PreviewManager } from './previews/manager.js'
import { previewPublicRoutes, previewRoutes } from './previews/transport.js'

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
  refreshModels?: (
    accountId: string,
    signal?: AbortSignal,
  ) => void | Promise<void>,
  workspaceFiles?: WorkspaceFiles,
  requestGuard = new RequestGuard(configState?.current.terminalAccess),
  previews?: PreviewManager,
  nativeInteractions?: NativeInteractions,
) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    const method = c.req.method.toUpperCase()
    const failure = requestGuard.check(c.req.raw, {
      mutation: method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS',
      incoming: (
        c.env as { incoming?: import('node:http').IncomingMessage } | undefined
      )?.incoming,
    })
    if (failure) return c.json({ error: failure }, 403)
    if (method === 'OPTIONS') {
      const origin = c.req.header('origin')
      return new Response(null, {
        status: 204,
        headers: origin
          ? {
              'access-control-allow-origin': origin,
              'access-control-allow-methods':
                'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
              'access-control-allow-headers':
                c.req.header('access-control-request-headers') ??
                'content-type',
              vary: 'Origin',
            }
          : undefined,
      })
    }
    await next()
  })

  if (status) app.route('/', statusRoutes(status))
  else app.get('/api/health', (c) => c.json({ ok: true, version }))
  if (uploadStore) {
    app.route('/', projectRoutes(uploadStore.database, uploadStore))
    if (manager) {
      app.route(
        '/',
        sessionRoutes(manager, uploadStore, workspaceFiles?.targets, questions),
      )
      app.route('/', forkRoutes(manager))
      app.route('/', sideChatRoutes(manager))
    }
    app.route('/', uploadRoutes(uploadStore))
    app.route('/', attachmentRoutes(uploadStore))
    app.route('/', projectFileRoutes(uploadStore.database))
    if (workspaceFiles) app.route('/', workspaceFileRoutes(workspaceFiles))
    app.route('/', skillRoutes(uploadStore.database))
    app.route(
      '/',
      gitRoutes({
        db: uploadStore.database,
        dataDir: uploadStore.dataDir,
        targets: workspaceFiles?.targets,
      }),
    )
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
        refreshModels,
      }),
    )
    app.route('/', serverConfigRoutes())
    if (previews) app.route('/', previewRoutes(previews))
  }
  if (questions) app.route('/', questionRoutes(questions, nativeInteractions))
  if (status) app.route('/', workspaceRoutes(status.db, uploadStore))
  if (runner && status)
    app.route(
      '/',
      epicRoutes({
        runner,
        projectPath: (projectId) =>
          (
            status.db
              .prepare(
                'SELECT path FROM projects WHERE id = ? AND deleted_at IS NULL',
              )
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
        prompt: async (text, delivery, options) => {
          await manager.prompt(
            session.id,
            text,
            undefined,
            undefined,
            undefined,
            undefined,
            options?.model,
            undefined,
            options?.configOptions,
            delivery,
            true,
          )
        },
        cancel: async () => {
          await manager.interrupt(session.id)
          await manager.discard(session.id)
        },
      }
      return worker
    },
  }
}

export function serverPort(
  argument: number | undefined,
  environment: string | undefined,
  configured: number,
) {
  if (
    argument === undefined &&
    environment !== undefined &&
    !/^(0|[1-9][0-9]*)$/.test(environment)
  )
    throw new Error('FORGE_PORT must be an integer from 0 through 65535')
  const port =
    argument ?? (environment === undefined ? configured : Number(environment))
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
    throw new Error('Server port must be an integer from 0 through 65535')
  return port
}

export function startServer(port?: number): ServerType {
  const configPath = resolve(
    process.env.FORGE_CONFIG ?? resolve(homedir(), '.forge/forge.toml'),
  )
  let config: ReturnType<typeof defaultConfig>
  let saveConfig = false
  try {
    const loaded = loadConfigSync(configPath)
    config = reconcileConfig(loaded, defaultConfig())
    if (JSON.stringify(loaded.harness) !== JSON.stringify(config.harness))
      saveConfig = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      config = defaultConfig()
      saveConfig = true
    } else {
      throw error
    }
  }
  const listenPort = serverPort(port, process.env.FORGE_PORT, config.port)
  if (saveConfig) saveConfigSync(configPath, config)
  // Loaded lazily so the module still imports on runtimes without node:sqlite.
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (path: string) => DatabaseSync
  }
  const dataDir = resolve(process.env.FORGE_DATA_DIR ?? 'data')
  mkdirSync(dataDir, { recursive: true })
  const db = new DatabaseSync(process.env.FORGE_DB ?? join(dataDir, 'forge.db'))
  migrate(db)
  const workspaceFiles = new WorkspaceFiles(db)
  const currentVersion = process.env.FORGE_VERSION ?? version
  const previousBoot = db
    .prepare('SELECT version, stopped_at FROM server_boots WHERE id = 1')
    .get() as PreviousServerBoot | undefined
  db.prepare(
    `INSERT INTO server_boots (id, version, started_at, stopped_at)
     VALUES (1, ?, ?, NULL)
     ON CONFLICT(id) DO UPDATE SET
       version = excluded.version,
       started_at = excluded.started_at,
       stopped_at = NULL`,
  ).run(currentVersion, Date.now())
  void pruneWorktreesForRepositories(
    (
      db
        .prepare(
          'SELECT DISTINCT path FROM projects WHERE path IS NOT NULL AND deleted_at IS NULL',
        )
        .all() as Array<{
        path: string
      }>
    ).map((project) => project.path),
  )
  clearExpiredLimits(db, Date.now())
  const bus = new EventBus()
  const uploadStore = new UploadStore(db, { dataDir, bus })
  const questions = new ServerQuestionManager({ db, bus })
  const nativeInteractions = new NativeInteractions(db, bus)
  const configState: ConfigState = { current: config, path: configPath }
  const accountStore = new HarnessAccountStore(db)
  const nativeResources = createNativeResources()
  const loadNativeAttachment = createNativeAttachmentLoader(db, dataDir)
  const factory: HarnessFactory = (key, accountId) => {
    const entry = configState.current.harness[key]
    if (!entry) throw new Error(`Harness ${key} is not configured`)
    const account = accountId ? accountStore.get(accountId) : undefined
    if (account && account.harnessKey !== key)
      throw new Error('Account does not belong to harness')
    const transport = harnessTransport(key, entry)
    const derived =
      transport === 'native'
        ? entry
        : account
          ? deriveAccountHarness(entry, account)
          : entry
    const adapter =
      transport === 'native'
        ? createProductionNativeAdapter(key, {
            entry,
            account,
            db,
            dataDir,
            uploads: uploadStore,
            resources: nativeResources,
            loadAttachment: loadNativeAttachment,
          })
        : undefined
    if (adapter)
      return nativeHarness(
        adapter,
        (sessionId, providerSessionId) => {
          db.prepare(
            'UPDATE sessions SET provider_session_id = ? WHERE id = ?',
          ).run(providerSessionId, sessionId)
        },
        nativeInteractions,
      )
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
    dataDir,
  )
  const terminals = new TerminalManager(db, workspaceFiles.targets)
  uploadStore.setTerminalManager(terminals)
  manager.setTerminalManager(terminals)
  const terminalAuthority = new TerminalAuthority(config.terminalAccess)
  const requestGuard = new RequestGuard(config.terminalAccess)
  const terminalRequests = new TerminalRequests(
    terminals.limits.http,
    terminals.limits.requestDeadlineMs,
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
      ['devin', unsupportedUsageProbe],
      ['hermes', unsupportedUsageProbe],
      ['pi', unsupportedUsageProbe],
    ]),
  })
  const modelRefreshes = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >()
  let modelRefreshStopped = false
  const refreshModels = (accountId: string, signal?: AbortSignal) => {
    const previous = modelRefreshes.get(accountId)
    if (previous) return previous.promise
    if (modelRefreshStopped || signal?.aborted || modelRefreshes.size >= 8)
      return
    const account = accountStore.get(accountId)
    const entry = account && configState.current.harness[account.harnessKey]
    if (!account || !entry || entry.adapterKind !== 'native') return
    const controller = new AbortController()
    const abort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    const promise = Promise.resolve().then(async () => {
      try {
        await refreshAccountModels(db, {
          accountId,
          harnessKey: account.harnessKey,
          signal: controller.signal,
          probe: (probeSignal) =>
            discoverNativeModels({
              key: account.harnessKey,
              entry,
              account,
              dataDir,
              resources: nativeResources,
              cwd: process.cwd(),
              signal: probeSignal,
            }),
        })
      } finally {
        signal?.removeEventListener('abort', abort)
      }
    })
    modelRefreshes.set(accountId, { controller, promise })
    void promise.then(
      () => modelRefreshes.delete(accountId),
      () => {
        // Failed cleanup retains the original operation for shutdown.
      },
    )
    return promise
  }
  const harnessHealth = createHarnessHealthReader({ db, configState, manager })
  // Settle persisted turns before exposing the port. Respawn work continues
  // from the settled state without delaying health checks.
  void recoverSessions(db, manager, bus, previousBoot, currentVersion)
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
    refreshModels,
    workspaceFiles,
    requestGuard,
    undefined,
    nativeInteractions,
  )
  const previews = new PreviewManager(
    workspaceFiles.targets,
    config.preview?.publicOrigin,
  )
  app.route('/', previewRoutes(previews))
  usagePoller.start()
  const upgrades = new WebSocketUpgrades(
    app,
    terminals.limits.http,
    terminals.limits.requestDeadlineMs,
    requestGuard,
  )
  app.get('/ws', websocketRoute(upgrades.upgradeWebSocket, db, bus))
  app.route(
    '/',
    terminalRoutes(terminals, terminalAuthority, upgrades, terminalRequests),
  )
  const server = serve(
    {
      fetch: app.fetch,
      port: listenPort,
    },
    (address) => {
      requestGuard.bind(address.port)
      terminalAuthority.bind(address.port)
      console.log(`FORGE_LISTENING ${address.port}`)
    },
  )
  const previewServer = config.preview
    ? serve({
        fetch: previewPublicRoutes(previews).fetch,
        hostname: config.preview.listenerHost,
        port: config.preview.listenerPort,
      })
    : undefined
  upgrades.install(server as Server)
  const shutdown = new ServerShutdown(
    server as Server,
    () => {
      modelRefreshStopped = true
      for (const operation of modelRefreshes.values())
        operation.controller.abort()
      terminals.stopAccepting()
      terminalRequests.stopAccepting()
      upgrades.stopAccepting()
    },
    () => {
      db.prepare('UPDATE server_boots SET stopped_at = ? WHERE id = 1').run(
        Date.now(),
      )
      process.removeListener('SIGTERM', shutdown.signal)
      process.removeListener('SIGINT', shutdown.signal)
    },
    terminals.limits.shutdownCallbacks,
  )
  shutdown.addCleanupHook(() => terminalRequests.settled())
  shutdown.addCleanupHook(async () => {
    if (!(await terminals.closeAll()))
      throw new TerminalError(
        'cleanup_unknown',
        503,
        'Terminal cleanup is unknown',
      )
  })
  shutdown.addCleanupHook(async () => {
    if (!(await upgrades.close()))
      throw new TerminalError(
        'cleanup_unknown',
        503,
        'WebSocket cleanup is unknown',
      )
  })
  shutdown.addCleanupHook(() => manager.close())
  shutdown.addCleanupHook(async () => {
    const results = await Promise.allSettled(
      [...modelRefreshes.entries()].map(async ([accountId, operation]) => {
        try {
          await operation.promise
        } catch (error) {
          if (!(error instanceof NativeCleanupError)) throw error
          await error.retryCleanup()
          if (modelRefreshes.get(accountId) === operation)
            modelRefreshes.delete(accountId)
        }
      }),
    )
    const failures = results
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason)
    if (failures.length)
      throw new AggregateError(failures, 'Native model cleanup failed')
  })
  shutdown.addCleanupHook(() => nativeResources.close())
  shutdown.addCleanupHook(() => workspaceFiles.close())
  shutdown.addCleanupHook(() => previews.close())
  shutdown.addCleanupHook(() => {
    previewServer?.close()
  })
  shutdown.addCleanupHook(() => {
    loginManager.close()
    usagePoller.stop()
    uploadStore.close()
  })
  process.on('SIGTERM', shutdown.signal)
  process.on('SIGINT', shutdown.signal)
  return server
}

if (process.env.NODE_ENV !== 'test') {
  startServer()
}
