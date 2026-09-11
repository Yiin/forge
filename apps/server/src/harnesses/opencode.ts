import { randomBytes, randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import type { HarnessAccount } from '@forge/protocol/accounts'
import type { HarnessConfig } from '@forge/protocol/config'
import {
  confirmedNativeBindingSchema,
  harnessEventSchema,
  promptInputSchema,
  dispatchOptionsSchema,
  type TerminalOutcome,
} from '@forge/protocol/harness'
import { accountEnv } from '../accounts/store.js'
import { startNativeProcess, type NativeProcess } from './process.js'
import { diagnosticError } from './diagnostics.js'
import {
  createCompletionHandle,
  type HarnessAdapter,
  type HarnessHandle,
  type HarnessSession,
  type HarnessReceipt,
  type HarnessEvent,
  type DispatchOptions,
  type PromptInput,
  type QuestionAnswer,
  type PermissionReply,
  type ConfirmedNativeBinding,
} from './types.js'
import {
  OpenCodeHttp,
  OpenCodeError,
  RetainedBudget,
  array,
  bound,
  bytes,
  fault,
  limitsOf,
  nativeId,
  object,
  originOf,
  ownedOrigin,
  string,
  type OpenCodeLimits,
} from './opencode-http.js'
import {
  BoundedStore,
  OpenCodeEvents,
  envelope,
  messageInfo,
  compareMessages,
  newNativeId,
  partInfo,
  snapshot,
  stableId,
  tuple,
  type EventOwner,
  type NativeMessage,
  type NativePart,
  type Snapshot,
} from './opencode-events.js'

export type { OpenCodeLimits } from './opencode-http.js'
export type OpenCodeAttachedResumeScope = Readonly<{
  origin: string
  connectionId: string
  provider: string
  accountId: string | null
  cwd: string
  providerSessionId: string
}>
export type OpenCodeNativeLaunchAuthority = {
  credentials: 'native-configured-sources'
  provider: string
  canonicalCwd: string
  account: Pick<
    HarnessAccount,
    'id' | 'harnessKey' | 'kind' | 'adapterKind' | 'homePath' | 'disabledAt'
  >
  harness: Pick<
    HarnessConfig,
    'command' | 'args' | 'env' | 'adapterKind' | 'enabled'
  >
  selectedEnvOverrides: NodeJS.ProcessEnv
  credentialEnvironment: ReadonlyArray<{
    name:
      'OPENCODE_AUTH_CONTENT' | 'CLOUDFLARE_ACCOUNT_ID' | 'CLOUDFLARE_API_KEY'
    value: string | undefined
    accountId: string | null
  }>
}
export type OpenCodeAdapterOptions = {
  provider: string
  accountId: string | null
  server:
    | {
        mode: 'owned'
        executable: string
        env?: NodeJS.ProcessEnv
        accountHome?: string
        nativeLaunch?: OpenCodeNativeLaunchAuthority
      }
    | {
        mode: 'attached'
        origin: string
        connectionId: string
        auth?: { username: string; password: string }
        scope: { provider: string; accountId: string | null; cwd: string }
        exclusiveSession: true
      }
  attachedResumeScopes?: ReadonlyMap<string, OpenCodeAttachedResumeScope>
  defaults?: { model?: string; variant?: string }
  secrets?: readonly string[]
  signal?: AbortSignal
  resolveAttachment?: (input: {
    sessionId: string
    provider: string
    accountId: string | null
    cwd: string
    attachmentId: string
    mime: string
    signal: AbortSignal
    deadlineAt: number
    maxBytes: number
  }) => Promise<{
    attachmentId: string
    mime: string
    filename: string
    sizeBytes: number
    bytes: Uint8Array
  }>
  limits?: Partial<OpenCodeLimits>
}
export type OpenCodeDiscovery = {
  version: string
  models: ReadonlyArray<{
    id: string
    displayName: string
    providerID: string
    modelID: string
    connected: boolean
    variants: readonly string[]
    input: readonly string[]
    contextWindow?: number
  }>
  commands: ReadonlyArray<{
    name: string
    description?: string
    agent?: string
    model?: string
    source?: 'command' | 'mcp' | 'skill'
    subtask?: boolean
    hints: readonly string[]
    executable: boolean
    unavailableReason?: 'subtask' | 'agent-mode-unknown' | 'model-unknown'
    effectiveAgent?: { name: string; mode: 'primary' | 'all' }
    configuredModel?: string
  }>
  history: { availability: 'complete' | 'partial'; nextCursor?: string }
  warnings: ReadonlyArray<{ code: string; message: string }>
}
export type OpenCodeHandle = HarnessHandle & {
  queue(
    input: PromptInput[] | string,
    options?: DispatchOptions,
    identity?: { runId: string; turnId: string },
  ): HarnessReceipt
  rejectQuestion(requestId: string): Promise<void>
  readonly discovery: OpenCodeDiscovery
  readonly attachedResumeScope: OpenCodeAttachedResumeScope | null
}
export type OpenCodeAdapter = Omit<HarnessAdapter, 'spawn' | 'load'> & {
  spawn(
    session: HarnessSession,
    emit: (event: HarnessEvent) => void,
  ): Promise<OpenCodeHandle>
  load(
    session: HarnessSession,
    emit: (event: HarnessEvent) => void,
  ): Promise<OpenCodeHandle>
}
const serveArgs = ['serve', '--port', '0', '--hostname', '127.0.0.1']
const selectorNames = [
  'OPENCODE_AUTH_CONTENT',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_API_KEY',
]
const mimes = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
])
function copyEnv(env: NodeJS.ProcessEnv, limits: OpenCodeLimits) {
  if (Object.keys(env).length > limits.envCount)
    throw fault('CAPACITY', 'Too many native environment entries')
  for (const [key, value] of Object.entries(env)) {
    string(key)
    if (value !== undefined && typeof value !== 'string')
      throw fault('ACCOUNT_SCOPE_MISMATCH', 'Invalid native environment value')
  }
  bound(env, limits.authorityBytes, 'Native environment')
  return { ...env }
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
  return value
}
function copyOptions(
  input: OpenCodeAdapterOptions,
  limits: OpenCodeLimits,
): OpenCodeAdapterOptions {
  string(input.provider)
  if (input.accountId !== null) string(input.accountId)
  bound(input.defaults, limits.authorityBytes, 'Native defaults')
  bound(input.secrets, limits.authorityBytes, 'Native redaction values')
  let server: OpenCodeAdapterOptions['server']
  if (input.server.mode === 'owned') {
    const source = input.server
    string(source.executable, 4096)
    if (source.accountHome !== undefined) string(source.accountHome, 4096)
    const authority = source.nativeLaunch
    let nativeLaunch: OpenCodeNativeLaunchAuthority | undefined
    if (authority) {
      if (
        authority.credentials !== 'native-configured-sources' ||
        Object.keys(authority).some(
          (key) =>
            ![
              'credentials',
              'provider',
              'canonicalCwd',
              'account',
              'harness',
              'selectedEnvOverrides',
              'credentialEnvironment',
            ].includes(key),
        )
      )
        throw fault(
          'ACCOUNT_AUTH_SOURCE_UNSUPPORTED',
          'Native launch supports only the complete configured-sources policy',
        )
      if (
        !authority.account ||
        !authority.harness ||
        !authority.selectedEnvOverrides ||
        !authority.credentialEnvironment
      )
        throw fault(
          'ACCOUNT_SCOPE_UNPROVED',
          'Selected native launch requires account and harness records',
        )
      bound(authority, limits.authorityBytes, 'Native launch authority')
      const args = authority.harness.args ?? []
      if (
        !Array.isArray(args) ||
        !(
          args.length === 0 ||
          JSON.stringify(args) === JSON.stringify(serveArgs)
        )
      )
        throw fault(
          'ACCOUNT_SCOPE_MISMATCH',
          'Native harness arguments do not match the owned serve command',
        )
      if (authority.credentialEnvironment.length > 3)
        throw fault(
          'ACCOUNT_SCOPE_MISMATCH',
          'Too many native credential selectors',
        )
      nativeLaunch = {
        credentials: authority.credentials,
        provider: string(authority.provider),
        canonicalCwd: string(authority.canonicalCwd, 4096),
        account: {
          id: authority.account.id,
          harnessKey: authority.account.harnessKey,
          kind: authority.account.kind,
          adapterKind: authority.account.adapterKind,
          homePath: authority.account.homePath,
          disabledAt: authority.account.disabledAt,
        },
        harness: {
          command: authority.harness.command,
          adapterKind: authority.harness.adapterKind,
          enabled: authority.harness.enabled,
          args: [...args],
          env: copyEnv(authority.harness.env ?? {}, limits) as Record<
            string,
            string
          >,
        },
        selectedEnvOverrides: copyEnv(authority.selectedEnvOverrides, limits),
        credentialEnvironment: authority.credentialEnvironment.map((entry) => ({
          name: entry.name,
          value: entry.value,
          accountId: entry.accountId,
        })),
      }
      for (const key of ['id', 'harnessKey', 'kind'] as const)
        string(nativeLaunch.account[key])
      string(nativeLaunch.account.homePath, 4096)
      string(nativeLaunch.harness.command, 4096)
      freeze(nativeLaunch)
    }
    server = {
      ...source,
      env: source.env === undefined ? undefined : copyEnv(source.env, limits),
      nativeLaunch,
    }
  } else {
    const source = input.server
    if (source.exclusiveSession !== true)
      throw fault(
        'ACCOUNT_SCOPE_UNPROVED',
        'Attached sessions require exclusive native session control',
      )
    string(source.connectionId, limits.idBytes)
    string(source.scope.cwd, 4096)
    if (source.auth) {
      string(source.auth.username, limits.authorityBytes)
      string(source.auth.password, limits.authorityBytes)
    }
    server = {
      ...source,
      origin: originOf(source.origin),
      scope: { ...source.scope },
      auth: source.auth ? { ...source.auth } : undefined,
    }
    bound(
      server.auth,
      limits.authorityBytes,
      'Native connection authentication',
    )
  }
  const scopes = new Map<string, OpenCodeAttachedResumeScope>()
  if ((input.attachedResumeScopes?.size ?? 0) > limits.scopeCount)
    throw fault('CAPACITY', 'Too many attached resume scopes')
  let scopeBytes = 0
  for (const [id, scope] of input.attachedResumeScopes ?? []) {
    string(id)
    string(scope.connectionId)
    string(scope.provider)
    if (scope.accountId !== null) string(scope.accountId)
    string(scope.cwd, 4096)
    nativeId(scope.providerSessionId, 'ses')
    if (originOf(scope.origin) !== scope.origin)
      throw fault(
        'RESUME_SCOPE_MISMATCH',
        'Saved native origin is not canonical',
      )
    const copy = freeze({ ...scope })
    scopeBytes += bytes([id, copy])
    if (scopeBytes > limits.scopeBytes)
      throw fault('CAPACITY', 'Attached resume scopes exceed their byte limit')
    scopes.set(id, copy)
  }
  const secrets = [...(input.secrets ?? [])]
  if (server.mode === 'attached' && server.auth)
    secrets.push(
      server.auth.password,
      Buffer.from(`${server.auth.username}:${server.auth.password}`).toString(
        'base64',
      ),
    )
  return {
    ...input,
    server,
    defaults: { ...input.defaults },
    secrets,
    attachedResumeScopes: scopes,
    limits: { ...input.limits },
  }
}
async function directory(path: string) {
  const canonical = await realpath(path)
  if (!(await stat(canonical)).isDirectory())
    throw fault('SCOPE_MISMATCH', 'Native cwd must be a directory')
  return canonical
}
async function ownedEnvironment(
  options: OpenCodeAdapterOptions,
  session: HarnessSession,
  inherited: NodeJS.ProcessEnv,
  limits: OpenCodeLimits,
) {
  if (options.server.mode !== 'owned')
    throw fault('SCOPE_MISMATCH', 'Expected an owned native launch')
  const server = options.server
  const env = { ...inherited, ...server.env }
  if (options.accountId !== null) {
    const authority = server.nativeLaunch
    if (!authority || !server.accountHome || server.env === undefined)
      throw fault(
        'ACCOUNT_SCOPE_UNPROVED',
        'Selected native account requires its launch records and environment',
      )
    const { account, harness } = authority
    const expectedEnv = { ...harness.env, ...authority.selectedEnvOverrides }
    const equalEnv =
      Object.keys(server.env).length === Object.keys(expectedEnv).length &&
      Object.keys(expectedEnv).every(
        (key) =>
          Object.hasOwn(server.env!, key) &&
          server.env![key] === expectedEnv[key],
      )
    if (
      authority.provider !== options.provider ||
      authority.provider !== session.provider ||
      account.id !== options.accountId ||
      account.id !== session.accountId ||
      account.harnessKey !== options.provider ||
      account.kind !== 'opencode' ||
      account.disabledAt !== null ||
      harness.enabled !== true ||
      harness.adapterKind !== 'native' ||
      (account.adapterKind !== undefined && account.adapterKind !== 'native') ||
      authority.canonicalCwd !== session.cwd ||
      harness.command !== server.executable ||
      !equalEnv
    )
      throw fault(
        'ACCOUNT_SCOPE_MISMATCH',
        'Selected native account and harness records do not match this launch',
      )
    const home = await directory(server.accountHome)
    if ((await directory(account.homePath)) !== home)
      throw fault(
        'ACCOUNT_SCOPE_MISMATCH',
        'Selected native account home does not match this launch',
      )
    const entries = new Map<
      string,
      { value: string | undefined; accountId: string | null }
    >()
    for (const entry of authority.credentialEnvironment) {
      if (
        !selectorNames.includes(entry.name) ||
        entries.has(entry.name) ||
        (entry.value === undefined
          ? entry.accountId !== null
          : entry.accountId !== options.accountId ||
            typeof entry.value !== 'string')
      )
        throw fault(
          'ACCOUNT_SCOPE_MISMATCH',
          'Native credential selector does not match the selected account',
        )
      entries.set(entry.name, entry)
    }
    if (
      (env.CLOUDFLARE_ACCOUNT_ID || env.CLOUDFLARE_API_KEY) &&
      (!entries.has('CLOUDFLARE_ACCOUNT_ID') ||
        !entries.has('CLOUDFLARE_API_KEY'))
    )
      throw fault(
        'ACCOUNT_SCOPE_UNPROVED',
        'Both Cloudflare selectors require explicit scoped values or removals',
      )
    for (const [name, entry] of entries) env[name] = entry.value
    Object.assign(env, accountEnv('opencode', home))
    env.OPENCODE_AUTH_CONTENT = entries.get('OPENCODE_AUTH_CONTENT')?.value
    bound(authority, limits.authorityBytes, 'Native launch authority')
  }
  return env
}

export function createOpenCodeAdapter(
  input: OpenCodeAdapterOptions,
): OpenCodeAdapter {
  const limits = limitsOf(input.limits)
  const options = copyOptions(input, limits)
  const inherited = { ...process.env }
  const launch = async (
    original: HarnessSession,
    emit: (event: HarnessEvent) => void,
    load: boolean,
  ) => {
    const session = {
      ...original,
      binding: original.binding ? { ...original.binding } : original.binding,
    }
    string(session.id)
    string(session.cwd, 4096)
    if (
      session.provider !== options.provider ||
      (session.accountId ?? null) !== options.accountId
    )
      throw fault(
        'SCOPE_MISMATCH',
        'Native session provider or account does not match',
      )
    if (load ? !session.binding?.providerSessionId : !!session.binding)
      throw fault(
        'RESUME_SCOPE_MISMATCH',
        'Use load only with a complete native binding',
      )
    if (session.binding?.providerSessionId)
      nativeId(session.binding.providerSessionId, 'ses', limits.idBytes)
    session.cwd = await directory(session.cwd)
    if (
      session.binding &&
      (session.binding.provider !== options.provider ||
        session.binding.accountId !== options.accountId ||
        session.binding.cwd !== session.cwd)
    )
      throw fault(
        'RESUME_SCOPE_MISMATCH',
        'Native binding scope does not match',
      )
    if (options.server.mode === 'attached') {
      const server = options.server
      if (
        server.scope.provider !== options.provider ||
        server.scope.accountId !== options.accountId ||
        server.scope.cwd !== session.cwd
      )
        throw fault('SCOPE_MISMATCH', 'Attached native scope does not match')
      if (load) {
        const previous = options.attachedResumeScopes?.get(session.id)
        const current = {
          origin: server.origin,
          connectionId: server.connectionId,
          provider: options.provider,
          accountId: options.accountId,
          cwd: session.cwd,
          providerSessionId: session.binding!.providerSessionId,
        }
        if (
          !previous ||
          Object.entries(current).some(
            ([key, value]) =>
              previous[key as keyof OpenCodeAttachedResumeScope] !== value,
          )
        )
          throw fault(
            'RESUME_SCOPE_MISMATCH',
            'Attached native connection does not match the confirmed resume scope',
          )
      }
      const runtime = new OpenCodeRuntime(options, session, emit, limits)
      try {
        await runtime.initialize(server.origin, server.auth, load)
        return runtime.handle
      } catch (error) {
        await runtime.retire(error)
        throw error
      }
    }
    const env = await ownedEnvironment(options, session, inherited, limits)
    const password = randomBytes(32).toString('base64url')
    const auth = { username: 'forge', password }
    const secrets = [
      ...(options.secrets ?? []),
      password,
      Buffer.from(`forge:${password}`).toString('base64'),
      ...(options.server.nativeLaunch?.credentialEnvironment.flatMap((entry) =>
        entry.value ? [entry.value] : [],
      ) ?? []),
    ]
    const runtime = new OpenCodeRuntime(
      { ...options, secrets },
      session,
      emit,
      limits,
    )
    const started = await startNativeProcess(
      {
        command: options.server.executable,
        args: [...serveArgs],
        cwd: session.cwd,
        env: {
          ...env,
          OPENCODE_SERVER_USERNAME: auth.username,
          OPENCODE_SERVER_PASSWORD: auth.password,
        },
        secrets,
        stderrLimit: limits.diagnosticBytes,
        signal: options.signal,
        startupTimeoutMs: limits.startupMs,
      },
      async (process) => {
        runtime.process = process
        process.ownTransport({
          done: runtime.done,
          close: (error) => {
            void runtime.retire(error)
          },
        })
        const origin = await ownedOrigin(process, limits, secrets)
        await runtime.initialize(origin, auth, load)
        return runtime.handle
      },
    )
    return started.value
  }
  return {
    kind: 'native',
    capabilities: {
      loadSession: true,
      steer: false,
      queue: true,
      cancel: true,
      permissions: true,
      questions: true,
      models: true,
    },
    spawn: (session, emit) => launch(session, emit, false),
    load: (session, emit) => launch(session, emit, true),
  }
}

type Ticket = EventOwner & {
  receipt?: HarnessReceipt
  settle?: ReturnType<typeof createCompletionHandle>['settle']
  input: PromptInput[]
  options: DispatchOptions
  model?: string
  modelSource?:
    'per-call' | 'handle' | 'factory/account' | 'command' | 'command-agent'
  variant?: string
  settled: boolean
  started: boolean
  submitted: boolean
  acceptedHttp: boolean
  httpSettled?: boolean
  cancelled: boolean
  controller: AbortController
  descriptorBytes: number
  preparationDeadline?: number
  activityTimer?: ReturnType<typeof setTimeout>
  preparationTimer?: ReturnType<typeof setTimeout>
  commandTimer?: ReturnType<typeof setTimeout>
  command?: { name: string; arguments: string }
  commandDeadline?: number
  outcome?: TerminalOutcome
}
type SettledTicket = EventOwner & {
  settled: true
  model?: string
  outcome: TerminalOutcome
}
type Child = EventOwner & {
  id: string
  parentToolCallId: string
  parentSessionId: string
  ancestry?: string
  taskKey: string
  proved: boolean
  finished: boolean
  deadline: number
  depth: number
}
type PendingRequest = {
  key: string
  id: string
  nativeId: string
  sessionId: string
  kind: 'question' | 'permission'
  owner: EventOwner
  native: Record<string, unknown>
  digest: string
  state: 'pending' | 'sending' | 'uncertain'
  expires: number
  timer: ReturnType<typeof setTimeout>
  questionMap?: Array<{ labels: string[]; multiple: boolean; custom: boolean }>
}
type Agent = {
  name: string
  mode: string
  hidden?: boolean
  model?: string
  variant?: string
}

class OpenCodeRuntime {
  readonly generation = randomUUID()
  readonly done: Promise<Error>
  readonly handle: OpenCodeHandle
  process?: NativeProcess
  private finish!: (error: Error) => void
  private readonly controller = new AbortController()
  private readonly startupDeadline: number
  private readonly budget: RetainedBudget
  private readonly events: OpenCodeEvents
  private readonly owners: BoundedStore<EventOwner>
  private readonly historical: BoundedStore<true>
  private readonly tickets: BoundedStore<Ticket | SettledTicket>
  private readonly inputs: BoundedStore<Ticket>
  private readonly physicalWork: BoundedStore<true>
  private readonly nativeModels: BoundedStore<{
    current?: string
    dirty?: boolean
    latest?: Pick<NativeMessage, 'id' | 'created' | 'model'>
  }>
  private sessionObservations = 0
  private readonly todos: BoundedStore<string>
  private readonly children: BoundedStore<Child>
  private readonly requests: BoundedStore<PendingRequest>
  private readonly dedup: BoundedStore<string>
  private readonly unknown: BoundedStore<true>
  private readonly knownChildren: BoundedStore<'historical' | 'created'>
  private readonly automaticOwners: BoundedStore<{
    owner: EventOwner
    settled: boolean
    sourceUserId: string
  }>
  private uncertaintyWork?: Promise<void>
  private readonly dirty = new Set<string>()
  private readonly immediateDirty = new Set<string>()
  private readonly snapshotOnly = new Set<string>()
  private queue: Ticket[] = []
  private queuedBytes = 0
  private active?: Ticket
  private actualRead?: Promise<unknown>
  private http!: OpenCodeHttp
  private stream?: ReturnType<OpenCodeHttp['connect']>
  private confirmed: ConfirmedNativeBinding | null = null
  private attached: OpenCodeAttachedResumeScope | null = null
  private catalog: OpenCodeDiscovery = {
    version: '1.18.26',
    models: [],
    commands: [],
    history: { availability: 'complete' },
    warnings: [],
  }
  private agents: Agent[] = []
  private defaultAgent?: string
  private localModel?: string
  private localVariant?: string
  private retired?: Error
  private closing?: Promise<void>
  private initialized = false
  private recovering = false
  private frozen = false
  private overflowingRequest = false
  private eventEpoch = 0
  private sequence = 0
  private reconcileWork?: Promise<void>
  private dirtyTimer?: ReturnType<typeof setTimeout>
  private cancelWork?: Promise<void>
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private readonly unknownTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >()
  private sourceSuffix = new Map<string, number>()
  private readonly errorTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >()
  constructor(
    private readonly options: OpenCodeAdapterOptions,
    private readonly session: HarnessSession,
    private readonly emit: (event: HarnessEvent) => void,
    private readonly limits: OpenCodeLimits,
  ) {
    this.startupDeadline = performance.now() + limits.startupMs
    this.done = new Promise((resolve) => {
      this.finish = resolve
    })
    this.budget = new RetainedBudget(limits.retainedBytes)
    this.owners = new BoundedStore(
      'owners',
      limits.ownerCount,
      limits.ownerBytes,
      this.budget,
    )
    this.historical = new BoundedStore(
      'historical',
      limits.ownerCount,
      limits.ownerBytes,
      this.budget,
    )
    this.tickets = new BoundedStore(
      'tickets',
      limits.receiptCount,
      limits.receiptBytes,
      this.budget,
    )
    this.inputs = new BoundedStore(
      'inputs',
      limits.receiptCount,
      limits.retainedBytes,
      this.budget,
    )
    this.physicalWork = new BoundedStore(
      'physicalWork',
      1,
      limits.inputBytes,
      this.budget,
    )
    this.nativeModels = new BoundedStore(
      'nativeModels',
      1,
      limits.ownerBytes,
      this.budget,
    )
    this.todos = new BoundedStore(
      'todos',
      limits.ownerCount,
      limits.ownerBytes,
      this.budget,
    )
    this.children = new BoundedStore(
      'children',
      limits.childCount,
      limits.childBytes,
      this.budget,
    )
    this.requests = new BoundedStore(
      'requests',
      limits.requestCount,
      limits.requestsBytes,
      this.budget,
    )
    this.dedup = new BoundedStore(
      'dedup',
      limits.dedupCount,
      limits.dedupBytes,
      this.budget,
    )
    this.unknown = new BoundedStore(
      'unknown',
      limits.unknownCount,
      limits.unknownBytes,
      this.budget,
    )
    this.knownChildren = new BoundedStore(
      'knownChildren',
      limits.childCount,
      limits.childBytes,
      this.budget,
    )
    this.automaticOwners = new BoundedStore(
      'automaticOwners',
      limits.receiptCount,
      limits.receiptBytes,
      this.budget,
    )
    this.events = new OpenCodeEvents(
      limits,
      this.budget,
      (owner, event, source) => this.publish(owner, event, source),
      (model) =>
        this.catalog.models.find((entry) => entry.id === model)?.contextWindow,
    )
    // Getters run on the public handle, which has a different receiver.
    // oxlint-disable-next-line typescript/no-this-alias
    const runtime = this
    this.handle = {
      get binding() {
        return runtime.confirmed
      },
      get attachedResumeScope() {
        return runtime.attached
      },
      get discovery() {
        return runtime.catalog
      },
      get availableModels() {
        return runtime.catalog.models
          .filter((model) => model.connected)
          .map(({ id, displayName }) => ({ id, displayName }))
      },
      prompt: (input, options, identity) =>
        this.admit(input, options, identity, false),
      queue: (input, options, identity) =>
        this.admit(input, options, identity, true),
      kill: () => this.retire(fault('CLOSED', 'Native adapter detached')),
      cancel: () => this.cancel(),
      replyQuestion: (id, answers) => this.replyQuestion(id, answers),
      rejectQuestion: (id) =>
        this.replyRequest(id, 'question', undefined, true),
      replyPermission: (reply) => this.replyPermission(reply),
      setModel: (model) => {
        this.live()
        this.validateModel(model)
        this.localModel = model
      },
      configOptions: () => [
        {
          id: 'variant',
          name: 'Variant',
          type: 'select',
          currentValue:
            this.localVariant ?? this.options.defaults?.variant ?? '',
          options: [
            { value: '', name: 'Native default' },
            ...(
              this.catalog.models.find(
                (model) =>
                  model.id ===
                  (this.localModel ??
                    this.options.defaults?.model ??
                    this.nativeModel),
              )?.variants ?? []
            ).map((variant) => ({ value: variant, name: variant })),
          ],
        },
      ],
      setConfigOption: async (id, value) => {
        this.live()
        if (id !== 'variant' || typeof value !== 'string')
          throw fault(
            'OPTION_UNSUPPORTED',
            'Unsupported native configuration option',
          )
        if (value)
          this.validateVariant(
            this.localModel ?? this.options.defaults?.model ?? this.nativeModel,
            value,
          )
        this.localVariant = value || undefined
      },
    }
    options.signal?.addEventListener('abort', this.onAbort, { once: true })
    if (options.signal?.aborted) this.onAbort()
  }
  private onAbort = () => {
    void this.retire(fault('CANCELLED', 'Native adapter cancelled'))
  }
  private live() {
    if (this.retired || this.controller.signal.aborted)
      throw this.retired ?? fault('CLOSED', 'Native adapter is closed')
  }
  private rootId() {
    return this.confirmed!.providerSessionId
  }
  private get nativeModel() {
    const selection = this.nativeModels.get('selection')
    if (selection?.dirty) return undefined
    return selection?.current ?? selection?.latest?.model
  }
  private sessionModel(value: unknown) {
    const info = object(value)
    if (
      nativeId(info.id, 'ses', this.limits.idBytes) !== this.rootId() ||
      info.directory !== this.session.cwd
    )
      throw fault(
        'RESUME_SCOPE_MISMATCH',
        'Native Session identity or directory changed',
      )
    for (const key of ['slug', 'projectID', 'title', 'version'])
      if (typeof info[key] !== 'string')
        throw fault('PROTOCOL', 'Native Session has an invalid required field')
    const time = object(info.time)
    for (const key of ['created', 'updated'])
      if (!Number.isSafeInteger(time[key]) || Number(time[key]) < 0)
        throw fault('PROTOCOL', 'Native Session has an invalid time')
    if (info.model === undefined) return undefined
    const model = object(info.model)
    if (model.variant !== undefined && typeof model.variant !== 'string')
      throw fault('PROTOCOL', 'Native Session has an invalid model variant')
    return `${string(model.providerID)}/${string(model.id)}`
  }
  private async refreshSessionModel(ticket: Ticket) {
    const observations = this.sessionObservations
    const result = await this.http.request(
      this.path(this.rootId()),
      'GET',
      undefined,
      {
        signal: ticket.controller.signal,
      },
    )
    if (!this.owns(ticket)) return
    const current = this.sessionModel(result.value)
    // Session timestamps are not revisions. An overlapping observation needs a fresh dispatch.
    if (observations !== this.sessionObservations)
      throw fault('BUSY', 'Native Session changed during model validation')
    const selection = this.nativeModels.get('selection')
    if (selection && !selection.dirty && selection.current === current) return
    this.nativeModels.put('selection', {
      ...selection,
      current,
      dirty: false,
    })
  }
  private recordUserModel(info: NativeMessage) {
    if (info.sessionID !== this.rootId() || info.role !== 'user' || !info.model)
      return
    const selection = this.nativeModels.get('selection') ?? {}
    const latest = selection.latest
    if (
      latest &&
      (info.created < latest.created ||
        (info.created === latest.created && info.id < latest.id))
    )
      return
    this.nativeModels.put('selection', {
      ...selection,
      latest: { id: info.id, created: info.created, model: info.model },
    })
  }
  private path(id: string) {
    return `/session/${encodeURIComponent(id)}`
  }
  private publish(
    owner: EventOwner,
    event: Record<string, unknown>,
    source?: string,
  ) {
    const suffixKey = source
      ? tuple(source, String(event.type), String(event.itemId ?? ''))
      : undefined
    const suffix = suffixKey ? (this.sourceSuffix.get(suffixKey) ?? 0) : 0
    if (suffixKey) this.sourceSuffix.set(suffixKey, suffix + 1)
    const parsed = harnessEventSchema.parse({
      runId: owner.runId,
      turnId: owner.turnId,
      runtimeGeneration: this.generation,
      deliveryId: source
        ? stableId(
            source,
            String(event.type),
            String(event.itemId ?? ''),
            String(suffix),
          )
        : `${this.generation}:${++this.sequence}`,
      providerRunId: owner.sessionId,
      providerTurnId: owner.userId,
      ...(owner.childId ? { childId: owner.childId } : {}),
      ...event,
    })
    this.emit(parsed)
  }
  private diagnostic(
    owner: EventOwner,
    code: string,
    message: string,
    retryable?: boolean,
  ) {
    this.publish(owner, {
      type: 'diagnostic',
      itemId: stableId(owner.sessionId, code, String(++this.sequence)),
      code,
      message: diagnosticError(new Error(message), this.options.secrets)
        .message,
      severity: 'warning',
      ...(retryable === undefined ? {} : { retryable }),
    })
  }
  async initialize(
    origin: string,
    auth: { username: string; password: string } | undefined,
    load: boolean,
  ) {
    this.live()
    const authorization = auth
      ? `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`
      : undefined
    this.http = new OpenCodeHttp(
      origin,
      this.session.cwd,
      authorization,
      this.limits,
      [
        ...(this.options.secrets ?? []),
        ...(auth ? [auth.password, authorization!] : []),
      ],
    )
    for (;;) {
      this.live()
      try {
        const health = object(
          (
            await this.http.request('/global/health', 'GET', undefined, {
              deadline: Math.min(
                this.startupDeadline,
                performance.now() + this.limits.healthMs,
              ),
            })
          ).value,
        )
        if (health.healthy !== true)
          throw fault('HEALTH', 'Native server is not healthy')
        if (health.version !== '1.18.26')
          throw fault(
            'VERSION_UNSUPPORTED',
            'Native OpenCode version is unsupported',
          )
        break
      } catch (error) {
        if (
          error instanceof OpenCodeError &&
          error.code === 'OPENCODE_VERSION_UNSUPPORTED'
        )
          throw error
        if (performance.now() >= this.startupDeadline)
          throw fault('STARTUP_TIMEOUT', 'Native startup deadline expired')
        await delay(
          Math.min(
            this.limits.healthPollMs,
            this.startupDeadline - performance.now(),
          ),
          undefined,
          { signal: this.controller.signal },
        )
      }
    }
    const native = object(
      (
        await this.http.request(
          load
            ? this.path(this.session.binding!.providerSessionId!)
            : '/session',
          load ? 'GET' : 'POST',
          load ? undefined : {},
          { deadline: this.startupDeadline },
        )
      ).value,
    )
    const id = nativeId(native.id, 'ses', this.limits.idBytes)
    const paths = object(
      (
        await this.http.request('/path', 'GET', undefined, {
          deadline: this.startupDeadline,
        })
      ).value,
    )
    if (
      (load && id !== this.session.binding!.providerSessionId) ||
      native.directory !== this.session.cwd ||
      paths.directory !== this.session.cwd
    )
      throw fault(
        'RESUME_SCOPE_MISMATCH',
        'Native session identity or directory does not match',
      )
    this.confirmed = confirmedNativeBindingSchema.parse({
      provider: this.options.provider,
      accountId: this.options.accountId,
      cwd: this.session.cwd,
      providerSessionId: id,
    })
    if (this.options.server.mode === 'attached')
      this.attached = freeze({
        origin,
        connectionId: this.options.server.connectionId,
        provider: this.options.provider,
        accountId: this.options.accountId,
        cwd: this.session.cwd,
        providerSessionId: id,
      })
    this.nativeModels.put('selection', { current: this.sessionModel(native) })
    await this.discover(this.startupDeadline)
    await this.connect(this.startupDeadline)
    const baseline = await this.history(id, this.startupDeadline, true)
    for (const row of baseline.rows) {
      this.historical.put(tuple(id, row.info.id), true)
      this.recordUserModel(row.info)
    }
    this.catalog = freeze({
      ...this.catalog,
      history: baseline.cursor
        ? { availability: 'partial', nextCursor: baseline.cursor }
        : { availability: 'complete' },
    })
    const children = array(
      (
        await this.http.request(`${this.path(id)}/children`, 'GET', undefined, {
          deadline: this.startupDeadline,
        })
      ).value,
      this.limits.childCount,
    )
    const status = object(
      (
        await this.http.request('/session/status', 'GET', undefined, {
          deadline: this.startupDeadline,
        })
      ).value,
    )
    if (!this.idle(status, id))
      throw fault('RESUME_BUSY', 'Native root already has active work')
    for (const childValue of children) {
      const child = object(childValue)
      const childId = nativeId(child.id, 'ses')
      this.knownChildren.put(childId, 'historical')
      if (!this.idle(status, childId))
        throw fault(
          'OWNERSHIP_GAP',
          'Native child has no retained invocation owner',
        )
    }
    for (const kind of ['question', 'permission'] as const) {
      const pending = array(
        (
          await this.http.request(`/${kind}`, 'GET', undefined, {
            deadline: this.startupDeadline,
          })
        ).value,
        this.limits.ownerCount,
      )
      if (
        pending.some(
          (value) =>
            object(value).sessionID === id ||
            this.knownChildren.has(String(object(value).sessionID)),
        )
      )
        throw fault(
          'RESUME_BUSY',
          'Native session has unowned pending requests',
        )
    }
    this.live()
    if (!this.stream || this.stream.closed || this.recovering)
      throw fault(
        'STREAM_GAP',
        'Native stream closed before initialization completed',
      )
    this.initialized = true
  }
  private async discover(deadline: number, commandsOnly = false) {
    let models = this.catalog.models
    if (!commandsOnly) {
      const providers = object(
        (
          await this.http.request('/provider', 'GET', undefined, {
            metadata: true,
            deadline,
          })
        ).value,
      )
      const connected = new Set(
        array(providers.connected ?? [], this.limits.providerCount).map((id) =>
          string(id),
        ),
      )
      const extracted: OpenCodeDiscovery['models'][number][] = []
      for (const raw of array(providers.all, this.limits.providerCount)) {
        const provider = object(raw)
        const providerID = string(provider.id)
        for (const [modelKey, rawModel] of Object.entries(
          object(provider.models),
        )) {
          if (extracted.length >= this.limits.modelCount)
            throw fault(
              'CAPACITY',
              'Native model catalog exceeds its count limit',
            )
          const model = object(rawModel)
          const modelID = string(model.id ?? modelKey)
          if (model.providerID !== undefined && model.providerID !== providerID)
            throw fault('PROTOCOL', 'Native model provider does not match')
          const variants = Object.keys(object(model.variants ?? {}))
          if (variants.length > this.limits.variantCount)
            throw fault('CAPACITY', 'Native model has too many variants')
          variants.forEach((variant) => string(variant))
          const input = Object.entries(object(object(model.capabilities).input))
            .filter(([, supported]) => supported === true)
            .map(([kind]) => string(kind))
          const context = object(model.limit).context
          if (
            context !== undefined &&
            (typeof context !== 'number' ||
              !Number.isSafeInteger(context) ||
              context < 0)
          )
            throw fault('PROTOCOL', 'Native model has an invalid context limit')
          extracted.push({
            id: `${providerID}/${modelID}`,
            displayName: string(model.name, 4096),
            providerID,
            modelID,
            connected: connected.has(providerID),
            variants,
            input,
            ...(context !== undefined
              ? { contextWindow: context as number }
              : {}),
          })
        }
      }
      models = extracted
    }
    const agents = array(
      (
        await this.http.request('/agent', 'GET', undefined, {
          metadata: true,
          deadline,
        })
      ).value,
      this.limits.agentCount,
    ).map((raw): Agent => {
      const agent = object(raw)
      bound(agent, this.limits.metadataBytes, 'Native agent response')
      const model = agent.model ? object(agent.model) : undefined
      const result = {
        name: string(agent.name),
        mode: string(agent.mode),
        ...(agent.hidden !== undefined
          ? { hidden: agent.hidden === true }
          : {}),
        ...(model
          ? { model: `${string(model.providerID)}/${string(model.modelID)}` }
          : {}),
        ...(agent.variant ? { variant: string(agent.variant) } : {}),
      }
      bound(result, this.limits.agentBytes, 'Native agent metadata')
      return result
    })
    const config = object(
      (
        await this.http.request('/config', 'GET', undefined, {
          metadata: true,
          deadline,
        })
      ).value,
    )
    const defaultAgent =
      config.default_agent === undefined
        ? undefined
        : string(config.default_agent)
    const commands = array(
      (
        await this.http.request('/command', 'GET', undefined, {
          metadata: true,
          deadline,
        })
      ).value,
      this.limits.commandCount,
    ).map((raw): OpenCodeDiscovery['commands'][number] => {
      const cmd = object(raw)
      bound(cmd, this.limits.commandBytes, 'Native command metadata')
      const agentName = cmd.agent === undefined ? undefined : string(cmd.agent)
      const eligible = agents.filter(
        (agent) =>
          agent.hidden !== true && ['primary', 'all'].includes(agent.mode),
      )
      const agent = agentName
        ? agents.find((item) => item.name === agentName)
        : defaultAgent
          ? agents.find((item) => item.name === defaultAgent)
          : eligible.length === 1
            ? eligible[0]
            : undefined
      const model = cmd.model === undefined ? undefined : string(cmd.model)
      const configuredModel = model ?? (agentName ? agent?.model : undefined)
      const unavailableReason =
        cmd.subtask === true || agent?.mode === 'subagent'
          ? 'subtask'
          : !agent ||
              !['primary', 'all'].includes(agent.mode) ||
              (!agentName && defaultAgent && agent.hidden === true)
            ? 'agent-mode-unknown'
            : configuredModel &&
                !models.some((entry) => entry.id === configuredModel)
              ? 'model-unknown'
              : undefined
      const source = cmd.source
      if (
        source !== undefined &&
        !['command', 'mcp', 'skill'].includes(String(source))
      )
        throw fault('PROTOCOL', 'Invalid native command source')
      return {
        name: string(cmd.name),
        ...(cmd.description !== undefined
          ? { description: string(cmd.description, this.limits.commandBytes) }
          : {}),
        ...(agentName ? { agent: agentName } : {}),
        ...(model ? { model } : {}),
        ...(source ? { source: source as 'command' | 'mcp' | 'skill' } : {}),
        ...(cmd.subtask !== undefined ? { subtask: cmd.subtask === true } : {}),
        hints: array(cmd.hints, 128).map((hint) => string(hint, 4096)),
        executable: !unavailableReason,
        ...(unavailableReason ? { unavailableReason } : {}),
        ...(agent && ['primary', 'all'].includes(agent.mode)
          ? {
              effectiveAgent: {
                name: agent.name,
                mode: agent.mode as 'primary' | 'all',
              },
            }
          : {}),
        ...(configuredModel ? { configuredModel } : {}),
      }
    })
    this.live()
    this.budget.put(
      'discovery',
      { models, commands, agents },
      this.limits.discoveryBytes,
    )
    this.agents = agents
    this.defaultAgent = defaultAgent
    this.catalog = freeze({
      ...this.catalog,
      models,
      commands,
      warnings: [
        {
          code: 'OPENCODE_CATALOG_PROVENANCE',
          message:
            'Native catalog connection flags do not prove credential identity or paid access',
        },
      ],
    })
  }
  private validateModel(model: string) {
    const found = this.catalog.models.find((entry) => entry.id === model)
    if (!found)
      throw fault(
        'MODEL_UNKNOWN',
        'Selected native model is unavailable in this catalog',
      )
    return found
  }
  private validateVariant(model: string | undefined, variant: string) {
    if (!model || !this.validateModel(model).variants.includes(variant))
      throw fault(
        'VARIANT_UNSUPPORTED',
        'Selected native variant is unavailable for the effective model',
      )
  }
  private commandFor(input: PromptInput[]) {
    const first = input[0]
    if (first?.type !== 'text') return
    const match = /^\/([^\s]+)(?:([\s])([\s\S]*))?$/.exec(first.text)
    if (!match) return
    const command = this.catalog.commands.find((cmd) => cmd.name === match[1])
    if (!command) return
    if (input.slice(1).some((part) => part.type !== 'attachment'))
      throw fault(
        'COMMAND_INPUT_UNSUPPORTED',
        'Native command input cannot contain interleaved text',
      )
    if (!command.executable)
      throw fault(
        command.unavailableReason === 'subtask'
          ? 'COMMAND_SUBTASK_UNSUPPORTED'
          : command.unavailableReason === 'model-unknown'
            ? 'MODEL_UNKNOWN'
            : 'COMMAND_AGENT_UNKNOWN',
        'Native command execution mode or model is unsupported',
      )
    return { command, arguments: match[3] ?? '' }
  }
  private admit(
    inputValue: PromptInput[] | string,
    optionsValue: DispatchOptions | undefined,
    identity: { runId: string; turnId: string } | undefined,
    queue: boolean,
  ) {
    this.live()
    if (
      !this.initialized ||
      this.frozen ||
      this.recovering ||
      this.stream?.closed
    )
      throw fault('BUSY', 'Native session is not ready for input')
    const busy =
      !!this.active ||
      !!this.actualRead ||
      !!this.cancelWork ||
      [...this.automaticOwners.values()].some((entry) => !entry.settled)
    if (busy && !queue)
      throw fault('BUSY', 'Native session already owns foreground input')
    const raw =
      typeof inputValue === 'string'
        ? [{ type: 'text', text: inputValue }]
        : inputValue
    if (
      !Array.isArray(raw) ||
      raw.length === 0 ||
      raw.length > this.limits.inputCount
    )
      throw fault('INPUT_UNSUPPORTED', 'Native input has an invalid part count')
    bound(raw, this.limits.inputBytes, 'Native input')
    const input = raw.map((part) => promptInputSchema.parse(part))
    if (input.some((part) => part.type === 'review_reference'))
      throw fault(
        'INPUT_UNSUPPORTED',
        'Native review references are unsupported',
      )
    const attachments = input.filter((part) => part.type === 'attachment')
    if (attachments.length > this.limits.attachmentCount)
      throw fault('CAPACITY', 'Too many native attachments')
    if (
      attachments.some((part) => !mimes.has(part.mime)) ||
      (attachments.length > 0 && !this.options.resolveAttachment)
    )
      throw fault(
        'UNSUPPORTED_ATTACHMENT',
        'Native attachment type or resolver is unavailable',
      )
    bound(optionsValue, this.limits.inputBytes, 'Native dispatch options')
    const options = dispatchOptionsSchema.parse(optionsValue ?? {})
    if (
      options.approvalPolicy != null ||
      options.sandboxPolicy != null ||
      options.serviceTier != null
    )
      throw fault(
        'OPTION_UNSUPPORTED',
        'Codex-specific controls are unsupported by OpenCode',
      )
    let model = options.model ?? this.localModel ?? this.options.defaults?.model
    let modelSource: Ticket['modelSource'] =
      options.model != null
        ? 'per-call'
        : this.localModel !== undefined
          ? 'handle'
          : model !== undefined
            ? 'factory/account'
            : undefined
    if (model === '' || options.reasoning === '')
      throw fault(
        'OPTION_UNSUPPORTED',
        'Explicit native model and variant names must not be empty',
      )
    const variant =
      options.reasoning ?? this.localVariant ?? this.options.defaults?.variant
    const parsed = this.commandFor(input)
    if (parsed?.command.configuredModel) {
      if (model && model !== parsed.command.configuredModel)
        throw fault(
          'COMMAND_MODEL_CONFLICT',
          'Configured command model conflicts with the explicit Forge model',
        )
      model = parsed.command.configuredModel
      modelSource = parsed.command.model ? 'command' : 'command-agent'
    }
    if (model) {
      this.validateModel(model)
      if (variant) this.validateVariant(model, variant)
      for (const attachment of attachments)
        this.validateAttachmentModel(model, attachment.mime)
    }
    const runId = identity ? string(identity.runId) : randomUUID()
    const turnId = identity ? string(identity.turnId) : randomUUID()
    const key = tuple(runId, turnId)
    if (this.tickets.has(key))
      throw fault(
        'IDENTITY_CONFLICT',
        'Receipt identity was already accepted in this generation',
      )
    const command = parsed
      ? { name: parsed.command.name, arguments: parsed.arguments }
      : undefined
    const descriptorBytes = bytes([input, options, model, variant, command])
    bound(
      [input, options],
      busy ? this.limits.queueBytes : this.limits.inputBytes,
      'Native input',
    )
    if (
      busy &&
      (this.queue.length >= this.limits.queueCount ||
        this.queuedBytes + descriptorBytes > this.limits.queueBytes)
    )
      throw fault('CAPACITY', 'Native input queue exceeds its limit')
    const userId = newNativeId('msg')
    const receiptId = randomUUID()
    const completion = createCompletionHandle({
      completionId: receiptId,
      runId,
      turnId,
    })
    const receipt = { receiptId, runId, turnId, completion: completion.handle }
    const ticket: Ticket = {
      runId,
      turnId,
      userId,
      sessionId: this.rootId(),
      receipt,
      settle: completion.settle,
      input,
      options,
      model,
      modelSource,
      variant,
      started: false,
      submitted: false,
      acceptedHttp: false,
      settled: false,
      cancelled: false,
      controller: new AbortController(),
      descriptorBytes,
      command,
    }
    // All allocation and budget checks precede visible acceptance or ownership insertion.
    this.tickets.put(key, ticket, { runId, turnId, userId, receiptId })
    try {
      this.inputs.put(key, ticket)
      this.owners.put(tuple(ticket.sessionId, userId), {
        runId,
        turnId,
        userId,
        sessionId: ticket.sessionId,
      })
    } catch (error) {
      this.tickets.delete(key)
      this.inputs.delete(key)
      throw error
    }
    if (busy) {
      this.queue.push(ticket)
      this.queuedBytes += descriptorBytes
    } else this.active = ticket
    if (
      ![...this.tickets.values()].some(
        (other) => other !== ticket && other.runId === runId,
      )
    )
      this.publish(ticket, { type: 'run_started' })
    this.publish(ticket, { type: 'prompt_accepted', receiptId })
    if (!busy) void this.dispatch(ticket)
    return receipt
  }
  private validateAttachmentModel(model: string | undefined, mime: string) {
    const capability = mime.startsWith('image/')
      ? 'image'
      : mime === 'application/pdf'
        ? 'pdf'
        : 'text'
    if (!model || !this.validateModel(model).input.includes(capability))
      throw fault(
        'UNSUPPORTED_ATTACHMENT',
        'Effective native model does not advertise this attachment input',
      )
  }
  private owns(ticket: Ticket) {
    return (
      !this.retired &&
      this.active === ticket &&
      !ticket.cancelled &&
      !ticket.settled &&
      !ticket.controller.signal.aborted
    )
  }
  private async dispatch(ticket: Ticket) {
    const key = tuple(ticket.runId, ticket.turnId)
    try {
      if (!this.owns(ticket)) return
      this.physicalWork.put(key, true)
      if (this.reconcileWork) await this.reconcileWork
      if (!this.owns(ticket)) return
      if (ticket.command) {
        await this.discover(performance.now() + this.limits.httpMs, true)
        if (!this.owns(ticket)) return
        const current = this.commandFor(ticket.input)
        if (
          !current ||
          current.command.name !== ticket.command.name ||
          (current.command.configuredModel &&
            ticket.model !== current.command.configuredModel)
        )
          throw fault(
            'COMMAND_MODEL_CONFLICT',
            'Native command metadata changed before submission',
          )
      }
      if (!ticket.model) await this.refreshSessionModel(ticket)
      if (!this.owns(ticket)) return
      let effectiveModel = ticket.model ?? this.nativeModel
      if (ticket.variant) this.validateVariant(effectiveModel, ticket.variant)
      const deadlineAt = performance.now() + this.limits.preparationMs
      ticket.preparationDeadline = deadlineAt
      ticket.preparationTimer = setTimeout(() => {
        ticket.controller.abort()
        if (this.actualRead)
          void this.retire(
            fault(
              'ATTACHMENT_PREPARATION_STUCK',
              'Native attachment resolver remains pending at its preparation deadline',
            ),
          )
        else if (!ticket.submitted && !ticket.settled)
          this.settleTicket(ticket, {
            status: 'failed',
            code: 'OPENCODE_PREPARATION_TIMEOUT',
            message: 'Native input preparation deadline expired',
          })
      }, this.limits.preparationMs)
      const parts: Record<string, unknown>[] = []
      let attachmentBytes = 0
      for (const input of ticket.input) {
        if (!this.owns(ticket)) return
        if (input.type === 'text') {
          if (!ticket.command)
            parts.push({
              id: newNativeId('prt'),
              type: 'text',
              text: input.text,
            })
          continue
        }
        if (input.type !== 'attachment')
          throw fault('INPUT_UNSUPPORTED', 'Unsupported native input')
        if (!ticket.model && this.nativeModels.get('selection')?.dirty) {
          await this.refreshSessionModel(ticket)
          if (!this.owns(ticket)) return
          effectiveModel = this.nativeModel
        }
        this.validateAttachmentModel(effectiveModel, input.mime)
        const maxBytes = Math.min(
          this.limits.attachmentBytes,
          this.limits.attachmentsBytes - attachmentBytes,
        )
        if (maxBytes <= 0)
          throw fault('CAPACITY', 'Native attachments exceed their byte limit')
        // The read slot belongs to this exact Promise, including after cancellation.
        let work: Promise<
          Awaited<
            ReturnType<NonNullable<OpenCodeAdapterOptions['resolveAttachment']>>
          >
        >
        try {
          work = Promise.resolve().then(() =>
            this.options.resolveAttachment!({
              sessionId: this.session.id,
              provider: this.options.provider,
              accountId: this.options.accountId,
              cwd: this.session.cwd,
              attachmentId: input.attachmentId,
              mime: input.mime,
              signal: ticket.controller.signal,
              deadlineAt,
              maxBytes,
            }),
          )
        } catch (error) {
          throw fault(
            'ATTACHMENT_RESOLVER',
            diagnosticError(error, this.options.secrets).message,
          )
        }
        this.actualRead = work
        let result: Awaited<typeof work>
        try {
          result = await work
        } finally {
          if (this.actualRead === work) this.actualRead = undefined
        }
        const validBytes =
          result?.bytes instanceof Uint8Array &&
          result.bytes.byteLength <= maxBytes
        if (!this.owns(ticket)) {
          const validLateResult =
            validBytes &&
            result.attachmentId === input.attachmentId &&
            result.mime === input.mime &&
            result.sizeBytes === result.bytes.byteLength &&
            typeof result.filename === 'string' &&
            bytes(result.filename) <= 4096
          if (!validLateResult) {
            if (this.retired)
              this.catalog = freeze({
                ...this.catalog,
                warnings: [
                  ...this.catalog.warnings,
                  {
                    code: 'OPENCODE_ATTACHMENT_RESOLVER_CONTRACT',
                    message:
                      'Late attachment output exceeded its resolver contract and was discarded',
                  },
                ],
              })
            else
              this.diagnostic(
                ticket,
                'OPENCODE_ATTACHMENT_RESOLVER_CONTRACT',
                'Late native attachment bytes exceed the resolver contract',
              )
          }
          return
        }
        if (
          !validBytes ||
          result.attachmentId !== input.attachmentId ||
          result.mime !== input.mime ||
          !Number.isSafeInteger(result.sizeBytes) ||
          result.sizeBytes !== result.bytes.byteLength ||
          result.sizeBytes < 0
        )
          throw fault(
            'ATTACHMENT_RESOLVER_CONTRACT',
            'Native attachment resolver returned mismatched metadata or bytes',
          )
        string(result.filename, 4096)
        if (input.mime === 'text/plain')
          new TextDecoder('utf8', { fatal: true }).decode(result.bytes)
        attachmentBytes += result.bytes.byteLength
        parts.push({
          id: newNativeId('prt'),
          type: 'file',
          mime: result.mime,
          filename: result.filename,
          url: `data:${result.mime};base64,${Buffer.from(result.bytes).toString('base64')}`,
        })
      }
      if (!this.owns(ticket) || performance.now() >= deadlineAt) return
      clearTimeout(ticket.preparationTimer)
      ticket.preparationTimer = undefined
      const body: Record<string, unknown> = {
        messageID: ticket.userId,
        ...(ticket.variant ? { variant: ticket.variant } : {}),
        parts,
      }
      if (ticket.command)
        Object.assign(body, {
          command: ticket.command.name,
          arguments: ticket.command.arguments,
          ...(ticket.model ? { model: ticket.model } : {}),
        })
      else if (ticket.model) {
        const slash = ticket.model.indexOf('/')
        body.model = {
          providerID: ticket.model.slice(0, slash),
          modelID: ticket.model.slice(slash + 1),
        }
      }
      bound(body, this.limits.bodyBytes, 'Native prompt body')
      if (!this.owns(ticket) || this.recovering || this.frozen || !this.stream)
        throw fault('BUSY', 'Native input lost its dispatch reservation')
      const status = object((await this.http.request('/session/status')).value)
      if (!this.owns(ticket)) return
      if (
        this.recovering ||
        this.frozen ||
        !this.stream ||
        this.stream.closed ||
        this.unknown.size
      )
        throw fault(
          'BUSY',
          'Native ownership changed during the submission barrier',
        )
      if (!this.idle(status, this.rootId()))
        throw fault(
          'EXTERNAL_ACTIVITY',
          'Native work started outside this receipt',
        )
      const epoch = this.eventEpoch
      if (!ticket.model) await this.refreshSessionModel(ticket)
      if (!this.owns(ticket)) return
      if (
        epoch !== this.eventEpoch ||
        this.recovering ||
        this.frozen ||
        !this.stream ||
        this.stream.closed ||
        this.unknown.size
      )
        throw fault('BUSY', 'Native ownership changed during model validation')
      effectiveModel = ticket.model ?? this.nativeModel
      if (ticket.variant) this.validateVariant(effectiveModel, ticket.variant)
      for (const input of ticket.input)
        if (input.type === 'attachment')
          this.validateAttachmentModel(effectiveModel, input.mime)
      ticket.submitted = true
      const deadline =
        performance.now() +
        (ticket.command ? this.limits.commandMs : this.limits.httpMs)
      if (ticket.command) {
        ticket.commandDeadline = deadline
        ticket.commandTimer = setTimeout(() => {
          if (!ticket.settled && !this.retired)
            void this.retire(
              fault(
                'DELIVERY_UNKNOWN',
                'Native command exceeded its absolute response deadline',
              ),
            )
        }, this.limits.commandMs)
      } else
        ticket.activityTimer = setTimeout(() => {
          if (!ticket.started && !ticket.settled)
            void this.uncertain(
              ticket,
              fault('DELIVERY_UNKNOWN', 'Native prompt has no proved activity'),
            )
        }, this.limits.activityMs)
      const result = await this.http.request(
        `${this.path(this.rootId())}/${ticket.command ? 'command' : 'prompt_async'}`,
        'POST',
        body,
        { deadline, signal: ticket.controller.signal },
      )
      ticket.httpSettled = true
      if (this.retired || ticket.settled || ticket.cancelled) return
      ticket.acceptedHttp = true
      if (ticket.command) {
        const response = snapshot(result.value, this.limits)
        if (
          response.info.sessionID !== ticket.sessionId ||
          response.info.parentID !== ticket.userId ||
          (effectiveModel &&
            response.info.model &&
            response.info.model !== effectiveModel)
        )
          throw fault(
            'OWNERSHIP_GAP',
            'Native command result does not belong to the submitted user and model',
          )
        this.applySnapshot(response)
      } else if (result.status !== 204)
        throw fault(
          'PROTOCOL',
          'Native prompt did not return its asynchronous acceptance status',
        )
      this.markDirty(ticket.sessionId, true)
    } catch (error) {
      ticket.httpSettled = true
      if (this.retired || ticket.settled) return
      if (ticket.cancelled && this.cancelWork) return
      if (
        error instanceof OpenCodeError &&
        [
          'OPENCODE_EXTERNAL_ACTIVITY',
          'OPENCODE_OWNERSHIP_GAP',
          'OPENCODE_HISTORY_GAP',
        ].includes(error.code)
      ) {
        await this.retire(error)
        return
      }
      if (
        ticket.submitted &&
        (ticket.command ||
          !(
            error instanceof OpenCodeError &&
            [400, 401, 403, 404, 422].includes(error.status ?? 0)
          ))
      )
        await this.uncertain(ticket, error)
      else
        this.settleTicket(
          ticket,
          ticket.cancelled
            ? {
                status: 'interrupted',
                reason: 'Cancelled before native delivery',
              }
            : this.failure(error),
        )
    } finally {
      this.physicalWork.delete(key)
      if (ticket.settled) this.compactTicket(ticket)
      if (this.retired && !this.physicalWork.size) this.budget.clear()
      if (!this.actualRead) {
        clearTimeout(ticket.preparationTimer)
        ticket.preparationTimer = undefined
        if (ticket.settled && this.active === ticket) this.active = undefined
        this.drain()
      }
    }
  }
  private settleTicket(ticket: Ticket, outcome: TerminalOutcome) {
    if (ticket.settled) return
    ticket.settled = true
    clearTimeout(ticket.activityTimer)
    clearTimeout(ticket.commandTimer)
    clearTimeout(this.errorTimers.get(ticket.sessionId))
    this.errorTimers.delete(ticket.sessionId)
    if (!this.actualRead) clearTimeout(ticket.preparationTimer)
    this.publish(ticket, { type: 'turn_completed', outcome })
    ticket.settle!({ ...outcome, runId: ticket.runId, turnId: ticket.turnId })
    ticket.receipt = undefined
    ticket.settle = undefined
    this.events.release(ticket)
    ticket.outcome = outcome
    if (this.physicalWork.has(tuple(ticket.runId, ticket.turnId)))
      this.inputs.put(tuple(ticket.runId, ticket.turnId), ticket, {
        ...ticket,
        controller: undefined,
        activityTimer: undefined,
        commandTimer: undefined,
        preparationTimer: undefined,
      })
    this.compactTicket(ticket)
    if (
      this.active === ticket &&
      !this.physicalWork.has(tuple(ticket.runId, ticket.turnId))
    )
      this.active = undefined
  }
  private compactTicket(ticket: Ticket) {
    const key = tuple(ticket.runId, ticket.turnId)
    if (this.physicalWork.has(key)) return
    this.inputs.delete(key)
    ticket.input = []
    ticket.options = { permissionMode: 'manual' }
    ticket.command = undefined
    clearTimeout(ticket.activityTimer)
    clearTimeout(ticket.commandTimer)
    clearTimeout(ticket.preparationTimer)
    ticket.activityTimer = undefined
    ticket.commandTimer = undefined
    ticket.preparationTimer = undefined
    if (!this.retired)
      this.tickets.put(key, {
        runId: ticket.runId,
        turnId: ticket.turnId,
        userId: ticket.userId,
        sessionId: ticket.sessionId,
        model: ticket.model,
        settled: true,
        outcome: ticket.outcome!,
      })
    else this.tickets.delete(key)
  }
  private drain() {
    if (
      this.retired ||
      this.active ||
      this.actualRead ||
      this.frozen ||
      this.recovering ||
      this.cancelWork ||
      this.reconcileWork ||
      [...this.automaticOwners.values()].some((entry) => !entry.settled) ||
      !this.queue.length
    )
      return
    const ticket = this.queue.shift()!
    this.queuedBytes -= ticket.descriptorBytes
    this.active = ticket
    void this.dispatch(ticket)
  }
  private failure(
    error: unknown,
  ): Extract<TerminalOutcome, { status: 'failed' }> {
    return {
      status: 'failed',
      code:
        error instanceof OpenCodeError ? error.code : 'OPENCODE_RUNTIME_ERROR',
      message: diagnosticError(error, this.options.secrets).message,
    }
  }

  private async connect(deadline: number) {
    this.live()
    const stream = this.http.connect((value) => this.frame(value), deadline)
    this.stream = stream
    await stream.ready
    this.live()
    void stream.done.then((error) => {
      if (!this.retired && this.stream === stream && !this.recovering) {
        if (
          error instanceof OpenCodeError &&
          [
            'OPENCODE_OWNERSHIP_GAP',
            'OPENCODE_EXTERNAL_ACTIVITY',
            'OPENCODE_CAPACITY',
          ].includes(error.code)
        )
          void this.retire(error)
        else void this.recover(error)
      }
    })
  }
  private frame(value: unknown): boolean {
    this.live()
    bound(value, this.limits.eventBytes, 'Native event')
    const event = envelope(value, this.limits)
    const { id, type, properties: props } = event.payload
    if (type === 'server.connected') return true
    if (
      event.directory !== this.session.cwd ||
      type.startsWith('session.next.')
    )
      return false
    const digest = stableId(JSON.stringify(event))
    const seen = this.dedup.get(id)
    if (seen) {
      if (seen !== digest)
        throw fault('PROTOCOL', 'Native event ID has conflicting content')
      return false
    }
    this.dedup.put(id, digest)
    this.sourceSuffix.clear()
    if (!this.confirmed) return false
    const sessionId =
      props.sessionID === undefined
        ? undefined
        : nativeId(props.sessionID, 'ses', this.limits.idBytes)
    if (type === 'session.updated') {
      const info = object(props.info)
      if (sessionId !== nativeId(info.id, 'ses', this.limits.idBytes))
        throw fault('PROTOCOL', 'Native session event identity disagrees')
      if (sessionId !== this.rootId()) return false
      this.sessionModel(info)
      this.sessionObservations++
      // SSE can replay older snapshots. Read current Session state before using its model.
      const selection = this.nativeModels.get('selection')
      if (!selection?.dirty)
        this.nativeModels.put('selection', { ...selection, dirty: true })
      return false
    }
    if (type === 'session.created') {
      const info = object(props.info)
      if (sessionId !== nativeId(info.id, 'ses'))
        throw fault('PROTOCOL', 'Native session event identity disagrees')
      if (
        info.parentID &&
        (this.ownedSession(String(info.parentID)) ||
          this.knownChildren.get(String(info.parentID)) === 'created') &&
        this.initialized &&
        !this.recovering
      ) {
        if (!this.knownChildren.has(sessionId!))
          this.knownChildren.put(sessionId!, 'created')
        this.markDirty(String(info.parentID), true)
      }
      return false
    }
    if (!sessionId) {
      if (type === 'session.error' && this.active)
        this.diagnostic(
          this.active,
          'OPENCODE_UNSCOPED_ERROR',
          'Native error has no proved session owner',
        )
      return false
    }
    if (!this.ownedSession(sessionId) && !this.knownChildren.has(sessionId))
      return false
    if (type === 'message.updated') {
      const info = messageInfo(props.info, this.limits)
      if (info.sessionID !== sessionId)
        throw fault('PROTOCOL', 'Native message event session disagrees')
      this.eventEpoch++
      const owner = this.messageOwner(info)
      if (owner && !this.recovering) this.applyInfo(info, owner, id)
      else this.holdUnknown(sessionId, info.id)
      this.markDirty(sessionId, false)
    } else if (type === 'message.part.updated') {
      if (typeof props.time !== 'number' || !Number.isFinite(props.time))
        throw fault('PROTOCOL', 'Native part update has no valid time')
      const part = partInfo(props.part, this.limits)
      if (
        part.sessionID !== sessionId ||
        (props.messageID !== undefined && props.messageID !== part.messageID)
      )
        throw fault('PROTOCOL', 'Native part event identity disagrees')
      this.eventEpoch++
      const info = this.events.messages.get(tuple(sessionId, part.messageID))
      const owner = info && this.messageOwner(info)
      if (owner && !this.recovering && !this.snapshotOnly.has(sessionId))
        this.applyPart(part, info.role, owner, id)
      else if (!owner) this.holdUnknown(sessionId, part.messageID)
      this.markDirty(sessionId, false)
    } else if (type === 'message.part.delta') {
      const messageId = nativeId(props.messageID, 'msg')
      const partId = nativeId(props.partID, 'prt')
      if (typeof props.delta !== 'string' || typeof props.field !== 'string')
        throw fault('PROTOCOL', 'Invalid native part delta')
      bound(props.delta, this.limits.textBytes, 'Native text delta')
      this.eventEpoch++
      if (
        props.field !== 'text' ||
        this.recovering ||
        this.snapshotOnly.has(sessionId) ||
        !this.events.delta(sessionId, messageId, partId, props.delta, id)
      ) {
        this.snapshotOnly.add(sessionId)
        this.holdUnknown(sessionId, messageId)
        this.markDirty(sessionId, false)
      }
    } else if (type === 'session.status' || type === 'session.idle') {
      const status =
        type === 'session.idle' ? { type: 'idle' } : object(props.status)
      if (!['idle', 'busy', 'retry'].includes(String(status.type)))
        throw fault('PROTOCOL', 'Invalid native session status')
      this.eventEpoch++
      if (status.type === 'retry') {
        const owner = this.sessionOwner(sessionId)
        if (owner)
          this.diagnostic(
            owner,
            'OPENCODE_RETRY',
            typeof status.message === 'string'
              ? status.message
              : 'Native provider will retry',
            true,
          )
      }
      this.markDirty(sessionId, status.type === 'idle')
    } else if (type === 'session.error') {
      bound(props.error, this.limits.errorBytes, 'Native session error')
      const owner = this.sessionOwner(sessionId)
      if (owner)
        this.diagnostic(
          owner,
          'OPENCODE_SESSION_ERROR',
          'Native session reported an error; checking its exact message owner',
        )
      if (owner && !this.errorTimers.has(sessionId)) {
        const timer = setTimeout(() => {
          this.errorTimers.delete(sessionId)
          const ticket = this.tickets.get(tuple(owner.runId, owner.turnId))
          const child = owner.childId
            ? this.children.get(owner.childId)
            : undefined
          if (
            !this.retired &&
            (child ? !child.finished : ticket && !ticket.settled)
          )
            void this.retire(
              fault(
                'OWNERSHIP_GAP',
                'Native session error has no proved terminal message',
              ),
            )
        }, this.limits.ownershipMs)
        this.errorTimers.set(sessionId, timer)
      }
      this.markDirty(sessionId, true)
      if (sessionId === this.rootId() && this.active && !this.active.started)
        void this.uncertain(
          this.active,
          fault(
            'DELIVERY_UNKNOWN',
            'Native session failed before user ownership was proved',
          ),
        )
    } else if (type === 'question.asked' || type === 'permission.asked') {
      this.eventEpoch++
      if (!this.recovering && this.initialized)
        this.registerRequest(
          type === 'question.asked' ? 'question' : 'permission',
          props,
          id,
        )
      this.markDirty(sessionId, true)
    } else if (
      ['question.replied', 'question.rejected', 'permission.replied'].includes(
        type,
      )
    ) {
      this.eventEpoch++
      const requestId = nativeId(
        props.requestID,
        type.startsWith('question') ? 'que' : 'per',
      )
      const record = this.requests.get(
        tuple(
          sessionId,
          type.startsWith('question') ? 'question' : 'permission',
          requestId,
        ),
      )
      if (record && record.state !== 'sending')
        this.expireRequest(
          record,
          'Native request resolved outside this reply slot',
        )
      this.markDirty(sessionId, true)
    } else if (type === 'message.removed' || type === 'message.part.removed') {
      this.eventEpoch++
      this.snapshotOnly.add(sessionId)
      this.markDirty(sessionId, true)
    } else if (type === 'todo.updated') {
      const owner = this.sessionOwner(sessionId)
      const todos = array(props.todos, this.limits.inputCount)
      for (const value of todos) {
        const todo = object(value)
        if (
          typeof todo.content !== 'string' ||
          typeof todo.status !== 'string' ||
          typeof todo.priority !== 'string'
        )
          throw fault('PROTOCOL', 'Native todo fields are invalid')
      }
      const text = JSON.stringify(todos)
      bound(text, this.limits.inputBytes, 'Native todo content')
      // V1 has no step IDs. Preserve its complete array as replaceable plan content.
      // The display consumer owns readable task rendering; this is never approval.
      if (owner) {
        const itemId = stableId(owner.sessionId, owner.userId, 'todo')
        const digest = stableId(text)
        if (this.todos.get(itemId) === digest) return false
        this.todos.put(itemId, digest)
        this.publish(
          owner,
          {
            type: 'content_snapshot',
            contentType: 'plan',
            itemId,
            text,
          },
          id,
        )
      }
    }
    return false
  }
  private ownedSession(id: string) {
    return (
      id === this.confirmed?.providerSessionId ||
      [...this.children.values()].some(
        (child) => child.sessionId === id && child.proved,
      )
    )
  }
  private sessionOwner(id: string): EventOwner | undefined {
    if (id === this.rootId())
      return this.active?.started ? this.active : undefined
    return [...this.children.values()].find(
      (child) => child.sessionId === id && child.proved && !child.finished,
    )
  }
  private messageOwner(info: NativeMessage) {
    return this.owners.get(
      tuple(
        info.sessionID,
        info.role === 'assistant' ? info.parentID! : info.id,
      ),
    )
  }
  private applyInfo(info: NativeMessage, owner: EventOwner, source?: string) {
    const key = tuple(info.sessionID, info.id)
    const existing = this.owners.get(key)
    if (existing && existing.userId !== owner.userId)
      throw fault(
        'OWNERSHIP_GAP',
        'Native message has conflicting receipt owners',
      )
    this.owners.put(key, owner, {
      sessionId: info.sessionID,
      messageId: info.id,
      runId: owner.runId,
      turnId: owner.turnId,
      userId: owner.userId,
      childId: owner.childId,
    })
    const ticket = this.tickets.get(tuple(owner.runId, owner.turnId))
    if (
      !owner.childId &&
      ticket &&
      'submitted' in ticket &&
      !ticket.started &&
      !ticket.settled
    ) {
      if (!ticket.submitted)
        throw fault(
          'EXTERNAL_ACTIVITY',
          'Native user appeared before its authorized submission',
        )
      ticket.started = true
      clearTimeout(ticket.activityTimer)
      this.publish(ticket, { type: 'turn_started' }, source)
    }
    if (
      ticket &&
      ticket.model &&
      info.model &&
      ticket.model !== info.model &&
      !owner.childId
    )
      throw fault(
        'OWNERSHIP_GAP',
        'Native message model conflicts with its submitted model',
      )
    this.events.message(info, owner, source)
    this.recordUserModel(info)
    this.unknown.delete(key)
    clearTimeout(this.unknownTimers.get(key))
    this.unknownTimers.delete(key)
  }
  private applyPart(
    part: NativePart,
    role: 'user' | 'assistant',
    owner: EventOwner,
    source?: string,
  ) {
    this.events.part(part, owner, role, source)
    if (part.type === 'tool' && part.tool === 'task')
      this.taskChild(part, owner)
  }
  private applySnapshot(row: Snapshot, source?: string) {
    const owner = this.messageOwner(row.info)
    if (!owner) return false
    this.applyInfo(row.info, owner, source)
    for (const part of row.parts)
      this.applyPart(part, row.info.role, owner, source)
    return true
  }
  private holdUnknown(sessionId: string, messageId: string) {
    if (!this.initialized || this.historical.has(tuple(sessionId, messageId)))
      return
    const key = tuple(sessionId, messageId)
    if (this.unknown.has(key)) return
    this.unknown.put(key, true)
    const timer = setTimeout(() => {
      this.unknownTimers.delete(key)
      if (!this.retired && this.unknown.has(key))
        void this.retire(
          fault(
            'OWNERSHIP_GAP',
            'Native message ownership could not be recovered before its deadline',
          ),
        )
    }, this.limits.ownershipMs)
    this.unknownTimers.set(key, timer)
    this.snapshotOnly.add(sessionId)
  }
  private idle(status: Record<string, unknown>, id: string) {
    if (!Object.hasOwn(status, id)) return true
    const state = object(status[id])
    if (!['idle', 'busy', 'retry'].includes(String(state.type)))
      throw fault('PROTOCOL', 'Invalid native status snapshot')
    return state.type === 'idle'
  }
  private async history(
    sessionId: string,
    deadline: number,
    baseline = false,
    capacity = { pages: 0, messages: 0, bytes: 0 },
  ) {
    const rows = new Map<string, Snapshot>()
    const cursors = new Set<string>()
    let cursor: string | undefined
    for (;;) {
      this.live()
      if (++capacity.pages > this.limits.historyPages)
        throw fault('HISTORY_GAP', 'Native history exceeds its page budget')
      const page = await this.http.request(
        `${this.path(sessionId)}/message?limit=100${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`,
        'GET',
        undefined,
        { deadline },
      )
      this.live()
      capacity.bytes += page.bytes
      if (capacity.bytes > this.limits.historyBytes)
        throw fault('HISTORY_GAP', 'Native history exceeds its byte budget')
      const parsed = array(page.value, 100).map((row) =>
        snapshot(row, this.limits),
      )
      const ids = new Set<string>()
      let previous: NativeMessage | undefined
      for (const row of parsed) {
        if (
          row.info.sessionID !== sessionId ||
          ids.has(row.info.id) ||
          (previous && compareMessages(row.info, previous) < 0)
        )
          throw fault(
            'HISTORY_GAP',
            'Native history order or identity disagrees',
          )
        ids.add(row.info.id)
        previous = row.info
        const old = rows.get(row.info.id)
        if (old && JSON.stringify(old) !== JSON.stringify(row))
          throw fault(
            'HISTORY_GAP',
            'Native history changed across overlapping pages',
          )
        if (!old) {
          rows.set(row.info.id, row)
          capacity.messages++
        }
      }
      if (capacity.messages > this.limits.historyMessages)
        throw fault('HISTORY_GAP', 'Native history exceeds its message budget')
      const next = page.headers.get('x-next-cursor')
      if (!next) break
      cursor = string(next, this.limits.cursorBytes)
      if (cursors.has(cursor) || !parsed.length)
        throw fault('HISTORY_GAP', 'Native history cursor did not advance')
      cursors.add(cursor)
      if (
        baseline &&
        (capacity.pages >= this.limits.historyPages ||
          capacity.messages >= this.limits.historyMessages)
      )
        return {
          rows: [...rows.values()].sort((a, b) =>
            compareMessages(a.info, b.info),
          ),
          cursor,
        }
      // Stop only once every retained owner boundary for this session is covered.
      const anchors = [...this.owners.values()]
        .filter((owner) => owner.sessionId === sessionId)
        .map((owner) => owner.userId)
      if (
        !baseline &&
        anchors.length &&
        anchors.every((anchor) => rows.has(anchor))
      )
        break
    }
    return {
      rows: [...rows.values()].sort((a, b) => compareMessages(a.info, b.info)),
      cursor: undefined,
    }
  }
  private markDirty(id: string, immediate: boolean) {
    if (this.retired || !this.initialized) return
    if (!this.dirty.has(id) && this.dirty.size >= this.limits.jobCount)
      throw fault('CAPACITY', 'Native metadata queue is full')
    bound([...this.dirty, id], this.limits.jobBytes, 'Native metadata jobs')
    this.dirty.add(id)
    if (immediate) this.immediateDirty.add(id)
    if (this.recovering || this.reconcileWork) return
    if (immediate) {
      clearTimeout(this.dirtyTimer)
      this.dirtyTimer = undefined
      void this.reconcile().catch((error) => this.retire(error))
    } else if (!this.dirtyTimer)
      this.dirtyTimer = setTimeout(() => {
        this.dirtyTimer = undefined
        void this.reconcile().catch((error) => this.retire(error))
      }, 1000)
  }
  private reconcile(deadline = performance.now() + this.limits.recoveryMs) {
    if (this.reconcileWork) return this.reconcileWork
    const work = this.reconcileLoop(deadline)
    this.reconcileWork = work
    void work
      .finally(() => {
        if (this.reconcileWork === work) this.reconcileWork = undefined
        if (this.dirty.size && !this.retired && !this.recovering)
          this.markDirty(this.dirty.values().next().value!, false)
        this.drain()
      })
      .catch(() => {})
    return work
  }
  private async reconcileLoop(deadline: number) {
    const capacity = { pages: 0, messages: 0, bytes: 0 }
    do {
      this.live()
      if (performance.now() >= deadline)
        throw fault(
          'HISTORY_GAP',
          'Native history did not converge before its deadline',
        )
      const pending = [...this.dirty]
      this.dirty.clear()
      this.immediateDirty.clear()
      for (const id of pending) {
        if (!this.ownedSession(id)) continue
        const epoch = this.eventEpoch
        const history = await this.history(id, deadline, false, capacity)
        this.live()
        this.events.verifyNoDeletion(history.rows, id)
        for (const info of this.events.messages.values())
          if (
            info.sessionID === id &&
            !history.rows.some((row) => row.info.id === info.id)
          )
            throw fault(
              'HISTORY_GAP',
              'Native history removed an owned message',
            )
        for (const row of history.rows) {
          if (this.historical.has(tuple(id, row.info.id))) continue
          if (!this.applySnapshot(row)) {
            if (row.info.role === 'user') this.automatic(row)
            if (!this.applySnapshot(row) && id === this.rootId())
              throw fault(
                this.options.server.mode === 'attached'
                  ? 'EXTERNAL_ACTIVITY'
                  : 'OWNERSHIP_GAP',
                'Native history contains input without an exact owner',
              )
          }
        }
        await this.proveChildren(deadline, capacity)
        await this.reconcileRequests(deadline)
        this.live()
        const status = object(
          (
            await this.http.request('/session/status', 'GET', undefined, {
              deadline,
            })
          ).value,
        )
        this.live()
        if (epoch !== this.eventEpoch) {
          this.dirty.add(id)
          if (this.idle(status, id)) this.immediateDirty.add(id)
          continue
        }
        if (this.idle(status, id)) this.completeFromHistory(id, history.rows)
      }
      if (this.dirty.size && !this.immediateDirty.size && !this.recovering)
        return
    } while (this.dirty.size)
  }
  private automatic(row: Snapshot) {
    if (this.options.server.mode !== 'owned' || row.info.role !== 'user') return
    // This is an explicit native compaction boundary, never a synthetic-text guess.
    const relation = row.parts.find(
      (part) =>
        part.type === 'compaction' &&
        part.auto === true &&
        typeof part.tail_start_id === 'string' &&
        this.owners.has(tuple(row.info.sessionID, part.tail_start_id)),
    )
    if (!relation) return
    const owner = {
      sessionId: row.info.sessionID,
      userId: row.info.id,
      runId: stableId(this.generation, row.info.id, 'automatic-run'),
      turnId: stableId(this.generation, row.info.id, 'automatic-turn'),
    }
    this.owners.put(tuple(owner.sessionId, owner.userId), owner)
    this.automaticOwners.put(tuple(owner.runId, owner.turnId), {
      owner,
      settled: false,
      sourceUserId: this.owners.get(
        tuple(row.info.sessionID, String(relation.tail_start_id)),
      )!.userId,
    })
    this.publish(owner, { type: 'run_started' })
    this.publish(owner, { type: 'turn_started' })
  }
  private completeFromHistory(id: string, rows: Snapshot[]) {
    if ([...this.requests.values()].some((request) => request.sessionId === id))
      return
    const ticket = this.active
    if (
      id === this.rootId() &&
      ticket?.submitted &&
      !ticket.cancelled &&
      ticket.started &&
      (!ticket.command || ticket.httpSettled)
    ) {
      const outcome = this.events.terminal(rows, ticket.userId)
      if (outcome) this.settleTicket(ticket, outcome)
    }
    for (const child of this.children.values()) {
      if (child.sessionId !== id || !child.proved || child.finished) continue
      const outcome = this.events.terminal(rows, child.userId)
      if (outcome) this.finishChild(child, outcome)
    }
    for (const entry of this.automaticOwners.values()) {
      if (entry.owner.sessionId !== id || entry.settled) continue
      const outcome = this.events.terminal(rows, entry.owner.userId)
      if (outcome) {
        entry.settled = true
        this.publish(entry.owner, { type: 'turn_completed', outcome })
      }
    }
    if (
      id === this.rootId() &&
      ticket &&
      !ticket.settled &&
      [...this.automaticOwners.values()].some(
        (entry) => entry.settled && entry.sourceUserId === ticket.userId,
      )
    )
      throw fault(
        'OWNERSHIP_GAP',
        'Automatic native work cannot replace the caller terminal result',
      )
  }
  private async uncertain(ticket: Ticket, reason: unknown) {
    if (this.retired || ticket.settled || this.uncertaintyWork) return
    this.frozen = true
    this.snapshotOnly.add(ticket.sessionId)
    const work = (async () => {
      const deadline = Math.min(
        performance.now() + this.limits.recoveryMs,
        ticket.commandDeadline ?? Infinity,
      )
      try {
        this.dirty.add(ticket.sessionId)
        await this.reconcile(deadline)
        this.live()
        if (ticket.started) {
          this.frozen = false
          return
        }
        throw fault(
          'DELIVERY_UNKNOWN',
          'Native delivery remains unknown after bounded reconciliation',
        )
      } catch (error) {
        await this.retire(
          error instanceof OpenCodeError &&
            ['OPENCODE_OWNERSHIP_GAP', 'OPENCODE_EXTERNAL_ACTIVITY'].includes(
              error.code,
            )
            ? error
            : fault(
                'DELIVERY_UNKNOWN',
                diagnosticError(reason, this.options.secrets).message,
              ),
        )
      }
    })()
    this.uncertaintyWork = work
    try {
      await work
    } finally {
      this.uncertaintyWork = undefined
      this.drain()
    }
  }
  private async recover(reason: Error) {
    if (this.retired || this.recovering) return
    this.recovering = true
    this.stream?.close()
    for (const owner of this.owners.values()) {
      this.snapshotOnly.add(owner.sessionId)
      this.dirty.add(owner.sessionId)
    }
    const reported = new Set<string>()
    for (const owner of this.owners.values())
      if (!reported.has(owner.runId)) {
        reported.add(owner.runId)
        this.diagnostic(
          owner,
          'OPENCODE_STREAM_GAP',
          'Native stream lost events; snapshots cannot recover every transient event',
        )
      }
    const deadline = performance.now() + this.limits.recoveryMs
    try {
      await this.reconcileWork
      for (let attempt = 0; ; attempt++) {
        if (
          attempt >= this.limits.reconnectAttempts ||
          performance.now() >= deadline
        )
          throw fault('HISTORY_GAP', 'Native stream recovery deadline expired')
        try {
          await this.connect(deadline)
          break
        } catch {
          this.stream?.close()
          this.live()
        }
      }
      this.live()
      for (const id of new Set([
        this.rootId(),
        ...[...this.children.values()]
          .filter((child) => child.proved)
          .map((child) => child.sessionId),
      ])) {
        const discovered = array(
          (
            await this.http.request(
              `${this.path(id)}/children`,
              'GET',
              undefined,
              { deadline },
            )
          ).value,
          this.limits.childCount,
        )
        const status = object(
          (
            await this.http.request('/session/status', 'GET', undefined, {
              deadline,
            })
          ).value,
        )
        this.live()
        for (const raw of discovered) {
          const child = object(raw)
          const childId = nativeId(child.id, 'ses')
          if (!this.ownedSession(childId)) {
            if (!this.idle(status, childId))
              throw fault(
                'OWNERSHIP_GAP',
                'Recovered native child has no retained invocation owner',
              )
            if (!this.knownChildren.has(childId))
              this.knownChildren.put(childId, 'historical')
          }
        }
      }
      await this.reconcile(deadline)
      await this.reconcileRequests(deadline)
      this.live()
      if (!this.stream || this.stream.closed)
        throw fault(
          'HISTORY_GAP',
          'Native recovery stream closed during reconciliation',
        )
      this.recovering = false
      this.drain()
    } catch (error) {
      await this.retire(
        error instanceof OpenCodeError && error.code !== 'OPENCODE_STREAM_GAP'
          ? error
          : fault(
              'HISTORY_GAP',
              diagnosticError(reason, this.options.secrets).message,
            ),
      )
    }
  }
  private taskChild(part: NativePart, owner: EventOwner) {
    const state = object(part.state)
    const metadata = state.metadata === undefined ? {} : object(state.metadata)
    if (!metadata.sessionId) return
    const sessionId = nativeId(metadata.sessionId, 'ses')
    const parentSessionId = nativeId(metadata.parentSessionId, 'ses')
    if (parentSessionId !== part.sessionID)
      throw fault(
        'OWNERSHIP_GAP',
        'Native task parent does not match its owning message',
      )
    const taskKey = tuple(part.sessionID, part.messageID, string(part.callID))
    const childId = stableId(taskKey, sessionId)
    if (this.children.has(childId)) return
    if (
      sessionId === this.rootId() ||
      sessionId === part.sessionID ||
      [...this.children.values()].some((child) => child.sessionId === sessionId)
    )
      throw fault(
        'OWNERSHIP_GAP',
        'Native child session reuse has no exact new user boundary',
      )
    const parent = owner.childId ? this.children.get(owner.childId) : undefined
    const depth = (parent?.depth ?? 0) + 1
    if (
      depth > this.limits.childDepth ||
      [...this.children.values()].filter((child) => !child.finished).length >=
        this.limits.childLiveCount
    )
      throw fault('CAPACITY', 'Native child invocation limit reached')
    const child: Child = {
      ...owner,
      sessionId,
      userId: '',
      childId,
      parentChildId: owner.childId,
      id: childId,
      taskKey,
      parentSessionId,
      parentToolCallId: stableId(
        part.sessionID,
        part.messageID,
        String(part.callID),
      ),
      proved: false,
      finished: false,
      depth,
      deadline: performance.now() + this.limits.ownershipMs,
    }
    this.children.put(childId, child)
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      if (!child.proved && !this.retired)
        void this.retire(
          fault(
            'OWNERSHIP_GAP',
            'Native child invocation has no proved user boundary',
          ),
        )
    }, this.limits.ownershipMs)
    this.timers.add(timer)
    this.markDirty(parentSessionId, true)
  }
  private async proveChildren(
    deadline: number,
    capacity: { pages: number; messages: number; bytes: number },
  ) {
    for (const child of this.children.values()) {
      if (child.proved) continue
      const boundDeadline = Math.min(deadline, child.deadline)
      const native = object(
        (
          await this.http.request(
            this.path(child.sessionId),
            'GET',
            undefined,
            { deadline: boundDeadline },
          )
        ).value,
      )
      this.live()
      if (
        native.id !== child.sessionId ||
        native.directory !== this.session.cwd
      )
        throw fault('OWNERSHIP_GAP', 'Native child identity disagrees')
      child.ancestry = nativeId(native.parentID, 'ses')
      if (
        this.knownChildren.get(child.sessionId) === 'historical' ||
        child.ancestry !== child.parentSessionId
      )
        throw fault(
          'OWNERSHIP_GAP',
          'Native reused child has no exact task-to-user proof',
        )
      if (this.knownChildren.get(child.sessionId) !== 'created') continue
      const history = await this.history(
        child.sessionId,
        boundDeadline,
        true,
        capacity,
      )
      this.live()
      const users = history.rows.filter((row) => row.info.role === 'user')
      if (history.cursor || users.length > 1)
        throw fault(
          'OWNERSHIP_GAP',
          'Native child history cannot prove its first invocation boundary',
        )
      if (!users.length) continue
      child.userId = users[0]!.info.id
      child.proved = true
      this.children.put(child.id, child)
      this.owners.put(tuple(child.sessionId, child.userId), child)
      this.publish(child, {
        type: 'child_started',
        itemId: child.id,
        childId: child.id,
        parentToolCallId: child.parentToolCallId,
        ...(child.parentChildId ? { parentChildId: child.parentChildId } : {}),
        description: 'Native task',
      })
      for (const row of history.rows)
        if (!this.applySnapshot(row))
          throw fault(
            'OWNERSHIP_GAP',
            'Native child content has an unknown user owner',
          )
      this.dirty.add(child.sessionId)
    }
  }
  private finishChild(child: Child, outcome: TerminalOutcome) {
    if (child.finished) return
    child.finished = true
    clearTimeout(this.errorTimers.get(child.sessionId))
    this.errorTimers.delete(child.sessionId)
    this.publish(child, {
      type: 'child_finished',
      itemId: child.id,
      childId: child.id,
      outcome,
    })
    this.events.release(child)
  }

  private registerRequest(
    kind: 'question' | 'permission',
    value: unknown,
    source?: string,
  ) {
    const native = object(value)
    bound(native, this.limits.requestBytes, 'Native request')
    const sessionId = nativeId(native.sessionID, 'ses')
    const nativeRequestId = nativeId(
      native.id,
      kind === 'question' ? 'que' : 'per',
    )
    const tool = native.tool === undefined ? undefined : object(native.tool)
    const messageId = tool ? nativeId(tool.messageID, 'msg') : undefined
    const owner = messageId
      ? this.owners.get(tuple(sessionId, messageId))
      : this.sessionOwner(sessionId)
    if (!owner) {
      if (this.ownedSession(sessionId)) this.markDirty(sessionId, true)
      return
    }
    const key = tuple(sessionId, kind, nativeRequestId)
    const digest = stableId(JSON.stringify(native))
    const old = this.requests.get(key)
    if (old) {
      if (old.digest !== digest)
        throw fault(
          'PROTOCOL',
          'Native request changed under the same resolver ID',
        )
      return
    }
    if (this.dedup.has(tuple('request', key))) return
    const id = stableId(this.generation, key)
    const request: PendingRequest = {
      key,
      id,
      nativeId: nativeRequestId,
      sessionId,
      kind,
      owner,
      native,
      digest,
      state: 'pending',
      expires: performance.now() + this.limits.requestLifetimeMs,
      timer: undefined!,
    }
    let mapped: Record<string, unknown>
    if (kind === 'question') {
      const questions = array(native.questions, this.limits.questionCount).map(
        (raw, index) => {
          const question = object(raw)
          const options = array(question.options, this.limits.optionCount).map(
            (rawOption, optionIndex) => {
              const option = object(rawOption)
              return {
                id: `o${optionIndex}`,
                label: string(option.label, this.limits.requestBytes),
                ...(option.description === undefined
                  ? {}
                  : {
                      description: string(
                        option.description,
                        this.limits.requestBytes,
                      ),
                    }),
              }
            },
          )
          if (
            (question.multiple !== undefined &&
              typeof question.multiple !== 'boolean') ||
            (question.custom !== undefined &&
              typeof question.custom !== 'boolean')
          )
            throw fault('PROTOCOL', 'Native question flags are invalid')
          return {
            id: `q${index}`,
            question: string(question.question, this.limits.requestBytes),
            ...(question.header === undefined
              ? {}
              : { header: string(question.header, this.limits.requestBytes) }),
            options,
            multiSelect: question.multiple ?? false,
            allowFreeInput: question.custom ?? true,
          }
        },
      )
      if (!questions.length)
        throw fault('PROTOCOL', 'Native request contains no questions')
      request.questionMap = questions.map((question) => ({
        labels: question.options.map((option) => option.label),
        multiple: question.multiSelect as boolean,
        custom: question.allowFreeInput as boolean,
      }))
      mapped = { requestId: id, isBlocking: true, questions }
    } else {
      const permission = string(native.permission, this.limits.requestBytes)
      const patterns = array(native.patterns, 128).map((pattern) =>
        string(pattern, this.limits.requestBytes),
      )
      const always = array(native.always, 128).map((pattern) =>
        string(pattern, this.limits.requestBytes),
      )
      mapped = {
        requestId: id,
        toolCallId: tool
          ? stableId(sessionId, messageId!, string(tool.callID))
          : null,
        title: permission,
        detail: JSON.stringify({ permission, patterns, always }),
        options: [
          { id: 'once', label: 'Allow once' },
          { id: 'always', label: 'Allow matching requests' },
          { id: 'reject', label: 'Deny' },
        ],
      }
    }
    try {
      this.requests.put(key, request, {
        key,
        id,
        nativeId: nativeRequestId,
        sessionId,
        kind,
        native,
        digest,
        expires: request.expires,
        questionMap: request.questionMap,
        owner: {
          runId: owner.runId,
          turnId: owner.turnId,
          userId: owner.userId,
          sessionId: owner.sessionId,
          childId: owner.childId,
        },
      })
    } catch (error) {
      if (
        !(error instanceof OpenCodeError) ||
        error.code !== 'OPENCODE_CAPACITY' ||
        this.overflowingRequest
      )
        throw error
      this.overflowingRequest = true
      this.frozen = true
      void this.http
        .request(
          `/${kind}/${encodeURIComponent(nativeRequestId)}/${kind === 'question' ? 'reject' : 'reply'}`,
          'POST',
          kind === 'permission' ? { reply: 'reject' } : undefined,
          { lane: 'reply' },
        )
        .catch(() => {})
        .finally(() => this.retire(error))
      return
    }
    request.timer = setTimeout(() => {
      void this.expireNativeRequest(request)
    }, this.limits.requestLifetimeMs)
    this.publish(
      owner,
      {
        type:
          kind === 'question' ? 'question_requested' : 'permission_requested',
        itemId: id,
        request: mapped,
      },
      source,
    )
  }
  private async reconcileRequests(deadline: number) {
    for (const kind of ['question', 'permission'] as const) {
      const list = array(
        (await this.http.request(`/${kind}`, 'GET', undefined, { deadline }))
          .value,
        this.limits.ownerCount,
      )
      this.live()
      const present = new Set<string>()
      for (const raw of list) {
        const native = object(raw)
        const sessionId = nativeId(native.sessionID, 'ses')
        const id = nativeId(native.id, kind === 'question' ? 'que' : 'per')
        if (!this.ownedSession(sessionId)) continue
        present.add(tuple(sessionId, kind, id))
        this.registerRequest(kind, native)
      }
      for (const request of this.requests.values())
        if (
          request.kind === kind &&
          request.state !== 'sending' &&
          !present.has(request.key)
        )
          this.expireRequest(request, 'Native request is no longer pending')
    }
  }
  private requestFor(id: string, kind: 'question' | 'permission') {
    this.live()
    const request = [...this.requests.values()].find(
      (entry) => entry.id === id && entry.kind === kind,
    )
    if (!request || request.expires <= performance.now())
      throw fault('REQUEST_EXPIRED', 'Native request is no longer answerable')
    if (request.state !== 'pending')
      throw fault(
        'REQUEST_BUSY',
        'Native reply is already submitted or uncertain',
      )
    return request
  }
  private replyQuestion(id: string, answers: Record<string, QuestionAnswer>) {
    const request = this.requestFor(id, 'question')
    const map = request.questionMap!
    bound(answers, this.limits.replyBytes, 'Native question answers')
    if (
      !answers ||
      Object.keys(answers).length !== map.length ||
      Object.keys(answers).some(
        (key) => !/^q\d+$/.test(key) || Number(key.slice(1)) >= map.length,
      )
    )
      throw fault(
        'REPLY_INVALID',
        'Reply must contain every original question exactly once',
      )
    const ordered = map.map((question, index) => {
      const answer = object(answers[`q${index}`])
      const labels: string[] = []
      if (answer.type === 'skipped') return labels
      if (
        !['selected', 'free_text', 'selected_with_text'].includes(
          String(answer.type),
        )
      )
        throw fault('REPLY_INVALID', 'Invalid native question answer')
      if (answer.type !== 'free_text') {
        const options = array(answer.optionIds, this.limits.optionCount)
        if (new Set(options).size !== options.length)
          throw fault('REPLY_INVALID', 'Question reply repeats an option')
        for (const option of options) {
          if (
            typeof option !== 'string' ||
            !/^o\d+$/.test(option) ||
            `o${Number(option.slice(1))}` !== option ||
            !Object.hasOwn(question.labels, Number(option.slice(1)))
          )
            throw fault(
              'REPLY_INVALID',
              'Question reply contains an unknown option',
            )
          labels.push(question.labels[Number(option.slice(1))]!)
        }
      }
      if (answer.type !== 'selected') {
        if (!question.custom || typeof answer.text !== 'string')
          throw fault(
            'REPLY_INVALID',
            'Native question does not permit this free text',
          )
        labels.push(answer.text)
      }
      if (!question.multiple && labels.length > 1)
        throw fault('REPLY_INVALID', 'Native question accepts only one answer')
      return labels
    })
    return this.replyRequest(id, 'question', { answers: ordered })
  }
  private replyPermission(reply: PermissionReply) {
    this.requestFor(reply.requestId, 'permission')
    const raw = reply as unknown as Record<string, unknown>
    if (
      reply.type === 'granted' ||
      Object.hasOwn(raw, 'grant') ||
      Object.hasOwn(raw, 'scope')
    )
      throw fault(
        'REPLY_INVALID',
        'Native permission cannot represent a structured grant',
      )
    if (reply.type === 'denied')
      return this.replyRequest(reply.requestId, 'permission', {
        reply: 'reject',
        ...(reply.reason === undefined ? {} : { message: reply.reason }),
      })
    if (
      reply.type !== 'selected' ||
      !['once', 'always', 'reject'].includes(reply.optionId)
    )
      throw fault('REPLY_INVALID', 'Native permission option is invalid')
    return this.replyRequest(reply.requestId, 'permission', {
      reply: reply.optionId,
    })
  }
  private async replyRequest(
    id: string,
    kind: 'question' | 'permission',
    body: unknown,
    reject = false,
    deadline = performance.now() + this.limits.httpMs,
  ) {
    const request = this.requestFor(id, kind)
    bound(body, this.limits.replyBytes, 'Native reply')
    request.state = 'sending'
    let submitted = false
    try {
      const list = array(
        (await this.http.request(`/${kind}`, 'GET', undefined, { deadline }))
          .value,
        this.limits.ownerCount,
      )
      this.live()
      if (
        !this.requests.has(request.key) ||
        performance.now() >= request.expires ||
        !list.some(
          (raw) =>
            object(raw).id === request.nativeId &&
            object(raw).sessionID === request.sessionId,
        )
      ) {
        this.expireRequest(request, 'Native request disappeared before reply')
        throw fault('REQUEST_EXPIRED', 'Native request is no longer answerable')
      }
      submitted = true
      const result = await this.http.request(
        `/${kind}/${encodeURIComponent(request.nativeId)}/${kind === 'question' && reject ? 'reject' : 'reply'}`,
        'POST',
        body,
        { deadline, lane: 'reply' },
      )
      this.live()
      if (result.status !== 200 || result.value !== true)
        throw fault('PROTOCOL', 'Native reply did not confirm resolution')
      this.consumeRequest(request)
      this.markDirty(request.sessionId, true)
    } catch (error) {
      if (this.retired || !this.requests.has(request.key)) throw error
      if (
        !submitted ||
        (error instanceof OpenCodeError && error.status === 400)
      ) {
        request.state = 'pending'
        await this.reconcileRequests(deadline)
        throw error
      }
      if (error instanceof OpenCodeError && error.status === 404) {
        this.expireRequest(request, 'Native request was not found')
        throw error
      }
      request.state = 'uncertain'
      const recoveryDeadline = Math.min(
        deadline + this.limits.recoveryMs,
        performance.now() + this.limits.recoveryMs,
      )
      try {
        while (
          this.requests.has(request.key) &&
          performance.now() < recoveryDeadline
        ) {
          await this.reconcileRequests(recoveryDeadline)
          if (this.requests.has(request.key))
            await delay(
              Math.min(100, Math.max(1, recoveryDeadline - performance.now())),
              undefined,
              { signal: this.controller.signal },
            )
        }
        if (this.requests.has(request.key))
          await this.retire(
            fault(
              'REPLY_UNKNOWN',
              'Native reply remains uncertain; another write is not safe',
            ),
          )
      } catch (recoveryError) {
        await this.retire(recoveryError)
      }
      throw fault('REPLY_UNKNOWN', 'Native reply outcome is unknown')
    }
  }
  private consumeRequest(request: PendingRequest) {
    if (!this.requests.has(request.key)) return
    if (!this.retired) this.dedup.put(tuple('request', request.key), 'retired')
    clearTimeout(request.timer)
    this.requests.delete(request.key)
  }
  private expireRequest(request: PendingRequest, reason: string) {
    if (!this.requests.has(request.key)) return
    this.publish(request.owner, {
      type: 'request_cancelled',
      itemId: request.id,
      requestId: request.id,
      reason,
    })
    this.consumeRequest(request)
  }
  private async expireNativeRequest(request: PendingRequest) {
    if (this.retired || !this.requests.has(request.key)) return
    try {
      if (request.state !== 'pending')
        throw fault(
          'REPLY_UNKNOWN',
          'Expired native reply has an uncertain submission',
        )
      request.state = 'sending'
      const result = await this.http.request(
        `/${request.kind}/${encodeURIComponent(request.nativeId)}/${request.kind === 'question' ? 'reject' : 'reply'}`,
        'POST',
        request.kind === 'permission' ? { reply: 'reject' } : undefined,
        { lane: 'reply' },
      )
      this.live()
      if (result.value !== true)
        throw fault(
          'REPLY_UNKNOWN',
          'Expired native request did not confirm rejection',
        )
      this.expireRequest(request, 'Native request expired')
      this.markDirty(request.sessionId, true)
    } catch (error) {
      await this.retire(error)
    }
  }
  private cancel() {
    if (this.cancelWork) return this.cancelWork
    this.live()
    const ticket = this.active
    if (!ticket) return Promise.resolve()
    ticket.cancelled = true
    ticket.controller.abort()
    const work = this.cancelTurn(ticket)
    this.cancelWork = work
    void work
      .finally(() => {
        this.cancelWork = undefined
        this.drain()
      })
      .catch(() => {})
    return work
  }
  private async cancelTurn(ticket: Ticket) {
    if (!ticket.submitted) {
      this.settleTicket(ticket, {
        status: 'interrupted',
        reason: 'Cancelled before native delivery',
      })
      return
    }
    const deadline = performance.now() + this.limits.abortMs
    const owned = new Set([
      ticket.sessionId,
      ...[...this.children.values()]
        .filter(
          (child) =>
            child.proved &&
            !child.finished &&
            child.runId === ticket.runId &&
            child.turnId === ticket.turnId,
        )
        .map((child) => child.sessionId),
    ])
    try {
      // Reply attempts and abort share the original budget. A parked reply cannot block abort.
      const rejection = (async () => {
        for (const request of this.requests.values())
          if (owned.has(request.sessionId) && request.state === 'pending') {
            try {
              await this.replyRequest(
                request.id,
                request.kind,
                request.kind === 'permission' ? { reply: 'reject' } : undefined,
                request.kind === 'question',
                deadline,
              )
            } catch {
              /* Abort still has to run. */
            }
          }
      })()
      for (const id of owned) {
        await this.http.request(`${this.path(id)}/abort`, 'POST', undefined, {
          deadline,
          lane: 'reply',
        })
        this.live()
      }
      await rejection
      for (;;) {
        this.live()
        const status = object(
          (
            await this.http.request('/session/status', 'GET', undefined, {
              deadline,
            })
          ).value,
        )
        if ([...owned].every((id) => this.idle(status, id))) break
        if (performance.now() >= deadline)
          throw fault(
            'ABORT_UNKNOWN',
            'Native abort did not reach idle before its deadline',
          )
        await delay(
          Math.min(100, Math.max(1, deadline - performance.now())),
          undefined,
          { signal: this.controller.signal },
        )
      }
      if (ticket.command && !ticket.started)
        throw fault(
          'DELIVERY_UNKNOWN',
          'Cancellation cannot prove pre-user command shell work stopped',
        )
      for (const request of this.requests.values())
        if (owned.has(request.sessionId))
          this.expireRequest(request, 'Native turn was cancelled')
      for (const child of this.children.values())
        if (owned.has(child.sessionId) && child.proved && !child.finished)
          this.finishChild(child, {
            status: 'interrupted',
            reason: 'Native turn was cancelled',
          })
      this.settleTicket(ticket, {
        status: 'interrupted',
        reason: 'Native turn was cancelled',
      })
    } catch (error) {
      await this.retire(error)
    }
  }
  async retire(reason: unknown) {
    if (this.closing) return this.closing
    if (this.retired) return
    const safe =
      reason instanceof OpenCodeError
        ? new OpenCodeError(
            reason.code,
            diagnosticError(reason, this.options.secrets).message,
            reason.status,
          )
        : diagnosticError(reason, this.options.secrets)
    this.retired = safe
    this.initialized = false
    this.controller.abort()
    this.options.signal?.removeEventListener('abort', this.onAbort)
    this.stream?.close()
    this.http?.close()
    clearTimeout(this.dirtyTimer)
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    for (const timer of this.unknownTimers.values()) clearTimeout(timer)
    this.unknownTimers.clear()
    for (const timer of this.errorTimers.values()) clearTimeout(timer)
    this.errorTimers.clear()
    for (const ticket of this.tickets.values()) {
      if (!('controller' in ticket)) continue
      ticket.controller.abort()
      clearTimeout(ticket.activityTimer)
      clearTimeout(ticket.commandTimer)
      if (!this.actualRead || ticket !== this.active)
        clearTimeout(ticket.preparationTimer)
      if (!ticket.settled) this.settleTicket(ticket, this.failure(safe))
    }
    for (const request of this.requests.values())
      this.expireRequest(request, 'Native runtime retired')
    for (const child of this.children.values())
      if (child.proved && !child.finished)
        this.finishChild(child, {
          status: 'interrupted',
          reason: 'Native runtime retired',
        })
    for (const entry of this.automaticOwners.values())
      if (!entry.settled) {
        entry.settled = true
        this.publish(entry.owner, {
          type: 'turn_completed',
          outcome: this.failure(safe),
        })
      }
    this.finish(safe)
    this.queue = []
    this.queuedBytes = 0
    this.dirty.clear()
    this.immediateDirty.clear()
    this.snapshotOnly.clear()
    this.sourceSuffix.clear()
    this.events.clear()
    this.owners.clear()
    this.historical.clear()
    for (const key of this.tickets.keys())
      if (!this.physicalWork.has(key)) this.tickets.delete(key)
    for (const key of this.inputs.keys())
      if (!this.physicalWork.has(key)) this.inputs.delete(key)
    this.children.clear()
    this.requests.clear()
    this.dedup.clear()
    this.unknown.clear()
    this.knownChildren.clear()
    this.automaticOwners.clear()
    this.nativeModels.clear()
    this.todos.clear()
    // Actual dispatch callbacks retain their ticket charge until their final continuation.
    if (!this.physicalWork.size) this.budget.clear()
    const close = this.process?.close(safe) ?? Promise.resolve()
    this.closing = close
    await close
  }
}
