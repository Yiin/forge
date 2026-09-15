import type * as SDK from '@cursor/sdk'
import { realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { cursorTransport, validateOwner, type CursorFrame } from './wire.js'
import {
  cursorLimits,
  CursorResources,
  invariant,
  plainCopy,
  CursorError,
  type CursorLimits,
} from './limits.js'
import { processIdentity, type ContainerIdentity } from './container.js'
import { validateEnvironment } from './launch.js'
import { readCursorCredentials } from './credentials.js'
import { CursorStore } from './store.js'
import { CursorScanner } from './scan.js'
import { CursorNormalizer, captureSdkValue } from './normalize.js'
import {
  inputDigest,
  validateCatalog,
  validateModel,
  cursorPolicy,
} from './input.js'
import type {
  CursorOwner,
  CursorSelectedRecords,
  CursorReservation,
} from './contracts.js'
import type { DispatchOptions } from '../types.js'
import { DiagnosticTail, redactSecrets } from '../diagnostics.js'

type InitialGrant = {
  agent: SDK.SDKAgent
  owner: CursorOwner
  queuedRunId: string
  leaseId: string
  reservationId: string
  consumed: boolean
}
export class CursorSidecarRuntime {
  private agent?: SDK.SDKAgent
  private run?: SDK.Run
  private initial?: InitialGrant
  private prepared?: {
    owner: CursorOwner
    digest: string
    model: SDK.ModelSelection
    policy: ReturnType<typeof cursorPolicy>
  }
  private normalizer?: CursorNormalizer
  private cancelled = false
  private submitting = false
  private preparing = false
  private closed = false
  private creationStarted = false
  private callbacks: Promise<unknown> = Promise.resolve()
  private callbackError?: Error
  private pendingCallbacks = 0
  private callbackBytes = 0
  private apiKey = ''
  private models: SDK.ModelListItem[] = []
  private policy?: string
  private readonly scanner: CursorScanner
  private generationCounts = {
    callbacks: 0,
    callbackBytes: 0,
    stream: 0,
    streamBytes: 0,
  }
  private scanTimer?: ReturnType<typeof setInterval>
  private callbackScan?: Promise<void>
  private cancellationEpoch = 0
  readonly store: CursorStore
  constructor(
    private readonly sdk: typeof SDK,
    readonly selected: CursorSelectedRecords,
    directory: string,
    readonly owner: CursorOwner,
    private readonly limits: CursorLimits,
    private readonly output: (frame: CursorFrame) => Promise<void>,
    private readonly resources = new CursorResources(),
    creating = true,
    readonly reservation?: CursorReservation,
    readonly discovery = false,
  ) {
    this.store = new CursorStore(
      directory,
      owner.cwd,
      new sdk.JsonlLocalAgentStore(directory),
      resources,
      limits,
      creating,
    )
    this.scanner = new CursorScanner(
      join(dirname(directory), 'native-data'),
      resources,
      limits,
    )
  }
  private deliver(frame: CursorFrame) {
    const clean = plainCopy(frame, this.limits.frameBytes)
    const secrets = [
      this.apiKey,
      ...Object.values(this.selected.accountEnv).filter(
        (value): value is string => !!value,
      ),
    ]
    const redacted = JSON.parse(
      JSON.stringify(clean, (_key, value) =>
        typeof value === 'string' ? redactSecrets(value, secrets) : value,
      ),
    ) as CursorFrame
    // Generated ownership fields identify protocol records. Only SDK content is redacted.
    for (const key of [
      'v',
      'generation',
      'type',
      'requestId',
      'owner',
      'readiness',
      'agentId',
      'nativeRunId',
      'initialQueuedRunId',
      'storeId',
      'reservationId',
      'code',
    ] as const)
      if (key in clean) redacted[key] = clean[key] as never
    if (clean.event && typeof clean.event === 'object') {
      const event = clean.event as Record<string, unknown>,
        output = redacted.event as Record<string, unknown>
      for (const key of [
        'type',
        'contentType',
        'status',
        'runId',
        'turnId',
        'runtimeGeneration',
        'deliveryId',
        'itemId',
        'toolCallId',
        'parentToolCallId',
        'childId',
        'providerChildId',
      ])
        if (key in event) output[key] = event[key]
    }
    if (clean.record && typeof clean.record === 'object')
      for (const key of ['v', 'owner', 'sourceSeq', 'deliveryId', 'kind'])
        (redacted.record as Record<string, unknown>)[key] = (
          clean.record as Record<string, unknown>
        )[key]
    if (clean.result && typeof clean.result === 'object')
      (redacted.result as Record<string, unknown>).status = (
        clean.result as Record<string, unknown>
      ).status
    if (clean.type === 'models_result') {
      const items = clean.items as SDK.ModelListItem[]
      for (const [index, item] of items.entries()) {
        const target = (redacted.items as SDK.ModelListItem[])[index]
        target.id = item.id
        target.aliases = item.aliases
        for (const [position, parameter] of (item.parameters ?? []).entries()) {
          const output = target.parameters![position]
          output.id = parameter.id
          for (const [valueIndex, value] of parameter.values.entries())
            output.values[valueIndex].value = value.value
        }
        for (const [position, variant] of (item.variants ?? []).entries())
          target.variants![position].params = variant.params
      }
    }
    return this.output(redacted)
  }
  private reply(
    frame: CursorFrame,
    type: string,
    values: Record<string, unknown> = {},
  ) {
    return this.deliver({
      v: 1,
      generation: this.owner.generation,
      type,
      requestId: frame.requestId,
      ...values,
    })
  }
  async initialize(frame: CursorFrame) {
    const credential = await readCursorCredentials(
      this.selected,
      this.limits,
      new AbortController().signal,
    )
    this.apiKey = credential.apiKey
    await this.store.drain(false)
    await this.sdk.Cursor.me({ apiKey: this.apiKey })
    return this.reply(frame, 'ready', {
      readiness: {
        sdk: 'ready',
        auth: 'verified',
        store: this.store.creating ? 'new' : 'validated',
        processContainer: 'verified',
        localRuntime: 'not-started',
        sandbox: 'not-checked',
      },
    })
  }
  async command(frame: CursorFrame): Promise<void> {
    invariant(!this.closed || frame.type === 'close', 'cursor_runtime_closed')
    try {
      switch (frame.type) {
        case 'models':
          this.models = validateCatalog(
            await this.sdk.Cursor.models.list({ apiKey: this.apiKey }),
            this.limits,
          )
          await this.reply(frame, 'models_result', { items: this.models })
          return
        case 'prepare':
          invariant(!this.preparing, 'cursor_prepare_busy')
          this.preparing = true
          try {
            await this.prepare(frame)
          } finally {
            this.preparing = false
          }
          return
        case 'submit':
          await this.submit(frame)
          return
        case 'cancel':
          this.cancellationEpoch++
          this.cancelled = true
          if (this.initial) this.initial.consumed = true
          this.prepared = undefined
          if (this.run) await this.run.cancel()
          await this.reply(frame, 'cancelled')
          return
        case 'close':
          this.cancellationEpoch++
          this.closed = true
          this.cancelled = true
          if (this.initial) this.initial.consumed = true
          if (this.run) await this.run.cancel()
          this.store.revoke()
          if (this.agent) await this.agent[Symbol.asyncDispose]()
          await this.callbacks
          await this.scanner.stop()
          await this.reply(frame, 'closed')
          return
        default:
          throw new CursorError('cursor_command_unsupported')
      }
    } catch (error) {
      await this.reply(frame, 'failure', {
        ...(frame.owner ? { owner: frame.owner } : {}),
        code: error instanceof CursorError ? error.code : 'cursor_sdk_failed',
      })
    }
  }
  private assertOwner(value: unknown): CursorOwner {
    const owner = validateOwner(value, this.limits) as CursorOwner
    for (const key of [
      'forgeSessionId',
      'provider',
      'accountId',
      'cwd',
      'storeId',
      'generation',
    ] as const)
      invariant(owner[key] === this.owner[key], 'cursor_owner_mismatch')
    return owner
  }
  private async prepare(frame: CursorFrame) {
    invariant(!this.discovery, 'cursor_discovery_create_forbidden')
    invariant(
      !this.prepared && !this.submitting && !this.run,
      'cursor_prepare_busy',
    )
    this.cancelled = false
    const owner = this.assertOwner(frame.owner)
    const epoch = this.cancellationEpoch
    const deadline =
      performance.now() +
      Math.min(
        typeof frame.preparationMs === 'number'
          ? frame.preparationMs
          : this.limits.preparationMs,
        this.limits.preparationMs,
      )
    const current = () => {
      this.assertOwner(owner)
      invariant(
        epoch === this.cancellationEpoch &&
          !this.cancelled &&
          !this.closed &&
          performance.now() < deadline,
        'cursor_preparation_cancelled',
      )
    }
    invariant(
      frame.reservationId === this.reservation?.reservationId,
      'cursor_reservation_mismatch',
    )
    await this.scanner.request()
    current()
    const policy = cursorPolicy(frame.options as DispatchOptions)
    const model = validateModel(frame.model as SDK.ModelSelection, this.models)
    invariant(
      typeof frame.digest === 'string' && /^[0-9a-f]{64}$/.test(frame.digest),
      'cursor_input_digest',
    )
    const options: SDK.AgentOptions = {
      apiKey: this.apiKey,
      model,
      local: {
        cwd: owner.cwd,
        store: this.store,
        ...policy,
        settingSources: [...this.selected.settingSources],
      },
      disallowedTools: ['askQuestion', 'generateImage'],
    }
    invariant(
      !this.policy || this.policy === JSON.stringify(policy),
      'cursor_policy_requires_retirement',
    )
    this.policy = JSON.stringify(policy)
    this.store.beginAttempt(owner.attemptId)
    if (!this.agent) {
      if (frame.agentId !== undefined) {
        const inventory = await this.store.drain(true)
        current()
        const row = inventory.rows.agents[0]
        invariant(
          row?.agentId === frame.agentId &&
            row.status !== 'archived' &&
            row.activeRunId == null,
          'active_run_ambiguous',
        )
        current()
        this.agent = await this.sdk.Agent.resume(String(frame.agentId), options)
        current()
      } else {
        invariant(
          this.store.creating &&
            !this.creationStarted &&
            this.reservation?.state === 'creation-started' &&
            JSON.stringify(this.reservation.creationOwner) ===
              JSON.stringify(owner),
          'cursor_create_forbidden',
        )
        this.creationStarted = true
        current()
        this.agent = await this.sdk.Agent.create(options)
        current()
        const inventory = await this.store.drain(true)
        current()
        const row = inventory.rows.agents[0],
          run = inventory.rows.runs[0]
        invariant(
          inventory.rows.agents.length === 1 &&
            inventory.rows.runs.length === 1 &&
            row.agentId === this.agent.agentId &&
            row.cwd === owner.cwd &&
            row.activeRunId === run.runId &&
            run.status === 'queued' &&
            run.turnNumber === 1,
          'cursor_initial_run_invalid',
        )
        this.initial = {
          agent: this.agent,
          owner,
          queuedRunId: String(run.runId),
          leaseId: this.store.leaseId,
          reservationId: this.reservation.reservationId,
          consumed: this.cancelled,
        }
      }
    }
    current()
    this.prepared = { owner, digest: frame.digest, model, policy }
    await this.reply(frame, 'prepared', {
      agentId: this.agent.agentId,
      reservationId: this.reservation!.reservationId,
      initialQueuedRunId: this.initial?.queuedRunId,
      storeId: owner.storeId,
      owner,
    })
  }
  private enqueue(
    normalizer: CursorNormalizer,
    kind: 'delta' | 'step' | 'stream',
    value: unknown,
    drainOutput: () => Promise<void>,
  ) {
    const captured = captureSdkValue(value, this.limits)
    const bytes = Buffer.byteLength(JSON.stringify(captured))
    const channel = kind === 'stream' ? 'stream' : 'callbacks'
    const byteChannel = kind === 'stream' ? 'streamBytes' : 'callbackBytes'
    invariant(
      ++this.generationCounts[channel] <= this.limits.generationEvents &&
        (this.generationCounts[byteChannel] += bytes) <=
          this.limits.generationEventBytes,
      kind === 'stream'
        ? 'cursor_stream_generation_limit'
        : 'cursor_callback_generation_limit',
    )
    invariant(
      this.pendingCallbacks < this.limits.queuedFrames &&
        this.callbackBytes + bytes <= this.limits.queuedWireBytes,
      'cursor_callback_limit',
    )
    this.pendingCallbacks++
    this.callbackBytes += bytes
    // Every request marks the scanner's single follow-up slot. Attach only one
    // observer while it runs, independently of serialized content callbacks.
    if (kind !== 'stream') {
      const scan = this.scanner.request()
      if (!this.callbackScan) {
        this.callbackScan = scan
          .catch((error) => {
            this.callbackError ??= error
          })
          .finally(() => {
            this.callbackScan = undefined
          })
      }
    }
    const work = this.callbacks.then(async () => {
      await drainOutput()
      if (this.callbackError) throw this.callbackError
      if (kind === 'delta')
        normalizer.delta(this.sdk.InteractionUpdateSchema.parse(captured))
      else if (kind === 'step')
        normalizer.step(this.sdk.ConversationStepSchema.parse(captured))
      else normalizer.stream(captured as SDK.SDKMessage)
      await drainOutput()
    })
    this.callbacks = work
      .catch((error) => {
        this.callbackError ??=
          error instanceof Error
            ? error
            : new CursorError('cursor_callback_failed')
      })
      .finally(() => {
        this.pendingCallbacks--
        this.callbackBytes -= bytes
      })
    return work
  }
  private async submit(frame: CursorFrame) {
    const owner = this.assertOwner(frame.owner),
      prepared = this.prepared
    invariant(
      frame.reservationId === this.reservation?.reservationId,
      'cursor_reservation_mismatch',
    )
    invariant(
      prepared &&
        JSON.stringify(owner) === JSON.stringify(prepared.owner) &&
        !this.cancelled &&
        !this.submitting &&
        this.agent,
      'cursor_submit_not_prepared',
    )
    const message = plainCopy(
      frame.message,
      this.limits.frameBytes,
    ) as SDK.SDKUserMessage
    invariant(inputDigest(message) === prepared.digest, 'cursor_submit_digest')
    const inventory = await this.store.drain(true)
    const row = inventory.rows.agents[0]
    invariant(
      row?.agentId === this.agent.agentId && row.status !== 'archived',
      'cursor_agent_invalid',
    )
    if (row.activeRunId != null) {
      const grant = this.initial
      const active = inventory.rows.runs.find(
        (run) => run.runId === row.activeRunId,
      )
      invariant(
        grant &&
          !grant.consumed &&
          grant.agent === this.agent &&
          grant.leaseId === this.store.leaseId &&
          grant.reservationId === frame.reservationId &&
          JSON.stringify(grant.owner) === JSON.stringify(owner) &&
          grant.queuedRunId === row.activeRunId &&
          active?.status === 'queued' &&
          active.turnNumber === 1,
        'active_run_ambiguous',
      )
      grant.consumed = true
    }
    invariant(!this.cancelled && !this.closed, 'cursor_submit_cancelled')
    this.prepared = undefined
    this.submitting = true
    let writes: Promise<unknown> = Promise.resolve()
    let writeError: Error | undefined
    const push = (type: string, payload: Record<string, unknown>) => {
      const work = this.deliver({
        v: 1,
        generation: owner.generation,
        type,
        owner,
        ...payload,
      })
      writes = Promise.all([writes, work]).catch((error) => {
        writeError ??= error
      })
      return work
    }
    const drainOutput = async () => {
      await writes
      if (writeError) throw writeError
    }
    this.normalizer = new CursorNormalizer(
      owner,
      this.limits,
      (event) => {
        void push('event', { event })
      },
      (record) => {
        void push('native_record', { record })
      },
      this.resources,
    )
    const normalizer = this.normalizer
    try {
      const run = await this.agent.send(message, {
        model: prepared.model,
        onDelta: ({ update }) =>
          this.enqueue(normalizer, 'delta', update, drainOutput),
        onStep: ({ step }) =>
          this.enqueue(normalizer, 'step', step, drainOutput),
      })
      this.run = run
      this.submitting = false
      let scanning = false
      this.scanTimer = setInterval(() => {
        if (scanning) return
        scanning = true
        void this.scanner
          .request()
          .catch((error) => {
            this.callbackError ??= error
            void run.cancel().catch(() => {})
          })
          .finally(() => {
            scanning = false
          })
      }, 1000)
      if (this.cancelled || this.closed) await run.cancel()
      this.normalizer.start()
      await this.reply(frame, 'submitted', {
        agentId: this.agent.agentId,
        nativeRunId: run.id,
        owner,
      })
      const stream = (async () => {
        for await (const message of run.stream()) {
          await this.enqueue(normalizer, 'stream', message, drainOutput)
        }
      })()
      // Observe immediately; wait remains the root authority even when stream draining rejects first.
      void stream.catch(() => {})
      const result = await run.wait()
      await stream
      await this.callbacks
      await this.store.drain(true)
      await this.scanner.request()
      this.store.endAttempt()
      if (this.callbackError) throw this.callbackError
      await drainOutput()
      this.normalizer.finish(result)
      await drainOutput()
      await this.deliver({
        v: 1,
        generation: owner.generation,
        type: 'result',
        owner,
        result,
      })
    } finally {
      if (this.scanTimer) clearInterval(this.scanTimer)
      this.scanTimer = undefined
      this.submitting = false
      this.run = undefined
    }
  }
}

export async function bootstrap() {
  invariant(process.argv[2] === '--managed', 'cursor_bootstrap_required')
  const generation = process.argv[3],
    nonce = process.argv[4],
    limits = { ...cursorLimits() }
  let runtime: CursorSidecarRuntime | undefined,
    granted = false
  const transport = cursorTransport(
    process.stdout,
    process.stdin,
    generation,
    limits,
    (frame) => {
      if (!granted) {
        invariant(
          frame.type === 'container_bound' && frame.nonce === nonce,
          'cursor_bootstrap_nonce',
        )
        granted = true
        void initialize(frame).catch(() =>
          transport.send({
            v: 1,
            generation,
            type: 'failure',
            requestId: frame.requestId,
            code: 'cursor_initialize_failed',
          }),
        )
      } else {
        invariant(runtime, 'cursor_runtime_not_ready')
        void runtime.command(frame)
      }
    },
  )
  async function initialize(frame: CursorFrame) {
    Object.assign(limits, cursorLimits(frame.limits as Partial<CursorLimits>))
    const identity = frame.identity as ContainerIdentity
    const self = await processIdentity(process.pid)
    invariant(
      identity.pid === self.pid &&
        identity.start === self.start &&
        identity.cgroup === self.cgroup &&
        identity.nonce === nonce &&
        identity.generation === generation,
      'cursor_bootstrap_membership',
    )
    const environment = plainCopy(
      frame.environment,
      limits.envBytes,
    ) as NodeJS.ProcessEnv
    validateEnvironment(environment, limits)
    const selected = plainCopy(
      frame.selected,
      limits.controlBytes,
    ) as CursorSelectedRecords
    const directory = String(frame.directory),
      owner = frame.owner as CursorOwner
    invariant(
      environment.HOME === selected.account.homePath &&
        environment.CURSOR_CONFIG_DIR ===
          join(selected.account.homePath, '.cursor') &&
        environment.CURSOR_DATA_DIR ===
          join(dirname(directory), 'native-data') &&
        environment.CURSOR_BACKEND_URL === selected.backendUrl,
      'cursor_bootstrap_environment',
    )
    invariant(
      (await realpath(directory)) === directory &&
        (await realpath(owner.cwd)) === owner.cwd,
      'cursor_bootstrap_path',
    )
    for (const key of Object.keys(process.env)) delete process.env[key]
    for (const [key, value] of Object.entries(environment))
      if (value !== undefined) process.env[key] = value
    const secrets = [
      ...(selected.credential.type === 'api-key'
        ? [selected.credential.apiKey]
        : []),
      ...Object.values(selected.accountEnv).filter(
        (value): value is string => !!value,
      ),
    ]
    // Provider console output cannot enter the protocol pipe. The bounded tail stays private.
    const diagnostics = new DiagnosticTail(limits.stderrBytes, secrets)
    let diagnosticCount = 0,
      diagnosticBytes = 0
    const capture = (...values: unknown[]) => {
      if (diagnosticCount >= limits.diagnostics) return
      for (const value of values) {
        if (typeof value !== 'string') continue
        if (
          value.length > limits.detailBytes ||
          Buffer.byteLength(value) > limits.detailBytes
        )
          continue
        const bytes = Buffer.from(value)
        if (diagnosticBytes + bytes.length > limits.diagnosticBytes) return
        diagnosticCount++
        diagnosticBytes += bytes.length
        diagnostics.append(bytes)
      }
    }
    for (const key of [
      'log',
      'info',
      'warn',
      'error',
      'debug',
      'trace',
    ] as const)
      console[key] = capture
    const reservation = plainCopy(frame.reservation, limits.markerBytes) as
      CursorReservation | undefined
    const discovery = frame.discovery === true
    invariant(
      discovery
        ? reservation === undefined &&
            directory.includes(`/helpers/${owner.storeId}/sdk`)
        : reservation &&
            reservation.creationOwner.storeId === owner.storeId &&
            reservation.creationOwner.forgeSessionId === owner.forgeSessionId &&
            reservation.creationOwner.accountId === owner.accountId &&
            reservation.creationOwner.provider === owner.provider &&
            reservation.creationOwner.cwd === owner.cwd,
      'cursor_bootstrap_reservation',
    )
    const sdk = await import('@cursor/sdk')
    runtime = new CursorSidecarRuntime(
      sdk,
      selected,
      directory,
      owner,
      limits,
      (value) => transport.send(value),
      new CursorResources(),
      reservation?.state === 'creation-started' && !reservation.record,
      reservation,
      discovery,
    )
    await runtime.initialize(frame)
  }
  await transport.send({
    v: 1,
    generation,
    type: 'bootstrap_wait',
    nonce,
    pid: process.pid,
  })
}
