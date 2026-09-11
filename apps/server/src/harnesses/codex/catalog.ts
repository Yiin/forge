import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { DispatchOptions } from '../types.js'
import { JsonlRpcTransport, type JsonRpcIncoming } from '../jsonrpc.js'
import { startNativeProcess, type NativeProcess } from '../process.js'
import { diagnosticError, positiveLimit } from '../diagnostics.js'
import {
  admitCodexConfiguration,
  canonicalDirectory,
  copyLaunchOptions,
  prepareCodexEnvironment,
  type CodexLaunchOptions,
  type CodexProviderProvenance,
} from './environment.js'
import {
  PROFILE,
  CodexBudget,
  MiB,
  accountSchema,
  modelPageSchema,
  skillsSchema,
  byteSize,
  fail,
  initializeSchema,
  same,
  parseOptions,
  type CodexModel,
} from './wire.js'

export type CodexAdapterOptions = CodexLaunchOptions & {
  secrets?: readonly string[]
  signal?: AbortSignal
  initialOptions?: DispatchOptions
  loadAttachment: (
    sessionId: string,
    attachmentId: string,
    signal: AbortSignal,
  ) => Promise<{ mime: string; name: string; path: string; sizeBytes: number }>
  startupTimeoutMs?: number
  interruptGraceMs?: number
  preparationTimeoutMs?: number
}
export type CodexConnection = {
  rpc: JsonlRpcTransport
  request: JsonlRpcTransport['request']
  process: NativeProcess
  cwd: string
  baseline: Record<string, unknown>
  provenance: CodexProviderProvenance
  initialize: z.infer<typeof initializeSchema>
  generation: string
}

/** One owned connection and one overall deadline, including canonical path preparation. */
export async function connectCodex<T>(
  input: CodexAdapterOptions,
  cwd: string,
  transaction: (connection: CodexConnection) => Promise<T>,
  incoming?: (message: JsonRpcIncoming, rpc: JsonlRpcTransport) => void,
  signal?: AbortSignal,
  generation = randomUUID(),
  beforeLaunch?: (canonicalCwd: string) => void | Promise<void>,
  budget = new CodexBudget(),
): Promise<{ process: NativeProcess; value: T }> {
  const options = copyLaunchOptions(input)
  const initial = parseOptions(input.initialOptions)
  if (
    initial.sandboxPolicy?.type === 'externalSandbox' ||
    (initial.sandboxPolicy?.type === 'readOnly' &&
      initial.sandboxPolicy.networkAccess === true)
  )
    fail('INITIAL_SANDBOX_UNSUPPORTED')
  if (
    (input.secrets?.length ?? 0) > 256 ||
    byteSize(input.secrets ?? []) > 256 * 1024
  )
    fail('SECRETS_LIMIT')
  const secrets = [...(input.secrets ?? [])]
  const timeout = positiveLimit(
    input.startupTimeoutMs ?? 30_000,
    'Codex startup',
  )
  const releaseStartupControl = budget.charge(
    'control-resources',
    256,
    512,
    256 * 1024,
  )
  const controller = new AbortController()
  const abort = () => controller.abort()
  const signals = [input.signal, signal].filter(
    (value): value is AbortSignal => !!value,
  )
  for (const value of signals) {
    if (value.aborted) controller.abort()
    else value.addEventListener('abort', abort, { once: true })
  }
  const deadline = performance.now() + timeout
  const timer = setTimeout(abort, timeout)
  const check = () => {
    if (controller.signal.aborted || performance.now() >= deadline)
      fail('STARTUP_CANCELLED')
  }
  let owned: NativeProcess | undefined
  let rejectPreparation!: (error: Error) => void
  const stopped = new Promise<never>((_, reject) => {
    rejectPreparation = reject
  })
  const stopPreparation = () =>
    rejectPreparation(new Error('CODEX_STARTUP_CANCELLED'))
  controller.signal.addEventListener('abort', stopPreparation, { once: true })
  try {
    check()
    const canonical = await Promise.race([canonicalDirectory(cwd), stopped])
    check()
    await Promise.race([Promise.resolve(beforeLaunch?.(canonical)), stopped])
    check()
    const prepared = await Promise.race([
      prepareCodexEnvironment(options, canonical),
      stopped,
    ])
    check()
    return await startNativeProcess(
      {
        command: options.command!,
        args: options.args,
        cwd: canonical,
        env: prepared.env,
        secrets,
        signal: controller.signal,
        startupTimeoutMs: Math.max(1, Math.floor(deadline - performance.now())),
      },
      async (process) => {
        const rpc = new JsonlRpcTransport({
          stdin: process.child.stdin,
          stdout: process.child.stdout,
          wireProfile: 'unversioned',
          runtimeGeneration: generation,
          maxLineBytes: 8 * MiB,
          maxQueuedFrames: 128,
          maxQueuedBytes: 16 * MiB,
          maxPendingRequests: 128,
          maxIncomingRequests: 128,
          maxIncomingHandlers: 4,
          maxQueuedIncomingFrames: 1024,
          maxQueuedIncomingBytes: 16 * MiB,
          requestTimeoutMs: 30_000,
          secrets,
          onIncoming: (message) => {
            if (incoming) incoming(message, rpc)
            else if (message.type === 'request')
              void (
                message.method === 'mcpServer/elicitation/request'
                  ? rpc.respond(message, { action: 'decline', content: null })
                  : rpc.respondError(
                      message,
                      -32601,
                      'Codex callback is unsupported',
                    )
              ).catch(() => {})
          },
        })
        // Charge adapter-owned call data; the accepted router still owns all correlation and IO.
        const request: JsonlRpcTransport['request'] = <T = unknown>(
          method: string,
          params?: unknown,
          options = {},
        ) => {
          const release = budget.charge(
            'pending-calls',
            byteSize([method, params]) + 256,
            128,
            8 * MiB,
          )
          let releaseControl: () => void
          try {
            releaseControl = budget.charge(
              'control-resources',
              256,
              512,
              256 * 1024,
            )
          } catch (error) {
            release()
            throw error
          }
          return rpc.request<T>(method, params, options).finally(() => {
            release()
            releaseControl()
          })
        }
        owned = process
        void process.done.then(() => {
          for (const value of signals) value.removeEventListener('abort', abort)
          releaseStartupControl()
        })
        process.ownTransport(rpc)
        const initialized = initializeSchema.safeParse(
          await request('initialize', {
            clientInfo: { name: 'forge', title: 'Forge', version: '0.2.3' },
            capabilities: { experimentalApi: false },
          }),
        )
        if (!initialized.success) fail('INITIALIZE_RESPONSE')
        if (
          prepared.expectedHome &&
          initialized.data.codexHome !== prepared.expectedHome
        )
          fail('ACCOUNT_HOME')
        await rpc.notify('initialized', {})
        const admitted = admitCodexConfiguration(
          await request('config/read', {
            cwd: canonical,
            includeLayers: false,
          }),
          prepared,
        )
        return transaction({
          rpc,
          request,
          process,
          cwd: canonical,
          ...admitted,
          initialize: initialized.data,
          generation,
        })
      },
    )
  } catch (error) {
    throw diagnosticError(error, secrets)
  } finally {
    clearTimeout(timer)
    controller.signal.removeEventListener('abort', stopPreparation)
    if (!owned) {
      for (const value of signals) value.removeEventListener('abort', abort)
      releaseStartupControl()
    }
  }
}

export type CodexDiscovery = {
  profile: typeof PROFILE
  version: {
    source: 'initialize'
    userAgent: string
    compatibility: 'unverified'
  }
  provenance: CodexProviderProvenance
  account: z.infer<typeof accountSchema> | null
  models: CodexModel[]
  visibleModels: CodexModel[]
  skills: z.infer<typeof skillsSchema>['data']
  errors: Partial<Record<'account' | 'models' | 'skills', string>>
  complete: { account: boolean; models: boolean; skills: boolean }
}
export async function readModels(
  connection: CodexConnection,
  signal?: AbortSignal,
) {
  const models = new Map<string, CodexModel>()
  const cursors = new Set<string>()
  let cursor: string | undefined
  let bytes = 0
  for (let page = 0; page < 100; page++) {
    const result = modelPageSchema.parse(
      await connection.request(
        'model/list',
        {
          includeHidden: true,
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        },
        { signal },
      ),
    )
    bytes += byteSize(result) + result.data.length * 128
    if (bytes > 16 * MiB) fail('MODEL_LIMIT')
    for (const model of result.data) {
      const old = models.get(model.id)
      if (old && !same(old, model)) fail('MODEL_CONFLICT')
      models.set(model.id, model)
      if (models.size > 10000) fail('MODEL_LIMIT')
    }
    if (result.nextCursor == null) return [...models.values()]
    if (cursors.has(result.nextCursor)) fail('MODEL_CURSOR_LOOP')
    cursors.add(result.nextCursor)
    cursor = result.nextCursor
  }
  return fail('MODEL_PAGE_LIMIT')
}
export async function readSkills(
  connection: CodexConnection,
  signal?: AbortSignal,
) {
  const value = await connection.request(
    'skills/list',
    { cwds: [connection.cwd], forceReload: false },
    { signal },
  )
  if (byteSize(value) > 16 * MiB) fail('SKILL_LIMIT')
  const result = skillsSchema.parse(value)
  if (
    result.data.reduce(
      (sum, entry) => sum + entry.skills.length + entry.errors.length,
      0,
    ) > 10000
  )
    fail('SKILL_LIMIT')
  return result.data
}

export async function discoverCodex(
  options: CodexAdapterOptions,
  request: { cwd: string; signal?: AbortSignal },
): Promise<CodexDiscovery> {
  let process: NativeProcess | undefined
  try {
    const result = await connectCodex(
      options,
      request.cwd,
      async (connection) => {
        process = connection.process
        const errors: CodexDiscovery['errors'] = {}
        let account: CodexDiscovery['account'] = null
        let models: CodexModel[] = []
        let skills: CodexDiscovery['skills'] = []
        try {
          account = accountSchema.parse(
            await connection.request(
              'account/read',
              { refreshToken: false },
              { signal: request.signal },
            ),
          )
        } catch (error) {
          errors.account = diagnosticError(error, options.secrets).message
        }
        try {
          models = await readModels(connection, request.signal)
        } catch (error) {
          errors.models = diagnosticError(error, options.secrets).message
        }
        try {
          skills = await readSkills(connection, request.signal)
        } catch (error) {
          errors.skills = diagnosticError(error, options.secrets).message
        }
        if (request.signal?.aborted || connection.process.signal.aborted)
          fail('DISCOVERY_CANCELLED')
        return {
          profile: PROFILE as typeof PROFILE,
          version: {
            source: 'initialize' as const,
            userAgent: connection.initialize.userAgent,
            compatibility: 'unverified' as const,
          },
          provenance: connection.provenance,
          account,
          models,
          visibleModels: models.filter((model) => !model.hidden),
          skills,
          errors,
          complete: {
            account: !errors.account,
            models: !errors.models,
            skills:
              !errors.skills && skills.every((entry) => !entry.errors.length),
          },
        }
      },
      undefined,
      request.signal,
    )
    return result.value
  } finally {
    await process?.close()
  }
}
