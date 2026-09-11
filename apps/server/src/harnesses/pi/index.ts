import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  dispatchOptionsSchema,
  harnessEventSchema,
  type TerminalOutcome,
} from '@forge/protocol/harness'
import {
  createCompletionHandle,
  type DispatchOptions,
  type HarnessAdapter,
  type HarnessEvent,
  type HarnessHandle,
  type HarnessReceipt,
  type HarnessSession,
  type PromptInput,
  type SessionConfigOption,
} from '../types.js'
import { JsonlTransport } from '../jsonl.js'
import { redactSecrets } from '../diagnostics.js'
import { startNativeProcess, type NativeProcess } from '../process.js'
import {
  bytes,
  check,
  deferred,
  fail,
  freeze,
  id,
  limits,
  MiB,
  PiError,
  PiRouter,
  physicalWork,
  reservePhysical,
  PublicationBudget,
  snapshot,
  stateSchema,
  text,
  count,
  waitOwned,
  type PiLimits,
  type PiResponse,
} from './wire.js'
import {
  captureInput,
  hasWireImage,
  prepareInput,
  persistWireImages,
  type LoadPiImage,
  type PersistPiImage,
  type PiLiveOwner,
} from './input.js'
import {
  bodySchema,
  decodeMessage,
  PiNormalizer,
  usageSchema,
  type PiNativeRecord,
  type PiRecordBody,
} from './normalize.js'
import { PiQuestions, type PiQuestionOwner } from './questions.js'
import {
  authorize,
  bindingFromState,
  canonicalSessionPath,
  captureLaunch,
  environmentAtLaunch,
  historyReader,
  modelKey,
  observeFreshFile,
  stateSnapshot,
  validateResume,
  verifyStateBinding,
  verifyVersion,
  type CapturedLaunch,
  type CommitPiHistoryPage,
  type ConfirmedPiBinding,
  type PersistPiRecord,
  type PersistPiSnapshot,
  type PiCatalogSnapshot,
  type PiHistoryReader,
  type PiLaunchOptions,
  type PiResumeTarget,
  type PiStateSnapshot,
  type ValidatedResume,
} from './session.js'

export type {
  ConfirmedPiBinding,
  PiResumeTarget,
  PiNativeLaunch,
  PiStateSnapshot,
  PiCatalogSnapshot,
  PiHistoryCursor,
  PiHistoryPage,
  PiHistoryReader,
  PersistPiRecord,
  CommitPiHistoryPage,
  PersistPiSnapshot,
} from './session.js'
export type {
  PiNativeRecord,
  PiRecordSource,
  PiRecordBody,
  PiMessage,
} from './normalize.js'
export type {
  LoadPiImage,
  PersistPiImage,
  PiImageRef,
  PiLiveOwner,
  PiHistoryOwner,
  PiPersistenceOwner,
} from './input.js'
export type PiAcceptance =
  | { status: 'accepted'; command: 'prompt' | 'steer' | 'follow_up' }
  | { status: 'rejected' | 'unknown'; code: string; message: string }
export type PiDelivery =
  | { status: 'agent_work_observed'; scope: 'session_operation' }
  | { status: 'handled_without_agent'; scope: 'command' }
  | { status: 'unconfirmed' | 'not_sent'; reason: string }
export type PiReceipt = HarnessReceipt & {
  command: 'prompt' | 'steer' | 'follow_up'
  acceptance: Promise<PiAcceptance>
  delivery: Promise<PiDelivery>
  settlementScope: 'session_operation'
}
export type PiHandle = Omit<HarnessHandle, 'binding' | 'prompt' | 'steer'> & {
  readonly binding: ConfirmedPiBinding | null
  prompt(
    input: PromptInput[] | string,
    options?: DispatchOptions,
    identity?: { runId: string; turnId: string },
  ): PiReceipt
  steer(
    input: PromptInput[] | string,
    options?: DispatchOptions,
    identity?: { runId: string; turnId: string },
  ): PiReceipt
  followUp(
    input: PromptInput[] | string,
    options?: DispatchOptions,
    identity?: { runId: string; turnId: string },
  ): PiReceipt
  cancelQuestion(requestId: string): Promise<void>
  getState(): Promise<PiStateSnapshot>
  getCatalog(): PiCatalogSnapshot
  refreshCatalog(): Promise<PiCatalogSnapshot>
}
export type PiAdapter = Omit<HarnessAdapter, 'spawn' | 'load'> & {
  spawn(
    session: HarnessSession,
    emit: (event: HarnessEvent) => void,
  ): Promise<PiHandle>
  load(
    session: HarnessSession,
    emit: (event: HarnessEvent) => void,
  ): Promise<PiHandle>
  createHistoryReader(
    session: HarnessSession,
    target: PiResumeTarget,
    options: { signal: AbortSignal },
  ): PiHistoryReader
}
export type PiAdapterOptions = PiLaunchOptions & {
  resume?: PiResumeTarget
  loadImage: LoadPiImage
  persistImage: PersistPiImage
  persistRecord: PersistPiRecord
  commitHistoryPage: CommitPiHistoryPage
  persistSnapshot: PersistPiSnapshot
  now?: () => number
  nextId?: () => string
  limits?: Partial<PiLimits>
}
export const piNativeDefault = freeze({
  command: 'pi',
  args: [],
  adapterKind: 'native' as const,
})
const capabilities = freeze({
  loadSession: true,
  steer: true,
  queue: true,
  cancel: true,
  questions: true,
  models: true,
  permissions: false,
})
type Dependencies = Pick<
  PiAdapterOptions,
  | 'loadImage'
  | 'persistImage'
  | 'persistRecord'
  | 'commitHistoryPage'
  | 'persistSnapshot'
>
type Attempt = {
  receipt: PiReceipt
  accepted: ReturnType<typeof deferred<PiAcceptance>>
  delivered: ReturnType<typeof deferred<PiDelivery>>
  completion: ReturnType<typeof createCompletionHandle>
  controller: AbortController
  sent: boolean
  finished: boolean
  prepared: boolean
  options: DispatchOptions
}
type Epoch = {
  owner: PiQuestionOwner
  root: Attempt | null
  queued?: Attempt
  normalizer: PiNormalizer
  budget: PublicationBudget
  started: boolean
  lowActive: boolean
  ended: boolean
  retry: boolean
  permit: boolean
  compacting: boolean
  revision: number
  candidate?: number
  terminal: boolean
  extensionError: boolean
  automatic: boolean
  timer: ReturnType<typeof setTimeout>
  cancelling: boolean
}
function reason(error: unknown): PiError {
  return error instanceof PiError
    ? error
    : new PiError('PI_NATIVE_FAILURE', 'The native Pi operation failed.')
}
export function createPiAdapter(options: PiAdapterOptions): PiAdapter {
  const dependencies: Dependencies = {
    loadImage: options.loadImage,
    persistImage: options.persistImage,
    persistRecord: options.persistRecord,
    commitHistoryPage: options.commitHistoryPage,
    persistSnapshot: options.persistSnapshot,
  }
  if (Object.values(dependencies).some((value) => typeof value !== 'function'))
    fail('PI_PERSISTENCE_REQUIRED')
  const launch = captureLaunch({
    providerId: options.providerId,
    launch: options.launch,
    executable: options.executable,
    args: options.args,
    env: options.env,
  })
  const config = limits(options.limits)
  const resume = options.resume ? snapshot(options.resume) : undefined
  const now = options.now ?? (() => performance.now())
  const nextId = options.nextId ?? randomUUID
  const leased = new Set<string>()
  let importing = false
  const spawn = async (
    sessionInput: HarnessSession,
    emit: (event: HarnessEvent) => void,
    target?: PiResumeTarget,
  ) => {
    const session = authorize(launch, sessionInput, target)
    const lease = target?.binding.sessionFile ?? `fresh:${session.id}`
    if (leased.has(lease)) fail('PI_BINDING_BUSY')
    leased.add(lease)
    const runtime = new PiRuntime(
      launch,
      session,
      dependencies,
      config,
      now,
      nextId,
      emit,
    )
    try {
      await runtime.start(target)
      return runtime.handle
    } catch (error) {
      await runtime.close(reason(error))
      throw error
    } finally {
      if (runtime.isClosed) leased.delete(lease)
      else void runtime.closed.promise.then(() => leased.delete(lease))
    }
  }
  return {
    kind: 'native',
    capabilities,
    spawn: (session, emit) => spawn(session, emit),
    load: (session, emit) => {
      if (!resume) return Promise.reject(new PiError('PI_RESUME_REQUIRED'))
      return spawn(session, emit, resume)
    },
    createHistoryReader(session, target, { signal }) {
      if (importing) fail('PI_HISTORY_IMPORT_BUSY')
      importing = true
      try {
        return historyReader(
          launch,
          session,
          target,
          signal,
          nextId(),
          config,
          dependencies.persistImage,
          dependencies.commitHistoryPage,
          () => {
            importing = false
          },
        )
      } catch (error) {
        importing = false
        throw error
      }
    },
  }
}
class PiRuntime {
  readonly closed = deferred<void>()
  readonly controller = new AbortController()
  readonly generation: string
  readonly owner: PiLiveOwner
  readonly handle: PiHandle
  private process?: NativeProcess
  private transport?: JsonlTransport
  private router?: PiRouter
  private bindingValue: ConfirmedPiBinding | null = null
  private state?: PiStateSnapshot
  private baseline?: PiStateSnapshot
  private catalog: PiCatalogSnapshot = freeze({
    models: [],
    thinkingLevels: [],
    commands: [],
    startupNotices: [],
    unsupported: [
      'Blocking startup dialogs',
      'Terminal custom UI',
      'Native child identities',
      'Per-message queue delivery',
      'Unmatched reentrant agent starts',
    ],
  })
  private startup = true
  private failure?: PiError
  private closing?: Promise<void>
  private epoch?: Epoch
  private admission = false
  private configuring = false
  private attempts = new Set<string>()
  private writingInputs = new Set<() => void>()
  private questions: PiQuestions
  private generationBudget: PublicationBudget
  private idleBudget: PublicationBudget
  private failureBudget = new PublicationBudget(8, 64 * 1024)
  private ordinal = 0
  private committed = 0
  private recordQueue: Array<{
    record?: PiNativeRecord
    size: number
    image: boolean
    releaseImage?: () => void
    epoch?: Epoch
    done: ReturnType<typeof deferred<void>>
  }> = []
  private incomingImage = false
  private recordBytes = 0
  private draining = false
  private drainWaiters: Array<{
    ordinal: number
    resolve: () => void
    reject: (error: unknown) => void
  }> = []
  private barrier?: Promise<void>
  private stateFlight?: Promise<PiStateSnapshot>
  private unknownTypes = new Set<string>()
  private stagedEvents?: HarnessEvent[]
  private idleRole?: string
  private observedFile?: Awaited<ReturnType<typeof observeFreshFile>>
  constructor(
    private readonly launch: CapturedLaunch,
    private readonly session: HarnessSession,
    private readonly deps: Dependencies,
    private readonly config: Readonly<PiLimits>,
    private readonly now: () => number,
    private readonly nextId: () => string,
    private readonly emit: (event: HarnessEvent) => void,
  ) {
    this.generation = id.parse(nextId())
    this.owner = freeze({
      kind: 'live',
      forgeSessionId: session.id,
      runtimeGeneration: this.generation,
    })
    this.generationBudget = new PublicationBudget(
      config.generationPublications,
      config.generationPublicationBytes,
    )
    this.idleBudget = new PublicationBudget(
      config.idlePublications,
      config.idlePublicationBytes,
    )
    this.questions = new PiQuestions({
      limits: config,
      secrets: this.launch.secrets,
      now,
      nextId,
      validOwner: (owner) =>
        !this.failure &&
        !!this.epoch &&
        !this.epoch.terminal &&
        !this.epoch.cancelling &&
        this.epoch.owner.runId === owner.runId &&
        this.epoch.owner.turnId === owner.turnId,
      send: (response) => this.transport!.send(response),
      record: (body, owner) =>
        this.record(body, [], owner ? this.epochFor(owner) : undefined),
      requested: (request, owner) =>
        this.publish(
          {
            ...this.envelope(owner),
            type: 'question_requested',
            itemId: nextId(),
            request,
          },
          this.epochFor(owner),
        ),
      expired: (requestId, why, owner) =>
        this.publish(
          {
            ...this.envelope(owner),
            type: 'request_cancelled',
            itemId: nextId(),
            requestId,
            reason: why,
          },
          this.epochFor(owner),
        ),
      pendingChanged: (waiting) => {
        this.router?.humanWait(waiting)
        if (!waiting && this.epoch) this.scheduleBarrier(this.epoch)
      },
      fatal: (error) => this.poison(reason(error)),
    })
    const binding = () => this.bindingValue
    this.handle = {
      get binding() {
        return binding()
      },
      prompt: (input, options, identity) =>
        this.dispatch('prompt', input, options, identity),
      steer: (input, options, identity) =>
        this.dispatch('steer', input, options, identity),
      followUp: (input, options, identity) =>
        this.dispatch('follow_up', input, options, identity),
      cancel: () => this.cancel(),
      kill: () => this.close(new PiError('PI_KILLED')),
      replyQuestion: (requestId, answers) =>
        this.questions.reply(requestId, answers),
      cancelQuestion: (requestId) => this.questions.cancel(requestId),
      getState: async () => {
        if (this.failure) throw this.failure
        if (this.configuring) fail('PI_CONFIGURATION_BUSY')
        try {
          return await this.refreshState()
        } catch (error) {
          this.poison(reason(error))
          throw error
        }
      },
      getCatalog: () => snapshot(this.catalog, 8 * MiB),
      refreshCatalog: () => this.control(() => this.refreshCatalog()),
      configOptions: () => this.configOptions(),
      setModel: (model) =>
        this.control(() =>
          this.applyOptions({ permissionMode: 'manual', model }),
        ),
      setConfigOption: (key, value) =>
        this.control(async () => {
          if (typeof value !== 'string') fail('PI_CONFIG_VALUE_INVALID')
          if (key === 'model')
            await this.applyOptions({ permissionMode: 'manual', model: value })
          else if (key === 'thinking')
            await this.applyOptions({
              permissionMode: 'manual',
              reasoning: value,
            })
          else if (key === 'steeringMode' || key === 'followUpMode') {
            if (value !== 'all' && value !== 'one-at-a-time')
              fail('PI_CONFIG_VALUE_INVALID')
            if (this.state?.[key] !== value)
              await this.command(
                key === 'steeringMode'
                  ? 'set_steering_mode'
                  : 'set_follow_up_mode',
                { mode: value },
              )
            await this.refreshState()
          } else fail('PI_CONFIG_UNSUPPORTED')
        }),
    }
  }
  get isClosed() {
    return !!this.failure
  }
  private epochFor(owner: PiQuestionOwner) {
    return this.epoch?.owner.runId === owner.runId &&
      this.epoch.owner.turnId === owner.turnId
      ? this.epoch
      : undefined
  }
  private envelope(owner: PiQuestionOwner) {
    return {
      runId: owner.runId,
      turnId: owner.turnId,
      runtimeGeneration: this.generation,
      deliveryId: this.nextId(),
    }
  }
  private charge(size: number, epoch?: Epoch) {
    PublicationBudget.charge(
      size,
      this.generationBudget,
      epoch?.budget ?? this.idleBudget,
    )
  }
  private publish(event: HarnessEvent, epoch?: Epoch, failure = false) {
    if (this.failure && !failure) return
    const clean = harnessEventSchema.parse(event)
    if (failure) PublicationBudget.charge(bytes(clean), this.failureBudget)
    else this.charge(bytes(clean), epoch)
    this.emit(freeze(clean))
  }
  private async saveSnapshot(value: Parameters<PersistPiSnapshot>[1]) {
    check(this.controller.signal)
    const frozen = freeze(value)
    const size = bytes(frozen)
    this.charge(size, this.epoch)
    await physicalWork(
      'sink',
      this.controller.signal,
      this.config.sinkMs,
      () =>
        this.deps.persistSnapshot(this.owner, frozen, this.controller.signal),
      size,
    )
    check(this.controller.signal)
  }
  async start(target?: PiResumeTarget) {
    const deadline = this.now() + this.config.startupMs
    const timer = setTimeout(
      () => this.poison(new PiError('PI_STARTUP_DEADLINE')),
      this.config.startupMs,
    )
    let held: ValidatedResume | undefined
    try {
      await verifyVersion(
        this.launch.executable,
        this.controller.signal,
        this.config,
      )
      if (target)
        held = await validateResume(
          target.binding,
          this.launch.root,
          this.controller.signal,
          this.config,
        )
      check(this.controller.signal)
      await held?.verify()
      const result = await startNativeProcess(
        {
          command: this.launch.executable,
          args: [
            '--mode',
            'rpc',
            '--offline',
            '--session-dir',
            this.launch.root,
            ...this.launch.args,
            ...(target ? ['--session', target.binding.sessionFile] : []),
          ],
          cwd: this.session.cwd,
          env: environmentAtLaunch(this.launch),
          signal: this.controller.signal,
          secrets: this.launch.secrets,
          startupTimeoutMs: Math.max(1, Math.ceil(deadline - this.now())),
          stderrLimit: 64 * 1024,
        },
        async (process) => {
          try {
            this.process = process
            void process.done.then(() => {
              for (const release of this.writingInputs) release()
              this.writingInputs.clear()
            })
            this.transport = new JsonlTransport({
              stdin: process.child.stdin,
              stdout: process.child.stdout,
              maxLineBytes: this.config.maxLineBytes,
              maxQueuedBytes: this.config.maxOutboundBytes,
              maxQueuedFrames: this.config.maxOutboundFrames,
              onValue: (value) => {
                try {
                  this.receive(value)
                } catch (error) {
                  this.poison(reason(error))
                }
              },
            })
            this.router = new PiRouter(
              this.generation,
              this.transport,
              this.config,
              (error) => this.poison(reason(error)),
            )
            process.ownTransport(this.transport)
            void this.transport.done.then(() =>
              this.poison(new PiError('PI_PROCESS_EXIT')),
            )
            const first = stateSchema.parse(
              (await this.command('get_state')).data,
            )
            if (
              first.isStreaming ||
              first.isCompacting ||
              first.pendingMessageCount
            )
              fail('PI_STARTUP_ACTIVITY')
            const binding = bindingFromState(this.session, first)
            if (target) verifyStateBinding(target.binding, first)
            await canonicalSessionPath(
              this.launch.root,
              binding.sessionFile,
              !target,
            )
            this.state = stateSnapshot(first, false)
            await this.refreshCatalog(false)
            const final = stateSchema.parse(
              (await this.command('get_state')).data,
            )
            verifyStateBinding(binding, final)
            if (
              final.isStreaming ||
              final.isCompacting ||
              final.pendingMessageCount
            )
              fail('PI_STARTUP_ACTIVITY')
            await held?.verify()
            this.observedFile = await observeFreshFile(
              binding,
              this.launch.root,
              this.controller.signal,
              this.config,
              !!held,
            )
            this.state = stateSnapshot(final, !!this.observedFile)
            this.baseline = this.state
            this.bindingValue = binding
            await this.saveSnapshot({ kind: 'state', value: this.state })
            await this.saveSnapshot({ kind: 'catalog', value: this.catalog })
            this.drainRecords()
            await this.waitCommitted(this.ordinal)
            check(this.controller.signal)
            this.startup = false
          } catch (error) {
            this.poison(reason(error))
            throw error
          }
        },
      )
      this.process = result.process
    } catch (error) {
      this.bindingValue = null
      throw this.failure ?? error
    } finally {
      clearTimeout(timer)
      await held?.close()
    }
  }
  private async command(
    command: Parameters<PiRouter['request']>[0],
    data?: Record<string, unknown>,
    urgent = false,
  ): Promise<PiResponse> {
    if (this.failure && !urgent) throw this.failure
    const response = await this.router!.request(command, data, urgent)
    if (!response.success)
      fail('PI_NATIVE_COMMAND_REJECTED', 'Pi rejected the command.')
    return response
  }
  private async refreshCatalog(persist = true) {
    const models = (await this.command('get_available_models')).data as {
      models: NonNullable<PiStateSnapshot['model']>[]
    }
    const thinking = (await this.command('get_available_thinking_levels'))
      .data as { levels: string[] }
    const commands = (await this.command('get_commands')).data as {
      commands: PiCatalogSnapshot['commands']
    }
    const catalog = freeze({
      ...this.catalog,
      models: models.models.map((model) => ({
        ...model,
        catalogId: modelKey(model.provider, model.id),
      })),
      thinkingLevels: thinking.levels,
      commands: commands.commands,
    })
    if (bytes(catalog.models) > 4 * MiB || bytes(catalog.commands) > 2 * MiB)
      fail('PI_CATALOG_LIMIT')
    this.catalog = catalog
    if (persist) await this.saveSnapshot({ kind: 'catalog', value: catalog })
    return snapshot(catalog, 8 * MiB)
  }
  private refreshState(): Promise<PiStateSnapshot> {
    if (this.stateFlight) return this.stateFlight
    this.stateFlight = this.readState().finally(() => {
      this.stateFlight = undefined
    })
    return this.stateFlight
  }
  private async readState() {
    const native = stateSchema.parse((await this.command('get_state')).data)
    if (this.bindingValue) {
      verifyStateBinding(this.bindingValue, native)
      const observed = await observeFreshFile(
        this.bindingValue,
        this.launch.root,
        this.controller.signal,
        this.config,
      )
      if (
        this.observedFile &&
        (!observed ||
          observed.dev !== this.observedFile.dev ||
          observed.ino !== this.observedFile.ino ||
          observed.size < this.observedFile.size)
      )
        fail('PI_RESUME_IDENTITY_CHANGED')
      if (native.messageCount > 0 && !observed) fail('PI_SESSION_FILE_MISSING')
      this.observedFile = observed
    }
    this.state = stateSnapshot(native, !!this.observedFile)
    await this.saveSnapshot({ kind: 'state', value: this.state })
    return this.state
  }
  private async control<T>(callback: () => Promise<T>): Promise<T> {
    if (this.failure) throw this.failure
    if (this.epoch || this.admission || this.configuring || this.startup)
      fail('PI_CONFIGURATION_BUSY')
    this.configuring = true
    try {
      return await callback()
    } catch (error) {
      if (
        !(error instanceof PiError) ||
        error.code !== 'PI_NATIVE_COMMAND_REJECTED'
      )
        this.poison(reason(error))
      throw error
    } finally {
      this.configuring = false
    }
  }
  private configOptions(): SessionConfigOption[] {
    const selected = this.state?.model
    return [
      {
        id: 'model',
        name: 'Model',
        type: 'select',
        currentValue: selected ? modelKey(selected.provider, selected.id) : '',
        options: this.catalog.models.map((model) => ({
          value: model.catalogId,
          name: model.name ?? model.id,
        })),
      },
      {
        id: 'thinking',
        name: 'Thinking',
        type: 'select',
        currentValue: this.state?.thinkingLevel ?? '',
        options: this.catalog.thinkingLevels.map((value) => ({
          value,
          name: value,
        })),
      },
      ...(['steeringMode', 'followUpMode'] as const).map((key) => ({
        id: key,
        name: key === 'steeringMode' ? 'Steering mode' : 'Follow-up mode',
        type: 'select' as const,
        currentValue: this.state?.[key] ?? 'one-at-a-time',
        options: ['all', 'one-at-a-time'].map((value) => ({
          value,
          name: value,
        })),
      })),
    ]
  }
  private validateOptions(options: DispatchOptions) {
    if (
      options.permissionMode !== 'manual' ||
      options.approvalPolicy != null ||
      options.sandboxPolicy != null ||
      options.serviceTier != null
    )
      fail('PI_POLICY_UNSUPPORTED')
  }
  private optionValues(options: DispatchOptions) {
    this.validateOptions(options)
    let model = this.state?.model
    if (options.model === null) {
      if (!this.baseline?.model) fail('PI_MODEL_RESET_UNAVAILABLE')
      model = this.baseline.model
    } else if (options.model !== undefined) {
      model = this.catalog.models.find((m) => m.catalogId === options.model)
      if (!model) fail('PI_MODEL_UNAVAILABLE')
    }
    return {
      model,
      thinking:
        options.reasoning === null
          ? this.baseline?.thinkingLevel
          : (options.reasoning ?? this.state?.thinkingLevel),
    }
  }
  private async applyOptions(options: DispatchOptions) {
    await this.stateFlight
    const wanted = this.optionValues(options)
    const current = this.state?.model
    const changed =
      wanted.model &&
      (!current ||
        wanted.model.provider !== current.provider ||
        wanted.model.id !== current.id)
    try {
      if (changed) {
        await this.command('set_model', {
          provider: wanted.model!.provider,
          modelId: wanted.model!.id,
        })
        const response = await this.command('get_available_thinking_levels')
        this.catalog = freeze({
          ...this.catalog,
          thinkingLevels: (response.data as { levels: string[] }).levels,
        })
      }
      if (
        wanted.thinking !== undefined &&
        !this.catalog.thinkingLevels.includes(wanted.thinking)
      )
        fail('PI_THINKING_UNSUPPORTED')
      if (
        wanted.thinking !== undefined &&
        wanted.thinking !== this.state?.thinkingLevel
      )
        await this.command('set_thinking_level', { level: wanted.thinking })
      if (changed || wanted.thinking !== this.state?.thinkingLevel) {
        const actual = await this.refreshState()
        if (
          actual.model?.provider !== wanted.model?.provider ||
          actual.model?.id !== wanted.model?.id ||
          actual.thinkingLevel !== wanted.thinking
        )
          fail('PI_CONFIGURATION_CLAMPED')
      }
    } catch (error) {
      if (!this.failure) await this.refreshState()
      throw error
    }
  }
  private makeAttempt(
    command: PiReceipt['command'],
    identity?: { runId: string; turnId: string },
  ): Attempt {
    const runId = identity?.runId ?? this.nextId()
    const turnId = identity?.turnId ?? this.nextId()
    const accepted = deferred<PiAcceptance>()
    const delivered = deferred<PiDelivery>()
    const completion = createCompletionHandle({
      completionId: this.nextId(),
      runId,
      turnId,
    })
    const receipt = freeze({
      command,
      receiptId: this.nextId(),
      runId,
      turnId,
      acceptance: accepted.promise,
      delivery: delivered.promise,
      completion: completion.handle,
      settlementScope: 'session_operation' as const,
    })
    return {
      receipt,
      accepted,
      delivered,
      completion,
      controller: new AbortController(),
      sent: false,
      finished: false,
      prepared: false,
      options: { permissionMode: 'manual' },
    }
  }
  private makeEpoch(root: Attempt | null, owner?: PiQuestionOwner): Epoch {
    const actualOwner = owner ?? {
      runId: root?.receipt.runId ?? this.nextId(),
      turnId: root?.receipt.turnId ?? this.nextId(),
    }
    let epoch!: Epoch
    epoch = {
      owner: freeze(actualOwner),
      root,
      started: false,
      lowActive: false,
      ended: false,
      retry: false,
      permit: false,
      compacting: false,
      revision: 0,
      terminal: false,
      extensionError: false,
      automatic: root === null,
      cancelling: false,
      timer: setTimeout(
        () => this.poison(new PiError('PI_OPERATION_DEADLINE')),
        this.config.operationMs,
      ),
      normalizer: new PiNormalizer(
        { ...actualOwner, runtimeGeneration: this.generation },
        this.config,
        (event) => {
          if (this.stagedEvents) this.stagedEvents.push(event)
          else this.publish(event, epoch)
        },
        this.nextId,
        this.launch.secrets,
      ),
      budget: new PublicationBudget(
        this.config.operationPublications,
        this.config.operationPublicationBytes,
      ),
    }
    return epoch
  }
  private dispatch(
    command: PiReceipt['command'],
    input: PromptInput[] | string,
    options?: DispatchOptions,
    identityInput?: { runId: string; turnId: string },
  ): PiReceipt {
    // Reserve admission before getters, identity copies, attachment reads, and setters.
    const available =
      !this.failure &&
      !this.startup &&
      !this.admission &&
      !this.configuring &&
      !this.idleRole &&
      (command === 'prompt'
        ? !this.epoch
        : !!this.epoch?.lowActive &&
          !this.epoch.queued &&
          !this.epoch.compacting &&
          !this.epoch.terminal)
    if (!available) {
      const priorAdmission = this.admission
      this.admission = true
      try {
        let identity: { runId: string; turnId: string } | undefined
        try {
          identity = identityInput
            ? z
                .strictObject({ runId: id, turnId: id })
                .parse(snapshot(identityInput))
            : undefined
        } catch {
          /* Invalid identities receive local IDs. */
        }
        const rejected = this.makeAttempt(command, identity)
        this.finishAttempt(rejected, {
          status: 'failed',
          code: this.failure?.code ?? 'PI_ADMISSION_REJECTED',
          message: this.failure?.message ?? 'Pi cannot accept this input now.',
        })
        return rejected.receipt
      } finally {
        this.admission = priorAdmission
      }
    }
    this.admission = true
    let attempt: Attempt | undefined
    let epoch: Epoch | undefined
    try {
      const identity = identityInput
        ? z
            .strictObject({ runId: id, turnId: id })
            .parse(snapshot(identityInput))
        : undefined
      attempt = this.makeAttempt(command, identity)
      if (command === 'prompt') {
        epoch = this.makeEpoch(attempt)
        this.epoch = epoch
      } else {
        epoch = this.epoch!
        epoch.queued = attempt
      }
      const captured = captureInput(input)
      if (command !== 'prompt' && !captured.message)
        fail('PI_EMPTY_TEXT_NATIVE_QUEUE_UNSUPPORTED')
      attempt.options = freeze(
        dispatchOptionsSchema.parse(
          snapshot(options ?? { permissionMode: 'manual' }),
        ),
      )
      this.validateOptions(attempt.options)
      if (this.failure || epoch !== this.epoch || epoch.terminal)
        throw this.failure ?? new PiError('PI_CANCELLED')
      const identityKey = JSON.stringify([
        attempt.receipt.runId,
        attempt.receipt.turnId,
      ])
      if (this.attempts.has(identityKey)) fail('PI_DUPLICATE_RECEIPT_IDENTITY')
      if (this.attempts.size >= this.config.maxReceipts)
        fail('PI_RECEIPT_LIMIT')
      if (command !== 'prompt') {
        const wanted = this.optionValues(attempt.options)
        if (
          wanted.model?.id !== this.state?.model?.id ||
          wanted.model?.provider !== this.state?.model?.provider ||
          wanted.thinking !== this.state?.thinkingLevel
        )
          fail('PI_QUEUE_CONFIGURATION_CHANGED')
      }
      this.attempts.add(identityKey)
      const heldAttempt = attempt
      const heldEpoch = epoch
      void Promise.resolve()
        .then(async () => {
          check(heldAttempt.controller.signal)
          const prepared = await prepareInput(
            captured,
            this.session.id,
            this.deps.loadImage,
            heldAttempt.controller.signal,
            this.config,
          )
          try {
            this.checkAttempt(heldAttempt, heldEpoch)
            if (command === 'prompt')
              await this.applyOptions(heldAttempt.options)
            this.checkAttempt(heldAttempt, heldEpoch)
            if (
              command !== 'prompt' &&
              (!heldEpoch.lowActive ||
                heldEpoch.compacting ||
                heldEpoch.candidate !== undefined)
            )
              fail('PI_QUEUE_OWNER_ENDED')
            if (
              bytes({ type: command, ...prepared }) >
              this.config.maxLineBytes - 512
            )
              fail('PI_INPUT_FRAME_LIMIT')
            heldAttempt.prepared = true
            const responsePromise = this.router!.request(
              command,
              { message: prepared.message, images: prepared.images },
              false,
              () => {
                heldAttempt.sent = true
                this.writingInputs.add(prepared.release)
              },
              () => {
                this.writingInputs.delete(prepared.release)
                prepared.release()
              },
            )
            if (heldAttempt.sent && captured.attachmentIds.length)
              void this.record(
                {
                  type: 'custom',
                  customType: 'forge.pi.input',
                  data: {
                    receiptId: heldAttempt.receipt.receiptId,
                    command,
                    attachmentIds: captured.attachmentIds,
                  },
                },
                [],
                heldEpoch,
              ).catch((error) => this.poison(reason(error)))
            const response = await responsePromise
            this.checkAttempt(heldAttempt, heldEpoch)
            if (!response.success) {
              heldAttempt.accepted.resolve({
                status: 'rejected',
                code: 'PI_NATIVE_PREFLIGHT_REJECTED',
                message: 'Pi rejected this input.',
              })
              if (command === 'prompt')
                this.complete(heldEpoch, {
                  status: 'failed',
                  code: 'PI_NATIVE_PREFLIGHT_REJECTED',
                  message: 'Pi rejected this input.',
                })
              else {
                this.finishAttempt(heldAttempt, {
                  status: 'failed',
                  code: 'PI_NATIVE_PREFLIGHT_REJECTED',
                  message: 'Pi rejected this input.',
                })
                heldEpoch.queued = undefined
              }
              return
            }
            heldAttempt.accepted.resolve({ status: 'accepted', command })
            this.publish(
              {
                ...this.envelope(heldAttempt.receipt),
                type:
                  command === 'steer' ? 'steer_accepted' : 'prompt_accepted',
                receiptId: heldAttempt.receipt.receiptId,
              },
              heldEpoch,
            )
            if (command !== 'prompt')
              heldAttempt.delivered.resolve({
                status: 'unconfirmed',
                reason: 'Native queue events contain no unique input identity.',
              })
            if (heldEpoch.started && command === 'prompt')
              heldAttempt.delivered.resolve({
                status: 'agent_work_observed',
                scope: 'session_operation',
              })
            this.scheduleBarrier(heldEpoch)
          } finally {
            if (!heldAttempt.sent) prepared.release()
          }
        })
        .catch((error) => {
          if (heldAttempt.finished || heldEpoch.cancelling) return
          if (heldAttempt.sent) this.poison(reason(error))
          else if (command === 'prompt')
            this.complete(heldEpoch, {
              status: 'failed',
              ...reasonFields(error),
            })
          else {
            this.finishAttempt(heldAttempt, {
              status: 'failed',
              ...reasonFields(error),
            })
            if (heldEpoch.queued === heldAttempt) heldEpoch.queued = undefined
            this.scheduleBarrier(heldEpoch)
          }
        })
      return attempt.receipt
    } catch (error) {
      attempt ??= this.makeAttempt(command)
      this.finishAttempt(attempt, { status: 'failed', ...reasonFields(error) })
      if (epoch?.root === attempt && this.epoch === epoch) {
        clearTimeout(epoch.timer)
        this.epoch = undefined
      } else if (epoch?.queued === attempt) epoch.queued = undefined
      return attempt.receipt
    } finally {
      this.admission = false
    }
  }
  private checkAttempt(attempt: Attempt, epoch: Epoch) {
    check(attempt.controller.signal)
    if (
      this.failure ||
      epoch !== this.epoch ||
      epoch.terminal ||
      attempt.finished
    )
      throw this.failure ?? new PiError('PI_OPERATION_EXPIRED')
  }
  private finishAttempt(attempt: Attempt, outcome: TerminalOutcome) {
    if (attempt.finished) return
    attempt.finished = true
    attempt.controller.abort()
    if (!attempt.accepted.resolved)
      attempt.accepted.resolve({
        status: attempt.sent ? 'unknown' : 'rejected',
        code: outcome.status === 'failed' ? outcome.code : 'PI_CANCELLED',
        message:
          outcome.status === 'failed'
            ? outcome.message
            : 'Pi input was cancelled.',
      })
    if (!attempt.delivered.resolved)
      attempt.delivered.resolve({
        status: attempt.sent ? 'unconfirmed' : 'not_sent',
        reason: outcome.status === 'failed' ? outcome.code : 'PI_CANCELLED',
      })
    attempt.completion.settle({
      ...outcome,
      runId: attempt.receipt.runId,
      turnId: attempt.receipt.turnId,
    })
  }
  private complete(epoch: Epoch, outcome: TerminalOutcome, failure = false) {
    if (epoch.terminal) return
    const events: HarnessEvent[] = [
      { ...this.envelope(epoch.owner), type: 'turn_completed', outcome },
    ]
    if (epoch.queued)
      events.push({
        ...this.envelope(epoch.queued.receipt),
        type: 'turn_completed',
        outcome,
      })
    try {
      for (const event of events) {
        if (failure) PublicationBudget.charge(bytes(event), this.failureBudget)
        else this.charge(bytes(event), epoch)
      }
    } catch (error) {
      if (!failure) {
        this.poison(reason(error))
        return
      }
    }
    try {
      this.questions.expireOwner(epoch.owner, 'Pi operation ended')
    } catch (error) {
      if (!failure) {
        this.poison(reason(error))
        return
      }
    }
    epoch.terminal = true
    clearTimeout(epoch.timer)
    epoch.permit = false
    if (epoch.root) this.finishAttempt(epoch.root, outcome)
    if (epoch.queued) this.finishAttempt(epoch.queued, outcome)
    try {
      for (const event of events) this.emit(freeze(event))
    } catch (error) {
      if (!failure) this.poison(reason(error))
    }
    if (this.epoch === epoch) this.epoch = undefined
  }
  private record(
    body: PiRecordBody,
    itemIds: string[],
    epoch?: Epoch,
  ): Promise<void> {
    if (this.failure) return Promise.reject(this.failure)
    const source = {
      kind: 'live' as const,
      runtimeGeneration: this.generation,
      ordinal: this.ordinal + 1,
      ...(epoch ? epoch.owner : {}),
      forgeItemIds: itemIds,
    }
    const record = freeze({ source, body: bodySchema.parse(body) })
    const image = hasWireImage(record)
    const rawSize = bytes(record)
    if (image && (this.incomingImage || rawSize > this.config.maxLineBytes))
      fail('PI_INCOMING_IMAGE_LIMIT')
    const size = image ? 0 : rawSize
    if (
      this.recordQueue.length >= this.config.maxRecordQueue ||
      this.recordBytes + size > this.config.maxRecordBytes
    )
      fail('PI_RECORD_QUEUE_LIMIT')
    const done = deferred<void>()
    const releaseImage = image ? reservePhysical('image') : undefined
    this.ordinal = source.ordinal
    if (image) this.incomingImage = true
    this.recordQueue.push({ record, size, image, releaseImage, epoch, done })
    this.recordBytes += size
    this.drainRecords()
    return this.waitCommitted(source.ordinal)
  }
  private drainRecords() {
    if (this.draining || !this.bindingValue || this.failure) return
    this.draining = true
    void (async () => {
      while (this.recordQueue.length && !this.failure) {
        const job = this.recordQueue[0]!
        const releaseImage = job.releaseImage
        job.releaseImage = undefined
        let transformed: PiNativeRecord
        let imageSettled = false
        let retained = true
        try {
          transformed = await persistWireImages(
            job.record!,
            this.owner,
            this.deps.persistImage,
            this.controller.signal,
            this.config,
            (size) => this.charge(size, job.epoch),
            releaseImage
              ? () => {
                  imageSettled = true
                  if (!retained) releaseImage()
                }
              : undefined,
          )
        } finally {
          job.record = undefined
          retained = false
          if (imageSettled) releaseImage?.()
        }
        check(this.controller.signal)
        const size = bytes(transformed)
        if (job.image) {
          if (this.recordBytes + size > this.config.maxRecordBytes)
            fail('PI_RECORD_QUEUE_LIMIT')
          job.size = size
          this.recordBytes += size
          this.incomingImage = false
        }
        this.charge(size, job.epoch)
        await physicalWork(
          'sink',
          this.controller.signal,
          this.config.sinkMs,
          () =>
            this.deps.persistRecord(
              this.owner,
              this.bindingValue!,
              transformed,
              this.controller.signal,
            ),
          size,
        )
        check(this.controller.signal)
        this.committed = transformed.source.ordinal
        this.recordQueue.shift()
        this.recordBytes -= job.size
        job.done.resolve()
        this.drainWaiters = this.drainWaiters.filter((waiter) => {
          if (waiter.ordinal <= this.committed) {
            waiter.resolve()
            return false
          }
          return true
        })
      }
    })()
      .catch((error) => this.poison(reason(error)))
      .finally(() => {
        this.draining = false
      })
  }
  private waitCommitted(ordinal: number): Promise<void> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.committed >= ordinal) return Promise.resolve()
    return new Promise((resolve, reject) =>
      this.drainWaiters.push({ ordinal, resolve, reject }),
    )
  }
  private scheduleBarrier(epoch: Epoch) {
    if (this.barrier || this.failure || epoch.terminal || epoch.cancelling)
      return
    if (epoch.root && !epoch.root.accepted.resolved) return
    if (
      epoch.queued &&
      (!epoch.queued.prepared || !epoch.queued.accepted.resolved)
    )
      return
    if (epoch.started && epoch.candidate === undefined) return
    const revision = epoch.revision
    this.barrier = (async () => {
      const state = await this.refreshState()
      if (
        this.failure ||
        epoch !== this.epoch ||
        epoch.terminal ||
        epoch.cancelling ||
        epoch.revision !== revision
      )
        return
      if (
        state.isStreaming ||
        state.isCompacting ||
        epoch.lowActive ||
        epoch.retry ||
        epoch.compacting
      )
        return
      if (state.pendingMessageCount)
        fail(
          'PI_QUEUE_ACCOUNTING_UNCERTAIN',
          'Native queue bookkeeping cannot prove operation settlement.',
        )
      if (epoch.started && epoch.candidate !== revision) return
      if (epoch.normalizer.hasOpenMessage) fail('PI_INCOMPLETE_MESSAGE')
      let finalOrdinal: number
      do {
        this.questions.expireOwner(epoch.owner, 'Pi operation settled')
        finalOrdinal = this.ordinal
        await this.waitCommitted(finalOrdinal)
        if (
          this.failure ||
          epoch !== this.epoch ||
          epoch.terminal ||
          epoch.cancelling ||
          epoch.revision !== revision
        )
          return
        if (epoch.normalizer.hasOpenMessage) fail('PI_INCOMPLETE_MESSAGE')
        this.questions.expireOwner(epoch.owner, 'Pi operation settled')
        if (this.questions.pendingCount) return
      } while (finalOrdinal !== this.ordinal)
      if (
        this.failure ||
        epoch !== this.epoch ||
        epoch.terminal ||
        epoch.revision !== revision
      )
        return
      if (epoch.root && !epoch.started)
        epoch.root.delivered.resolve({
          status: 'handled_without_agent',
          scope: 'command',
        })
      let outcome: TerminalOutcome = { status: 'completed' }
      if (epoch.extensionError)
        outcome = {
          status: 'failed',
          code: 'PI_EXTENSION_ERROR',
          message: 'A Pi extension failed while handling the input.',
        }
      else if (epoch.started) {
        const final = epoch.normalizer.finalAssistant
        if (final?.stopReason === 'aborted')
          outcome = {
            status: 'interrupted',
            reason: 'Pi reported an aborted response.',
          }
        else if (final?.stopReason === 'error')
          outcome = {
            status: 'failed',
            code: 'PI_ASSISTANT_ERROR',
            message: 'Pi reported a final response error.',
          }
        else if (!final || !['stop', 'length'].includes(final.stopReason))
          outcome = {
            status: 'failed',
            code: 'PI_NATIVE_CONTINUATION_UNSUPPORTED',
            message: 'Pi ended without a supported final response.',
          }
        else if (final.stopReason === 'length')
          this.diagnostic(
            epoch,
            'PI_OUTPUT_TRUNCATED',
            'Pi reached its output limit.',
          )
      }
      this.complete(epoch, outcome)
    })()
      .catch((error) => this.poison(reason(error)))
      .finally(() => {
        this.barrier = undefined
        if (
          !this.failure &&
          this.epoch === epoch &&
          !epoch.terminal &&
          epoch.revision !== revision &&
          epoch.candidate !== undefined
        )
          this.scheduleBarrier(epoch)
      })
  }
  private diagnostic(
    epoch: Epoch,
    code: string,
    message: string,
    retryable?: boolean,
  ) {
    this.publish(
      {
        ...this.envelope(epoch.owner),
        type: 'diagnostic',
        itemId: this.nextId(),
        code,
        message,
        severity: 'warning',
        ...(retryable === undefined ? {} : { retryable }),
      },
      epoch,
    )
  }
  private progress(epoch: Epoch, value: Record<string, unknown>) {
    const data = { ...value }
    for (const key of ['errorMessage', 'finalError', 'error']) {
      if (typeof data[key] !== 'string') continue
      data[key] = redactSecrets(data[key], this.launch.secrets)
    }
    void this.record(
      { type: 'custom', customType: 'forge.pi.progress', data },
      [],
      epoch,
    ).catch((error) => this.poison(reason(error)))
  }
  private receive(value: unknown) {
    if (this.failure) return
    const frame = z
      .object({ type: text(256).min(1) })
      .passthrough()
      .parse(value)
    if (frame.type === 'response') {
      this.router!.receive(value)
      return
    }
    if (frame.type === 'extension_ui_request') {
      this.questions.receive(
        value,
        this.startup ? undefined : this.epoch?.owner,
      )
      return
    }
    if (frame.type === 'extension_error') {
      z.strictObject({
        type: z.literal('extension_error'),
        extensionPath: text(),
        event: text(),
        error: text(),
      }).parse(value)
      if (this.epoch) {
        this.epoch.extensionError = true
        this.progress(this.epoch, frame)
        this.diagnostic(
          this.epoch,
          'PI_EXTENSION_ERROR',
          'A Pi extension reported an error.',
        )
      } else
        this.catalog = freeze({
          ...this.catalog,
          startupNotices: [
            ...this.catalog.startupNotices,
            'A Pi extension reported an error.',
          ].slice(-64),
        })
      return
    }
    if (this.startup) {
      if (
        /^(agent_|message_|turn_|tool_execution_|compaction_|auto_retry_)/.test(
          frame.type,
        )
      )
        fail('PI_STARTUP_ACTIVITY')
      return this.unknown(frame.type)
    }
    if (frame.type === 'agent_start') {
      z.strictObject({ type: z.literal('agent_start') }).parse(value)
      let epoch = this.epoch
      if (!epoch) {
        if (this.configuring || this.admission || this.idleRole)
          fail('PI_ACTIVITY_OWNERSHIP_UNCERTAIN')
        epoch = this.makeEpoch(null)
        this.epoch = epoch
      }
      if (epoch.lowActive || (epoch.ended && !epoch.permit))
        fail(
          'PI_ACTIVITY_OWNERSHIP_UNCERTAIN',
          'Pi started unmatched work before the earlier settlement hook finished.',
        )
      epoch.permit = false
      epoch.retry = false
      epoch.lowActive = true
      epoch.ended = false
      epoch.revision++
      epoch.candidate = undefined
      if (!epoch.started) {
        epoch.started = true
        epoch.root?.delivered.resolve({
          status: 'agent_work_observed',
          scope: 'session_operation',
        })
        this.publish(
          { ...this.envelope(epoch.owner), type: 'run_started' },
          epoch,
        )
        this.publish(
          { ...this.envelope(epoch.owner), type: 'turn_started' },
          epoch,
        )
      }
      return
    }
    const epoch = this.epoch
    if (!epoch) {
      if (frame.type === 'message_start') {
        if (this.idleRole) fail('PI_OVERLAPPING_MESSAGE')
        this.idleRole = decodeMessage(frame.message, this.launch.secrets).role
        return
      }
      if (frame.type === 'message_end') {
        const message = decodeMessage(frame.message, this.launch.secrets)
        if (this.idleRole && this.idleRole !== message.role)
          fail('PI_MESSAGE_ROLE_CHANGED')
        this.idleRole = undefined
        void this.record({ type: 'message', message }, []).catch((error) =>
          this.poison(reason(error)),
        )
        return
      }
      if (
        [
          'message_update',
          'agent_end',
          'tool_execution_start',
          'tool_execution_update',
          'tool_execution_end',
        ].includes(frame.type)
      )
        fail('PI_ACTIVITY_OWNERSHIP_UNCERTAIN')
      return this.unknown(frame.type)
    }
    switch (frame.type) {
      case 'agent_end':
        z.strictObject({
          type: z.literal('agent_end'),
          messages: z.array(z.unknown()),
          willRetry: z.boolean(),
        }).parse(value)
        if (!epoch.lowActive) fail('PI_ACTIVITY_OWNERSHIP_UNCERTAIN')
        epoch.lowActive = false
        epoch.ended = true
        epoch.permit = false
        epoch.revision++
        epoch.candidate = undefined
        break
      case 'agent_settled':
        z.strictObject({ type: z.literal('agent_settled') }).parse(value)
        if (epoch.queued && !epoch.queued.sent) {
          this.finishAttempt(epoch.queued, {
            status: 'failed',
            code: 'PI_QUEUE_OWNER_ENDED',
            message: 'Pi settled before queue preparation finished.',
          })
          epoch.queued = undefined
        }
        epoch.permit = false
        epoch.candidate = epoch.revision
        this.scheduleBarrier(epoch)
        break
      case 'auto_retry_start': {
        z.strictObject({
          type: z.literal('auto_retry_start'),
          attempt: count,
          maxAttempts: count,
          delayMs: count,
          errorMessage: text(),
        }).parse(value)
        if (epoch.lowActive || !epoch.ended || epoch.permit || epoch.retry)
          fail('PI_ACTIVITY_OWNERSHIP_UNCERTAIN')
        epoch.retry = true
        epoch.permit = true
        epoch.revision++
        epoch.candidate = undefined
        this.progress(epoch, frame)
        this.diagnostic(
          epoch,
          'PI_AUTO_RETRY',
          'Pi will retry the native response.',
          true,
        )
        break
      }
      case 'auto_retry_end': {
        const retry = z
          .strictObject({
            type: z.literal('auto_retry_end'),
            success: z.boolean(),
            attempt: count,
            finalError: text().optional(),
          })
          .parse(value)
        epoch.retry = false
        if (!retry.success) epoch.permit = false
        epoch.revision++
        epoch.candidate = undefined
        this.progress(epoch, frame)
        this.diagnostic(
          epoch,
          'PI_AUTO_RETRY_END',
          retry.success ? 'Pi recovered the response.' : 'Pi ended its retry.',
          retry.success,
        )
        break
      }
      case 'compaction_start':
        z.strictObject({
          type: z.literal('compaction_start'),
          reason: z.enum(['manual', 'threshold', 'overflow']),
        }).parse(value)
        epoch.compacting = true
        epoch.revision++
        epoch.candidate = undefined
        this.progress(epoch, frame)
        this.diagnostic(
          epoch,
          'PI_COMPACTION',
          'Pi started context compaction.',
        )
        break
      case 'compaction_end': {
        const compact = z
          .strictObject({
            type: z.literal('compaction_end'),
            reason: z.enum(['manual', 'threshold', 'overflow']),
            aborted: z.boolean(),
            willRetry: z.boolean(),
            errorMessage: text().optional(),
            result: z
              .strictObject({
                summary: text(4 * MiB),
                firstKeptEntryId: id,
                tokensBefore: count,
                estimatedTokensAfter: count.optional(),
                details: z.unknown().optional(),
                usage: usageSchema.optional(),
              })
              .optional(),
          })
          .parse(value)
        epoch.compacting = false
        epoch.revision++
        epoch.candidate = undefined
        this.progress(epoch, {
          type: compact.type,
          reason: compact.reason,
          aborted: compact.aborted,
          willRetry: compact.willRetry,
          errorMessage: compact.errorMessage,
          estimatedTokensAfter: compact.result?.estimatedTokensAfter,
        })
        this.diagnostic(
          epoch,
          'PI_COMPACTION_END',
          'Pi ended context compaction.',
        )
        if (compact.result) {
          const { estimatedTokensAfter: _estimate, ...result } = compact.result
          void this.record(
            bodySchema.parse({ type: 'compaction', ...result }),
            [],
            epoch,
          ).catch((error) => this.poison(reason(error)))
        }
        break
      }
      case 'summarization_retry_scheduled':
        z.strictObject({
          type: z.literal('summarization_retry_scheduled'),
          attempt: count,
          maxAttempts: count,
          delayMs: count,
          errorMessage: text(),
        }).parse(value)
        this.progress(epoch, frame)
        this.diagnostic(
          epoch,
          'PI_SUMMARIZATION_RETRY',
          'Pi scheduled another summary attempt.',
          true,
        )
        break
      case 'summarization_retry_attempt_start':
        z.strictObject({
          type: z.literal('summarization_retry_attempt_start'),
          source: z.enum(['compaction', 'branchSummary']),
          reason: z.enum(['manual', 'threshold', 'overflow']).optional(),
        }).parse(value)
        this.progress(epoch, frame)
        this.diagnostic(
          epoch,
          'PI_SUMMARIZATION_RETRY_START',
          'Pi started another summary attempt.',
          true,
        )
        break
      case 'summarization_retry_finished':
        z.strictObject({
          type: z.literal('summarization_retry_finished'),
        }).parse(value)
        this.progress(epoch, frame)
        this.diagnostic(
          epoch,
          'PI_SUMMARIZATION_RETRY_END',
          'Pi ended the summary retry.',
        )
        break
      case 'queue_update': {
        const queue = z
          .strictObject({
            type: z.literal('queue_update'),
            steering: z.array(text(MiB)).max(128),
            followUp: z.array(text(MiB)).max(128),
          })
          .parse(value)
        if (
          queue.steering.length + queue.followUp.length > 128 ||
          bytes(queue) > MiB
        )
          fail('PI_QUEUE_LIMIT')
        this.progress(epoch, queue)
        epoch.revision++
        epoch.candidate = undefined
        break
      }
      case 'message_start':
        epoch.normalizer.start(frame.message)
        break
      case 'message_update':
        epoch.normalizer.update(frame.assistantMessageEvent)
        break
      case 'message_end': {
        const staged: HarnessEvent[] = []
        this.stagedEvents = staged
        try {
          const final = epoch.normalizer.end(frame.message)
          void this.record(
            { type: 'message', message: final.message },
            final.itemIds,
            epoch,
          ).catch((error) => this.poison(reason(error)))
        } finally {
          this.stagedEvents = undefined
        }
        for (const event of staged) this.publish(event, epoch)
        break
      }
      case 'tool_execution_start':
        epoch.normalizer.toolStart(value)
        break
      case 'tool_execution_update':
        epoch.normalizer.toolUpdate(value)
        break
      case 'tool_execution_end':
        epoch.normalizer.toolEventEnd(value)
        break
      case 'turn_start':
        z.object({ type: z.literal('turn_start') }).parse(value)
        break
      case 'turn_end':
        z.object({
          message: z.unknown(),
          toolResults: z.array(z.unknown()),
        }).parse(value)
        break
      default:
        this.unknown(frame.type)
    }
  }
  private unknown(type: string) {
    if (this.unknownTypes.has(type)) return
    if (this.unknownTypes.size >= this.config.maxUnknownTypes)
      fail('PI_UNKNOWN_EVENT_LIMIT')
    this.unknownTypes.add(type)
    if (this.epoch)
      this.diagnostic(
        this.epoch,
        'PI_UNSUPPORTED_EVENT',
        'Pi emitted an unsupported event type.',
      )
  }
  private poison(error: PiError) {
    if (this.failure) return
    this.failure = error
    this.controller.abort()
    this.router?.close(error)
    this.questions.close()
    if (this.epoch)
      this.complete(
        this.epoch,
        { status: 'failed', code: error.code, message: error.message },
        true,
      )
    for (const waiter of this.drainWaiters) waiter.reject(error)
    this.drainWaiters = []
    for (const job of this.recordQueue) job.releaseImage?.()
    this.recordQueue = []
    this.recordBytes = 0
    void this.close(error).catch(() => {})
  }
  async cancel() {
    if (this.failure) return
    if (!this.epoch) {
      if (this.admission) await this.close(new PiError('PI_CANCELLED'))
      return
    }
    const epoch = this.epoch
    // Admission closes synchronously. Native abort does not clear Pi's queues.
    if (epoch.cancelling) return this.closed.promise
    this.admission = true
    epoch.cancelling = true
    clearTimeout(epoch.timer)
    epoch.root?.controller.abort()
    epoch.queued?.controller.abort()
    epoch.permit = false
    try {
      await waitOwned(
        (async () => {
          await this.questions.cancelPending()
          if (this.router && !this.failure)
            await this.router.request('abort', {}, true)
        })(),
        this.controller.signal,
        500,
      )
    } finally {
      this.complete(
        epoch,
        { status: 'interrupted', reason: 'Pi operation cancelled.' },
        true,
      )
      await this.close(new PiError('PI_CANCELLED'))
    }
  }
  close(error = new PiError('PI_CLOSED')): Promise<void> {
    if (this.closing) return this.closing
    if (!this.failure) this.poison(error)
    if (this.closing) return this.closing
    this.closing = Promise.resolve().then(async () => {
      try {
        await this.process?.close(error)
      } finally {
        this.closed.resolve()
      }
    })
    return this.closing
  }
}
function reasonFields(error: unknown) {
  const parsed = reason(error)
  return { code: parsed.code, message: parsed.message }
}
