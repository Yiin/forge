import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import {
  dispatchOptionsSchema,
  permissionReplySchema,
  questionAnswerSchema,
  type TerminalOutcome,
  type QuestionRequest,
} from '@forge/protocol/harness'
import { NativeProcess } from '../process.js'
import { JsonlTransport } from '../jsonl.js'
import { diagnosticError, positiveLimit } from '../diagnostics.js'
import {
  createCompletionHandle,
  type HarnessAdapter,
  type HarnessHandle,
  type HarnessSession,
  type HarnessEvent,
  type HarnessReceipt,
  type ConfirmedNativeBinding,
  type DispatchOptions,
  type PromptInput,
  type PermissionReply,
  type QuestionAnswer,
  type SessionConfigOption,
} from '../types.js'
import {
  AttachmentWork,
  prepareInput,
  validateInput,
  type LoadAttachment,
} from './input.js'
import { ClaudeNormalizer } from './normalize.js'
import {
  Identities,
  LIMITS,
  MiB,
  answerQuestions,
  denyResponse,
  maybeObject,
  object,
  parseCatalog,
  questionRequest,
  requiredString,
  string,
  successResponse,
  type ClaudeCatalog,
  type ObjectValue,
  type Owner,
  type EventBody,
} from './wire.js'

export type ClaudeAdapterOptions = {
  command?: string
  args?: string[]
  env?: NodeJS.ProcessEnv
  accountId?: string | null
  secrets?: readonly string[]
  loadAttachment?: LoadAttachment
  startupTimeoutMs?: number
  controlTimeoutMs?: number
  interruptGraceMs?: number
  attributionTimeoutMs?: number
}
export type ClaudeHandle = HarnessHandle & { readonly catalog: ClaudeCatalog }
type Turn = Owner & {
  completion: ReturnType<typeof createCompletionHandle>
  started: boolean
  settled: boolean
  automatic: boolean
  interrupted: boolean
  text: boolean
  error?: string
  settings: Settings
}
type Settings = {
  model: string | null
  effort: string | null
  permissionMode: 'manual' | 'auto' | 'yolo'
}
type Delivery = { turn: Turn; started: boolean; cancelled: boolean }
type Control = { finish: (error?: Error, value?: unknown) => void }
type Interaction = {
  engineId: string
  providerId: string
  input: ObjectValue
  owner: Owner
  itemId: string
  bytes: number
  original: ObjectValue
  question?: QuestionRequest
  controller: AbortController
  replying: boolean
}
const inheritedCredentials = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_VERTEX',
  'ANTHROPIC_BASE_URL',
]
const ownedFlags = new Set([
  '--print',
  '-p',
  '--input-format',
  '--output-format',
  '--verbose',
  '--include-partial-messages',
  '--permission-prompt-tool',
  '--forward-subagent-text',
  '--permission-mode',
  '--allow-dangerously-skip-permissions',
  '--dangerously-skip-permissions',
  '--session-id',
  '--resume',
  '-r',
  '--continue',
  '-c',
  '--fork-session',
  '--no-session-persistence',
  '--resume-session-at',
  '--replay-user-messages',
  '--from-pr',
  '--teleport',
  '-t',
  '--remote',
  '--bg',
  '--background',
  '--cloud',
  '--environment',
  '--remote-control',
  '--worktree',
  '-w',
  '--tmux',
  '--bare',
  '--model',
  '--effort',
])
function launchArgs(args: string[]) {
  for (const arg of args) {
    const flag = arg.split('=')[0]!
    if (arg === '--' || ownedFlags.has(flag) || /^-[pcrtw].+/.test(flag))
      throw new Error(
        `Claude adapter owns ${flag}; remove it from configured arguments`,
      )
  }
  return [
    ...args,
    '--print',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-prompt-tool',
    'stdio',
    '--forward-subagent-text',
    '--permission-mode',
    'manual',
    '--allow-dangerously-skip-permissions',
  ]
}
function accountId(value: string | null | undefined) {
  if (value === undefined || value === null) return null
  if (!value.trim() || value.trim() !== value)
    throw new Error('Claude account ID must be nonempty and normalized')
  return value
}
export function createClaudeAdapter(options: ClaudeAdapterOptions = {}): Omit<
  HarnessAdapter,
  'spawn' | 'load'
> & {
  spawn: (
    session: HarnessSession,
    emit: (event: HarnessEvent) => void,
  ) => Promise<ClaudeHandle>
  load: (
    session: HarnessSession,
    emit: (event: HarnessEvent) => void,
  ) => Promise<ClaudeHandle>
} {
  const start = async (
    session: HarnessSession,
    emit: (event: HarnessEvent) => void,
    resume: boolean,
  ): Promise<ClaudeHandle> => {
    for (const [name, value] of Object.entries({
      startup: options.startupTimeoutMs,
      control: options.controlTimeoutMs,
      interrupt: options.interruptGraceMs,
      attribution: options.attributionTimeoutMs,
    }))
      if (value !== undefined) positiveLimit(value, `${name} timeout`)
    requiredString(session.id)
    requiredString(session.provider)
    const selected = accountId(options.accountId)
    if (selected !== accountId(session.accountId))
      throw new Error(
        'Claude session account does not match the selected account',
      )
    if (selected && !options.env?.CLAUDE_CONFIG_DIR?.trim())
      throw new Error('Selected Claude account requires CLAUDE_CONFIG_DIR')
    const cwd = await realpath(session.cwd)
    if (!(await stat(cwd)).isDirectory())
      throw new Error('Claude cwd must be a directory')
    const binding = session.binding
    if (resume) {
      if (!binding?.providerSessionId?.trim())
        throw new Error('Claude resume requires a confirmed native session ID')
      if (
        binding.provider !== session.provider ||
        accountId(binding.accountId) !== selected ||
        (await realpath(binding.cwd)) !== cwd
      )
        throw new Error(
          'Claude resume binding scope does not match this session',
        )
    } else if (binding?.providerSessionId)
      throw new Error('Use load to resume the existing Claude binding')
    const nativeId = resume ? binding!.providerSessionId! : randomUUID()
    const args = launchArgs(options.args ?? [])
    args.push(
      ...(resume ? [`--resume=${nativeId}`] : ['--session-id', nativeId]),
    )
    const env: NodeJS.ProcessEnv = { CLAUDECODE: undefined }
    if (selected) for (const name of inheritedCredentials) env[name] = undefined
    Object.assign(env, options.env)
    // A parent CLI marker must never turn an owned child into a nested CLI session.
    env.CLAUDECODE = undefined
    const { value } = await NativeProcess.start(
      {
        command: options.command ?? 'claude',
        args,
        cwd,
        env,
        secrets: options.secrets,
        startupTimeoutMs: options.startupTimeoutMs,
      },
      async (process) => {
        const runtime = new ClaudeSession(
          process,
          { ...session, cwd, accountId: selected },
          nativeId,
          options,
          emit,
        )
        await runtime.initialize()
        return runtime
      },
    )
    return value
  }
  return {
    kind: 'native',
    capabilities: {
      loadSession: true,
      steer: true,
      queue: false,
      cancel: true,
      permissions: true,
      questions: true,
      models: true,
    },
    spawn: (session, emit) => start(session, emit, false),
    load: (session, emit) => start(session, emit, true),
  }
}

class ClaudeSession implements ClaudeHandle {
  private confirmed: ConfirmedNativeBinding | null = null
  private discovery: ClaudeCatalog = { models: [], commands: [] }
  private readonly generation = randomUUID()
  private readonly ids = new Identities()
  private readonly normalizer: ClaudeNormalizer
  private readonly transport: JsonlTransport
  private readonly controls = new Map<string, Control>()
  private readonly interactions = new Map<string, Interaction>()
  private readonly providerInteractions = new Map<string, string>()
  private readonly finishedInteractions = new Set<string>()
  private interactionBytes = 0
  private readonly deliveries = new Map<string, Delivery>()
  private readonly turns = new Map<string, Turn>()
  private readonly results = new Set<string>()
  private readonly recentFrames = new Map<string, number>()
  private recentFrameBytes = 0
  private readonly startedRuns = new Set<string>()
  private readonly capabilities = new Set<string>()
  private checkedProfile = false
  private observed?: Turn
  private lastRunId?: string
  private foreground?: symbol
  private operations = 0
  private operationTail = Promise.resolve()
  private epoch = 0
  private preparation = new AbortController()
  private readonly attachmentWork = new AttachmentWork()
  private settings: Settings = {
    model: null,
    effort: null,
    permissionMode: 'manual',
  }
  private buffered: { frame: ObjectValue; bytes: number }[] = []
  private bufferedBytes = 0
  private attributionTimer?: ReturnType<typeof setTimeout>
  private closing?: Promise<void>
  private cancelling?: Promise<void>
  private closed = false
  private failureReported = false
  private stopRequested = false

  constructor(
    private readonly process: NativeProcess,
    private readonly session: HarnessSession,
    private readonly nativeId: string,
    private readonly options: ClaudeAdapterOptions,
    private readonly emitCallback: (event: HarnessEvent) => void,
  ) {
    this.normalizer = new ClaudeNormalizer(
      (owner, body) => this.emit(owner, body),
      this.ids,
    )
    this.transport = new JsonlTransport({
      stdin: process.child.stdin,
      stdout: process.child.stdout,
      maxLineBytes: 32 * MiB,
      maxQueuedBytes: 64 * MiB,
      maxQueuedFrames: 128,
      secrets: options.secrets,
      onValue: (value, bytes) => {
        if (this.closed) return
        try {
          this.frame(object(value), bytes)
        } catch (error) {
          void this.close(this.safe(error), false).catch(() => {})
        }
      },
    })
    process.ownTransport(this.transport)
    void this.transport.done
      .then((reason) => this.close(reason, this.stopRequested))
      .catch(() => {})
    void process.done
      .then((reason) => this.close(reason, this.stopRequested))
      .catch(() => {})
  }
  get binding() {
    return this.confirmed
  }
  get catalog() {
    return structuredClone(this.discovery)
  }
  get availableModels() {
    return this.discovery.models.map((model) => ({
      id: model.value,
      displayName: model.displayName,
    }))
  }
  async initialize() {
    this.discovery = parseCatalog(await this.control({ subtype: 'initialize' }))
    await this.control({
      subtype: 'set_max_thinking_tokens',
      max_thinking_tokens: null,
      thinking_display: 'summarized',
    })
    this.assertOpen()
  }
  private safe(error: unknown) {
    return diagnosticError(error, this.options.secrets)
  }
  private assertOpen() {
    if (this.closed || this.process.signal.aborted)
      throw new Error('Claude session is closed')
  }
  private emit(owner: Owner, body: EventBody) {
    if (body.type === 'child_finished')
      for (const interaction of this.interactions.values())
        if (interaction.owner.childId === owner.childId)
          this.expire(interaction, 'Claude child ended')
    if (body.type === 'text_delta' && !owner.childId) {
      const turn = this.turns.get(owner.turnId)
      if (turn) turn.text = true
    }
    this.emitCallback({
      runId: owner.runId,
      ...(body.type === 'run_started' || body.type === 'run_failed'
        ? {}
        : {
            turnId: owner.turnId,
            ...(owner.childId ? { childId: owner.childId } : {}),
          }),
      ...body,
      runtimeGeneration: this.generation,
      deliveryId: randomUUID(),
    } as HarnessEvent)
  }
  private control(request: ObjectValue): Promise<unknown> {
    this.assertOpen()
    if (this.controls.size >= LIMITS.controls) {
      const error = new Error('Claude pending control limit exceeded')
      void this.close(error, false).catch(() => {})
      return Promise.reject(error)
    }
    const requestId = `${this.generation}:${randomUUID()}`
    const deadline =
      performance.now() + (this.options.controlTimeoutMs ?? 15_000)
    return new Promise((resolve, reject) => {
      let done = false
      const abort = () => finish(new Error('Claude control cancelled'))
      const finish = (error?: Error, value?: unknown) => {
        if (done) return
        done = true
        clearTimeout(timer)
        this.process.signal.removeEventListener('abort', abort)
        this.controls.delete(requestId)
        if (error) reject(error)
        else resolve(value)
      }
      const timer = setTimeout(
        () => {
          const error = new Error('Claude control timed out')
          finish(error)
          void this.close(error, false).catch(() => {})
        },
        Math.max(1, deadline - performance.now()),
      )
      this.controls.set(requestId, { finish })
      this.process.signal.addEventListener('abort', abort, { once: true })
      void this.transport
        .send(
          { type: 'control_request', request_id: requestId, request },
          { signal: this.process.signal, deadline },
        )
        .catch((error) => {
          finish(this.safe(error))
          void this.close(this.safe(error), false).catch(() => {})
        })
    })
  }
  private operation<T>(
    work: (check: () => void, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.assertOpen()
    if (this.cancelling)
      return Promise.reject(new Error('Claude cancellation is in progress'))
    if (this.operations >= LIMITS.operations)
      return Promise.reject(new Error('Claude operation limit exceeded'))
    this.operations++
    const epoch = this.epoch
    const signal = this.preparation.signal
    const check = () => {
      this.assertOpen()
      if (epoch !== this.epoch || signal.aborted)
        throw new Error('Claude preparation was cancelled')
    }
    const result = this.operationTail.then(async () => {
      check()
      return work(check, signal)
    })
    this.operationTail = result.then(
      () => {},
      () => {},
    )
    return result.finally(() => {
      this.operations--
    })
  }
  private desired(options: DispatchOptions | undefined): Settings {
    const parsed = dispatchOptionsSchema.strict().safeParse(options ?? {})
    if (!parsed.success) throw new Error('Invalid Claude dispatch options')
    for (const field of [
      'approvalPolicy',
      'sandboxPolicy',
      'serviceTier',
    ] as const)
      if (parsed.data[field] != null)
        throw new Error(`Claude does not support ${field}`)
    const target = { ...this.settings }
    if (options?.model !== undefined) target.model = options.model
    if (options?.reasoning !== undefined) target.effort = options.reasoning
    if (options?.permissionMode !== undefined)
      target.permissionMode = options.permissionMode
    if (target.model === '') throw new Error('Claude model must be nonempty')
    this.validateEffort(target.model, target.effort)
    return target
  }
  private model(id: string | null) {
    return this.discovery.models.find(
      (model) =>
        model.value === (id ?? 'default') || model.resolvedModel === id,
    )
  }
  private validateEffort(model: string | null, effort: string | null) {
    if (effort !== null) {
      const descriptor = this.model(model)
      if (
        !descriptor?.supportsEffort ||
        !descriptor.supportedEffortLevels?.includes(effort)
      )
        throw new Error('Claude model does not support this effort value')
    }
  }
  private async apply(target: Settings, check: () => void) {
    if (target.model !== this.settings.model) {
      await this.control({ subtype: 'set_model', model: target.model })
      this.settings.model = target.model
      check()
    }
    if (target.effort !== this.settings.effort) {
      await this.control({
        subtype: 'apply_flag_settings',
        settings: { effortLevel: target.effort },
      })
      this.settings.effort = target.effort
      check()
    }
    if (target.permissionMode !== this.settings.permissionMode) {
      const mode = {
        manual: 'default',
        auto: 'auto',
        yolo: 'bypassPermissions',
      }[target.permissionMode]
      const response = await this.control({
        subtype: 'set_permission_mode',
        mode,
      })
      const accepted = maybeObject(response).mode
      if (accepted !== undefined && accepted !== mode)
        throw new Error('Claude did not apply the requested permission mode')
      this.settings.permissionMode = target.permissionMode
      check()
    }
  }
  prompt(
    input: PromptInput[] | string,
    options?: DispatchOptions,
    identity?: { runId: string; turnId: string },
  ): Promise<HarnessReceipt> {
    try {
      this.assertOpen()
      const parts = validateInput(input)
      this.desired(options)
      if (identity) {
        requiredString(identity.runId)
        requiredString(identity.turnId)
        if (this.turns.has(identity.turnId))
          throw new Error('Claude turn identity was already used')
      }
      if (this.foreground) throw new Error('Claude foreground prompt is busy')
      const slot = Symbol('foreground')
      this.foreground = slot
      return this.operation(async (check, signal) => {
        const blocks = await prepareInput(
          parts,
          this.session.id,
          this.options.loadAttachment,
          this.attachmentWork,
          signal,
          check,
        )
        try {
          check()
          const target = this.desired(options)
          await this.apply(target, check)
          check()
          const turn = this.newTurn(identity, false)
          turn.settings = { ...this.settings }
          return await this.deliver(blocks, turn, false)
        } finally {
          blocks.length = 0
        }
      }).catch((error) => {
        if (
          this.foreground === slot &&
          ![...this.turns.values()].some(
            (turn) => !turn.settled && !turn.automatic,
          )
        )
          this.foreground = undefined
        throw this.safe(error)
      })
    } catch (error) {
      return Promise.reject(this.safe(error))
    }
  }
  steer(
    input: PromptInput[] | string,
    options?: DispatchOptions,
    identity?: { runId: string; turnId: string },
  ): Promise<HarnessReceipt> {
    try {
      this.assertOpen()
      const turn = this.observed
      if (!turn || turn.settled || turn.interrupted)
        throw new Error('Claude has no active turn to steer')
      const parts = validateInput(input)
      const validate = () => {
        if (turn !== this.observed || turn.settled || turn.interrupted)
          throw new Error('Claude steer crossed its active turn')
        if (
          identity &&
          (identity.runId !== turn.runId || identity.turnId !== turn.turnId)
        )
          throw new Error('Claude steer identity must match the active turn')
        if (
          JSON.stringify(this.desired(options)) !==
          JSON.stringify(turn.settings)
        )
          throw new Error('Claude steer settings must match the active turn')
      }
      validate()
      return this.operation(async (check, signal) => {
        validate()
        const blocks = await prepareInput(
          parts,
          this.session.id,
          this.options.loadAttachment,
          this.attachmentWork,
          signal,
          () => {
            check()
            validate()
          },
        )
        try {
          check()
          validate()
          return await this.deliver(blocks, turn, true)
        } finally {
          blocks.length = 0
        }
      })
    } catch (error) {
      return Promise.reject(this.safe(error))
    }
  }
  private async deliver(
    blocks: unknown[],
    turn: Turn,
    steer: boolean,
  ): Promise<HarnessReceipt> {
    const uuid = randomUUID()
    this.ids.add(`trigger:${uuid}`)
    this.deliveries.set(uuid, { turn, started: false, cancelled: false })
    const receipt = {
      receiptId: randomUUID(),
      runId: turn.runId,
      turnId: turn.turnId,
      completion: turn.completion.handle,
    }
    this.emit(turn, {
      type: steer ? 'steer_accepted' : 'prompt_accepted',
      receiptId: receipt.receiptId,
    })
    try {
      this.assertOpen()
      if (turn.settled || turn.interrupted || this.stopRequested) {
        this.deliveries.get(uuid)!.cancelled = true
        throw new Error('Claude send was cancelled before delivery')
      }
      await this.transport.send(
        {
          type: 'user',
          uuid,
          session_id: this.nativeId,
          message: { role: 'user', content: blocks },
          parent_tool_use_id: null,
        },
        { signal: this.process.signal },
      )
    } catch (error) {
      await this.close(this.safe(error), this.stopRequested)
      throw error
    }
    return receipt
  }
  private newTurn(
    identity: { runId: string; turnId: string } | undefined,
    automatic: boolean,
  ): Turn {
    const runId = identity
      ? requiredString(identity.runId)
      : (this.lastRunId ?? randomUUID())
    const turnId = identity ? requiredString(identity.turnId) : randomUUID()
    if (this.turns.has(turnId))
      throw new Error('Claude turn identity was already used')
    this.ids.add(`turn:${turnId}`, `run:${runId}`)
    const turn: Turn = {
      runId,
      turnId,
      completion: createCompletionHandle({
        completionId: randomUUID(),
        runId,
        turnId,
      }),
      started: false,
      settled: false,
      automatic,
      interrupted: false,
      text: false,
      settings: { ...this.settings },
    }
    this.turns.set(turnId, turn)
    this.lastRunId = runId
    if (!this.startedRuns.has(runId)) {
      this.startedRuns.add(runId)
      this.emit(turn, { type: 'run_started' })
    }
    return turn
  }
  private observe(turn: Turn) {
    if (turn.settled) return
    if (this.observed && this.observed !== turn)
      throw new Error('Claude started conflicting root turns')
    this.observed = turn
    if (!turn.started) {
      turn.started = true
      this.emit(turn, { type: 'turn_started' })
    }
  }
  private settle(turn: Turn, outcome: TerminalOutcome) {
    if (turn.settled) return
    turn.settled = true
    turn.completion.settle({
      ...outcome,
      runId: turn.runId,
      turnId: turn.turnId,
    })
    this.emit(turn, { type: 'turn_completed', outcome })
    this.normalizer.finishOwner(turn)
    if (this.observed === turn) this.observed = undefined
    if (!turn.automatic) this.foreground = undefined
  }
  setModel(modelId: string) {
    return this.operation(async (check) => {
      if (this.observed || this.foreground)
        throw new Error('Claude model cannot change during foreground work')
      if (!modelId) throw new Error('Claude model must be nonempty')
      const target = { ...this.settings, model: modelId }
      this.validateEffort(target.model, target.effort)
      await this.apply(target, check)
    })
  }
  configOptions(): SessionConfigOption[] {
    const descriptor = this.model(this.settings.model)
    return descriptor?.supportsEffort
      ? [
          {
            id: 'effort',
            name: 'Effort',
            type: 'select',
            currentValue: this.settings.effort ?? '',
            options: (descriptor.supportedEffortLevels ?? []).map((value) => ({
              value,
              name: value,
            })),
          },
        ]
      : []
  }
  setConfigOption(configId: string, value: string | boolean) {
    return this.operation(async (check) => {
      if (this.observed || this.foreground)
        throw new Error('Claude settings cannot change during foreground work')
      if (configId === 'effort' && typeof value === 'string') {
        const target = { ...this.settings, effort: value }
        this.validateEffort(target.model, target.effort)
        await this.apply(target, check)
      } else if (
        configId === 'fast' &&
        typeof value === 'boolean' &&
        this.model(this.settings.model)?.supportsFastMode
      ) {
        await this.control({
          subtype: 'apply_flag_settings',
          settings: { fastMode: value },
        })
        check()
      } else throw new Error('Unsupported Claude config option')
    })
  }
  private confirm(frame: ObjectValue) {
    const id = requiredString(frame.session_id)
    if (id !== this.nativeId)
      throw new Error(
        'Claude native session ID does not match the selected binding',
      )
    this.confirmed = Object.freeze({
      provider: this.session.provider,
      accountId: this.session.accountId ?? null,
      cwd: this.session.cwd,
      providerSessionId: id,
    })
  }
  private frame(frame: ObjectValue, bytes: number) {
    if (frame.type === 'system' && frame.subtype === 'init') {
      this.confirm(frame)
      this.capabilities.clear()
      if (Array.isArray(frame.capabilities))
        for (const capability of frame.capabilities)
          if (typeof capability === 'string') this.capabilities.add(capability)
      this.checkedProfile =
        frame.claude_code_version === '2.1.258' &&
        this.capabilities.has('msg_lifecycle_v1')
      if (this.checkedProfile && this.buffered.length)
        this.drain(this.observed ?? this.newTurn(undefined, true))
      return
    }
    if (frame.type === 'result' && !frame.parent_tool_use_id)
      this.confirm(frame)
    const uuid = string(frame.uuid)
    if (uuid) {
      if (this.recentFrames.has(uuid) || this.results.has(uuid)) return
      const frameBytes = Buffer.byteLength(uuid)
      if (frameBytes > LIMITS.stringBytes)
        throw new Error('Claude frame identity byte limit exceeded')
      while (
        this.recentFrames.size >= LIMITS.frames ||
        this.recentFrameBytes + frameBytes > LIMITS.frameBytes
      ) {
        const [oldest, bytes] = this.recentFrames.entries().next().value!
        this.recentFrames.delete(oldest)
        this.recentFrameBytes -= bytes
      }
      this.recentFrames.set(uuid, frameBytes)
      this.recentFrameBytes += frameBytes
    }
    if (frame.type === 'control_response') {
      const response = object(frame.response)
      const pending = this.controls.get(requiredString(response.request_id))
      if (!pending) return
      if (response.subtype === 'success')
        pending.finish(undefined, response.response)
      else if (response.subtype === 'error')
        pending.finish(
          this.safe(
            new Error(
              string(response.error) || 'Claude rejected the control request',
            ),
          ),
        )
      else throw new Error('Claude sent an invalid control response')
      return
    }
    if (frame.type === 'control_cancel_request') {
      const engineId = this.providerInteractions.get(
        requiredString(frame.request_id),
      )
      if (engineId)
        this.expire(
          this.interactions.get(engineId)!,
          'Claude cancelled this request',
        )
      return
    }
    if (
      frame.type === 'control_request' &&
      maybeObject(frame.request).subtype !== 'can_use_tool'
    ) {
      const requestId = requiredString(frame.request_id)
      this.write({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: requestId,
          error: 'Unsupported Claude control request',
        },
      })
      return
    }
    if (frame.type === 'command_lifecycle') {
      this.lifecycle(frame)
      return
    }
    if (frame.type === 'system') {
      this.normalizer.system(frame)
      return
    }
    if (
      ![
        'stream_event',
        'assistant',
        'user',
        'result',
        'control_request',
        'rate_limit_event',
      ].includes(string(frame.type))
    )
      return
    if (
      frame.type === 'stream_event' &&
      maybeObject(frame.event).type === 'ping'
    )
      return
    const childOwner = this.normalizer.childOwner(frame)
    if (childOwner?.childId) {
      if (frame.type === 'control_request')
        this.interaction(frame, childOwner, bytes)
      else if (frame.type !== 'result')
        this.normalizer.content(frame, childOwner)
      return
    }
    if (frame.type === 'user') {
      // User echoes do not establish root work. Tool results retain their original owner.
      const content = maybeObject(frame.message).content
      if (Array.isArray(content)) {
        for (const block of content) {
          const value = maybeObject(block)
          if (value.type !== 'tool_result') continue
          const owner = this.normalizer.toolOwner(
            requiredString(value.tool_use_id),
          )
          if (!owner)
            throw new Error('Claude tool result attribution is unknown')
          this.normalizer.content(
            {
              ...frame,
              message: { ...maybeObject(frame.message), content: [value] },
            },
            owner,
          )
        }
      }
      return
    }
    const knownMessage = this.normalizer.knownMessage(frame)
    const trigger = string(frame.user_message_uuid)
    let owner: Turn | undefined
    if (trigger) {
      const delivery = this.deliveries.get(trigger)
      if (!delivery) throw new Error('Claude root trigger UUID is unknown')
      if (knownMessage && knownMessage.owner.turnId !== delivery.turn.turnId)
        throw new Error('Claude changed a message owner')
      if (delivery.turn.settled || delivery.cancelled || knownMessage?.settled)
        return
      delivery.started = true
      owner = delivery.turn
    } else if (childOwner) owner = this.turns.get(childOwner.turnId)
    else if (knownMessage) owner = this.turns.get(knownMessage.owner.turnId)
    else owner = this.observed
    if (owner?.settled) {
      if (frame.type === 'control_request')
        this.write(
          successResponse(
            requiredString(frame.request_id),
            denyResponse('Claude request belongs to a completed turn'),
          ),
        )
      return
    }
    const synthetic = maybeObject(frame.origin).kind === 'task-notification'
    if (synthetic && owner && !owner.automatic)
      throw new Error(
        'Claude synthetic result conflicts with foreground ownership',
      )
    const contentBoundary =
      frame.type === 'assistant' ||
      frame.type === 'control_request' ||
      (frame.type === 'stream_event' &&
        [
          'message_start',
          'content_block_start',
          'content_block_delta',
        ].includes(string(maybeObject(frame.event).type)))
    if (!owner && (synthetic || (this.checkedProfile && contentBoundary)))
      owner = this.newTurn(undefined, true)
    if (!owner) {
      // A rate warning or stray message stop does not create an automatic turn.
      if (
        frame.type === 'rate_limit_event' ||
        (frame.type === 'stream_event' &&
          ['message_stop', 'message_delta'].includes(
            string(maybeObject(frame.event).type),
          ))
      )
        return
      this.buffer(frame, bytes)
      return
    }
    this.observe(owner)
    if (this.buffered.length) this.drain(owner)
    this.route(frame, owner, bytes)
  }
  private route(frame: ObjectValue, turn: Turn, bytes: number) {
    if (turn.settled) return
    if (frame.type === 'control_request') {
      this.interaction(frame, turn, bytes)
      return
    }
    if (frame.type === 'assistant' && frame.error) {
      const text = maybeObject(frame.message).content
      const details = Array.isArray(text)
        ? text
            .map((block) => string(maybeObject(block).text))
            .filter((value) => !/^\s*</.test(value))
            .join('\n')
        : ''
      turn.error = this.safe(
        new Error(details || `Claude assistant error: ${string(frame.error)}`),
      ).message
    }
    if (frame.type === 'rate_limit_event') {
      if (maybeObject(frame.rate_limit_info).status === 'rejected')
        turn.error = 'Claude rejected the turn because of a rate limit'
      return
    }
    if (frame.type === 'result') {
      this.confirm(frame)
      const uuid = string(frame.uuid)
      if (uuid) {
        this.ids.add(`result:${uuid}`)
        this.results.add(uuid)
      }
      const usage = maybeObject(frame.usage)
      if (
        Number.isSafeInteger(usage.input_tokens) &&
        Number.isSafeInteger(usage.output_tokens) &&
        Number(usage.input_tokens) >= 0 &&
        Number(usage.output_tokens) >= 0
      ) {
        this.emit(turn, {
          type: 'usage',
          itemId: randomUUID(),
          inputTokens: Number(usage.input_tokens),
          outputTokens: Number(usage.output_tokens),
          totalTokens: Number(usage.input_tokens) + Number(usage.output_tokens),
        })
      }
      const failed = frame.subtype !== 'success' || frame.is_error === true
      if (
        !failed &&
        !turn.text &&
        typeof frame.result === 'string' &&
        frame.result
      )
        this.emit(turn, {
          type: 'text_delta',
          itemId: randomUUID(),
          text: frame.result,
        })
      const errors = Array.isArray(frame.errors)
        ? frame.errors.filter(
            (error): error is string =>
              typeof error === 'string' && !/^\s*</.test(error),
          )
        : []
      const outcome: TerminalOutcome = turn.interrupted
        ? { status: 'interrupted' }
        : failed
          ? {
              status: 'failed',
              code: 'claude_result_error',
              message: this.safe(
                new Error(
                  errors.join('\n') || turn.error || 'Claude turn failed',
                ),
              ).message,
            }
          : { status: 'completed' }
      for (const interaction of this.interactions.values())
        if (
          interaction.owner.turnId === turn.turnId &&
          !interaction.owner.childId
        )
          this.expire(interaction, 'Claude turn ended')
      this.settle(turn, outcome)
      return
    }
    this.normalizer.content(frame, turn)
  }
  private lifecycle(frame: ObjectValue) {
    const delivery = this.deliveries.get(string(frame.command_uuid))
    if (!delivery || delivery.turn.settled) return
    const status = string(frame.state ?? frame.status)
    if (status === 'started') {
      if (delivery.cancelled || delivery.turn.interrupted)
        throw new Error('Claude started input after cancellation')
      delivery.started = true
      this.observe(delivery.turn)
      if (this.buffered.length) this.drain(delivery.turn)
    } else if (['refused', 'discarded', 'cancelled'].includes(status)) {
      if (this.stopRequested && status === 'cancelled') {
        delivery.cancelled = true
        return
      }
      throw new Error('Claude rejected an accepted user message')
    }
  }
  private buffer(frame: ObjectValue, bytes: number) {
    if (
      this.buffered.length >= LIMITS.attributionFrames ||
      this.bufferedBytes + bytes > LIMITS.attributionBytes
    )
      throw new Error('Claude root attribution buffer limit exceeded')
    this.buffered.push({ frame, bytes })
    this.bufferedBytes += bytes
    if (!this.attributionTimer)
      this.attributionTimer = setTimeout(
        () => {
          void this.close(
            new Error('Claude root attribution timed out'),
            false,
          ).catch(() => {})
        },
        Math.min(this.options.attributionTimeoutMs ?? 30_000, 30_000),
      )
  }
  private drain(turn: Turn) {
    const buffered = this.buffered
    this.buffered = []
    this.bufferedBytes = 0
    clearTimeout(this.attributionTimer)
    this.attributionTimer = undefined
    this.observe(turn)
    for (const { frame, bytes } of buffered) {
      if (turn.settled)
        throw new Error('Claude buffered output crossed a result boundary')
      this.route(frame, turn, bytes)
    }
  }
  private write(value: unknown) {
    void this.transport
      .send(value, { signal: this.process.signal })
      .catch((error) => this.close(this.safe(error), false))
      .catch(() => {})
  }
  private interaction(frame: ObjectValue, owner: Owner, bytes: number) {
    const providerId = requiredString(frame.request_id)
    if (this.stopRequested || this.normalizer.isChildFinished(owner)) {
      this.write(
        successResponse(
          providerId,
          denyResponse('Claude request belongs to stopped work'),
        ),
      )
      return
    }
    if (
      this.providerInteractions.has(providerId) ||
      this.finishedInteractions.has(providerId)
    )
      return
    if (
      this.interactions.size >= LIMITS.interactions ||
      this.interactionBytes + bytes > LIMITS.interactionBytes
    )
      throw new Error('Claude interaction limit exceeded')
    const request = object(frame.request)
    const input = object(request.input)
    const name = requiredString(request.tool_name)
    const engineId = `${this.generation}:${randomUUID()}`
    const question =
      name === 'AskUserQuestion' ? questionRequest(engineId, input) : undefined
    this.ids.add(`interaction:${providerId}`)
    const interaction: Interaction = {
      engineId,
      providerId,
      input,
      owner,
      itemId: randomUUID(),
      bytes,
      original: frame,
      question,
      controller: new AbortController(),
      replying: false,
    }
    this.interactions.set(engineId, interaction)
    this.providerInteractions.set(providerId, engineId)
    this.interactionBytes += bytes
    if (question)
      this.emit(owner, {
        type: 'question_requested',
        itemId: interaction.itemId,
        request: question,
      })
    else {
      const detail = [
        string(request.decision_reason),
        string(request.blocked_path),
      ]
        .filter(Boolean)
        .join('\n')
      this.emit(owner, {
        type: 'permission_requested',
        itemId: interaction.itemId,
        request: {
          requestId: engineId,
          toolCallId: string(request.tool_use_id) || null,
          title: name,
          ...(detail ? { detail: this.safe(new Error(detail)).message } : {}),
          options: [
            { id: 'allow_once', label: 'Allow once' },
            { id: 'deny', label: 'Deny' },
          ],
        },
      })
    }
  }
  private removeInteraction(interaction: Interaction) {
    if (this.interactions.get(interaction.engineId) !== interaction)
      return false
    this.interactions.delete(interaction.engineId)
    this.providerInteractions.delete(interaction.providerId)
    this.finishedInteractions.add(interaction.providerId)
    this.interactionBytes -= interaction.bytes
    return true
  }
  private expire(interaction: Interaction, reason: string) {
    if (!this.removeInteraction(interaction)) return
    interaction.controller.abort(new Error(reason))
    this.emit(interaction.owner, {
      type: 'request_cancelled',
      itemId: interaction.itemId,
      requestId: interaction.engineId,
      reason,
    })
  }
  private canReply(interaction: Interaction) {
    return (
      this.interactions.get(interaction.engineId) === interaction &&
      !interaction.replying &&
      !interaction.controller.signal.aborted &&
      !this.stopRequested &&
      (interaction.owner.childId ||
        !this.turns.get(interaction.owner.turnId)?.settled) &&
      !this.normalizer.isChildFinished(interaction.owner)
    )
  }
  private async replyInteraction(
    interaction: Interaction,
    response: ObjectValue,
  ) {
    if (!this.canReply(interaction))
      throw new Error('Claude request is stale or already replying')
    interaction.replying = true
    const { signal } = interaction.controller
    try {
      await this.transport.send(
        successResponse(interaction.providerId, response),
        { signal },
      )
      if (signal.aborted) throw signal.reason
      this.removeInteraction(interaction)
    } catch (error) {
      if (!signal.aborted) await this.close(this.safe(error), false)
      throw error
    } finally {
      interaction.replying = false
    }
  }
  async replyPermission(reply: PermissionReply) {
    this.assertOpen()
    const parsed = permissionReplySchema.safeParse(reply)
    if (!parsed.success) throw new Error('Invalid Claude permission reply')
    const interaction = this.interactions.get(reply.requestId)
    if (!interaction || interaction.question || !this.canReply(interaction))
      throw new Error(
        'Claude permission request is stale or has the wrong kind',
      )
    if (
      reply.type === 'granted' ||
      (reply.type === 'selected' &&
        (reply.grant !== undefined || reply.scope !== undefined))
    )
      throw new Error('Claude does not support structured permission grants')
    let response: ObjectValue
    if (reply.type === 'denied')
      response = denyResponse(reply.reason || undefined)
    else if (reply.optionId === 'allow_once')
      response = { behavior: 'allow', updatedInput: interaction.input }
    else if (reply.optionId === 'deny') response = denyResponse()
    else throw new Error('Unknown Claude permission option')
    await this.replyInteraction(interaction, response)
  }
  async replyQuestion(
    requestId: string,
    answers: Record<string, QuestionAnswer>,
  ) {
    this.assertOpen()
    const interaction = this.interactions.get(requestId)
    if (!interaction?.question || !this.canReply(interaction))
      throw new Error('Claude question request is stale or has the wrong kind')
    for (const answer of Object.values(answers))
      if (!questionAnswerSchema.safeParse(answer).success)
        throw new Error('Invalid Claude question answer')
    const response = answerQuestions(
      interaction.question,
      interaction.input,
      answers,
    )
    await this.replyInteraction(interaction, response)
  }
  cancel(): Promise<void> {
    if (this.cancelling) return this.cancelling
    if (this.closed) return this.closing ?? Promise.resolve()
    this.stopRequested = true
    this.epoch++
    this.preparation.abort()
    this.preparation = new AbortController()
    for (const turn of this.turns.values())
      if (!turn.settled) turn.interrupted = true
    for (const interaction of this.interactions.values()) {
      this.expire(interaction, 'The user stopped Claude')
      this.write(
        successResponse(
          interaction.providerId,
          denyResponse('The user stopped Claude'),
        ),
      )
    }
    const cancelQueued = this.capabilities.has('interrupt_cancel_queued_v1')
    const pending = [...this.deliveries.entries()].filter(
      ([, delivery]) => !delivery.turn.settled && !delivery.started,
    )
    this.cancelling = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const stop = async () => {
          const response = maybeObject(
            await this.control({
              subtype: 'interrupt',
              ...(cancelQueued ? { cancel_queued: true } : {}),
            }),
          )
          const cancelled = response.cancelled
          const stillQueued = response.still_queued
          if (cancelQueued) {
            if (
              !Array.isArray(cancelled) ||
              !Array.isArray(stillQueued) ||
              [...cancelled, ...stillQueued].some(
                (id) => typeof id !== 'string',
              )
            )
              throw new Error(
                'Claude interrupt returned an invalid queue receipt',
              )
            for (const id of cancelled) {
              const delivery = this.deliveries.get(id as string)
              if (delivery) delivery.cancelled = true
            }
          }
          const queueEmpty =
            pending.every(([, delivery]) => delivery.cancelled) &&
            (!Array.isArray(stillQueued) || stillQueued.length === 0)
          if ((!cancelQueued && pending.length > 0) || !queueEmpty) {
            await this.close(
              new Error('Claude queued input could not be cancelled'),
              true,
              true,
            )
            return
          }
          for (const turn of this.turns.values())
            if (
              !turn.settled &&
              !turn.started &&
              [...this.deliveries.values()]
                .filter((d) => d.turn === turn)
                .every((d) => d.cancelled)
            )
              this.settle(turn, { status: 'interrupted' })
          await Promise.all(
            [...this.turns.values()]
              .filter((turn) => !turn.settled)
              .map((turn) => turn.completion.handle),
          )
        }
        await Promise.race([
          stop(),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, this.options.interruptGraceMs ?? 1000)
          }),
        ])
        if (
          [...this.turns.values()].some((turn) => !turn.settled) ||
          this.interactions.size ||
          this.controls.size ||
          this.normalizer.state.activeTasks
        )
          await this.close(
            new Error('Claude interrupt grace expired'),
            true,
            true,
          )
      } catch (error) {
        await this.close(this.safe(error), true, true)
      } finally {
        clearTimeout(timer)
        this.cancelling = undefined
        if (!this.closed) this.stopRequested = false
      }
    })()
    return this.cancelling
  }
  kill() {
    return this.close(new Error('Claude session closed'), true)
  }
  /**
   * `interrupted` keeps a stopped turn out of the failure channel. `abandoned`
   * still announces the process death, because an escalated cancel tears the
   * session down and the engine must forget the handle instead of reusing it.
   */
  private close(
    reason: Error,
    interrupted: boolean,
    abandoned = false,
  ): Promise<void> {
    if (this.closing) return this.closing
    this.closing = Promise.resolve().then(() => this.process.close(reason))
    this.closed = true
    this.stopRequested ||= interrupted
    this.epoch++
    this.preparation.abort()
    clearTimeout(this.attributionTimer)
    this.attributionTimer = undefined
    this.buffered = []
    this.bufferedBytes = 0
    for (const control of this.controls.values()) control.finish(reason)
    for (const interaction of this.interactions.values())
      this.expire(
        interaction,
        interrupted ? 'Claude session stopped' : 'Claude session failed',
      )
    const message = this.safe(reason).message || 'Claude session failed'
    for (const turn of this.turns.values())
      if (!turn.settled)
        this.settle(
          turn,
          interrupted || turn.interrupted
            ? { status: 'interrupted' }
            : {
                status: 'failed',
                code: 'claude_runtime_failed',
                message: turn.error ?? message,
              },
        )
    this.normalizer.close(
      interrupted
        ? { status: 'interrupted' }
        : { status: 'failed', code: 'claude_runtime_failed', message },
    )
    if ((!interrupted || abandoned) && !this.failureReported) {
      this.failureReported = true
      const runId = this.lastRunId ?? randomUUID()
      this.emit(
        { runId, turnId: randomUUID() },
        {
          type: 'run_failed',
          code: abandoned ? 'claude_interrupt_failed' : 'claude_runtime_failed',
          message,
        },
      )
    }
    this.deliveries.clear()
    this.turns.clear()
    this.results.clear()
    this.recentFrames.clear()
    this.recentFrameBytes = 0
    this.startedRuns.clear()
    this.interactions.clear()
    this.providerInteractions.clear()
    this.finishedInteractions.clear()
    this.capabilities.clear()
    this.ids.clear()
    this.foreground = undefined
    this.observed = undefined
    return this.closing
  }
}
