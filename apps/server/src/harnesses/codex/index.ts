import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import {
  promptInputSchema,
  confirmedNativeBindingSchema,
  type TerminalOutcome,
} from '@forge/protocol/harness'
import {
  createCompletionHandle,
  type HarnessAdapter,
  type HarnessHandle,
  type HarnessReceipt,
  type HarnessSession,
  type HarnessEvent,
  type CompletionHandle,
  type DispatchOptions,
  type PromptInput,
  type PermissionReply,
  type QuestionAnswer,
} from '../types.js'
import { diagnosticError, positiveLimit } from '../diagnostics.js'
import type { JsonRpcIncoming } from '../jsonrpc.js'
import { JsonlRpcTransport } from '../jsonrpc.js'
import { admitCodexConfiguration, copyLaunchOptions } from './environment.js'
import {
  connectCodex,
  readModels,
  readSkills,
  type CodexAdapterOptions,
  type CodexConnection,
} from './catalog.js'
import { CodexRequests, type CodexOwner } from './requests.js'
import { CodexNormalizer, terminalOutcome } from './normalize.js'
import {
  CodexBudget,
  CodexOptions,
  MiB,
  byteSize,
  fail,
  idSchema,
  initialBody,
  pathSchema,
  record,
  same,
  sameSandbox,
  parseOptions,
  tupleId,
  turnSchema,
  threadSchema,
  validateThreadResponse,
  accountSchema,
  type EffectiveOptions,
  type NativeThread,
  type CodexModel,
} from './wire.js'
export type { CodexAdapterOptions } from './catalog.js'
export type {
  CodexAccountContext,
  CodexNativeLaunchAuthority,
} from './environment.js'
export { discoverCodex } from './catalog.js'
export { readCodexHistoryPage, forkCodexThread } from './history.js'

type TurnOwner = CodexOwner & {
  effective?: EffectiveOptions
  completion?: CompletionHandle
  settle?: ReturnType<typeof createCompletionHandle>['settle']
  outcome?: TerminalOutcome
  release: () => void
  releaseActive?: () => void
  releaseFull?: () => void
  resize: (bytes: number) => void
  retainedBytes: number
  parentToolCallId?: string
  parentChildId?: string
}
type Attempt = {
  phase: 'preparing' | 'submitted' | 'accepted' | 'rejected'
  controller: AbortController
  input: PromptInput[]
  effective: EffectiveOptions
  runId: string
  turnId: string
  receiptId: string
  clientId: string
  completion: ReturnType<typeof createCompletionHandle>
  cancelled: boolean
  captured?: TurnOwner
  release: () => void
  deadline: number
  done: Promise<void>
  finish: () => void
}
type Buffered = {
  message: JsonRpcIncoming
  release: () => void
  deadline: number
}
type Lineage = {
  threadId: string
  parent: string
  depth?: number
  rootOwner?: TurnOwner
  sessionId?: string
  release: () => void
}
type Assignment = {
  key: string
  target: string
  owner: TurnOwner
  toolId: string
  deadline: number
  release: () => void
}
type Metadata = { threadId: string; deadline: number; release: () => void }
type NativeInput =
  | { type: 'text'; text: string; text_elements: [] }
  | { type: 'localImage'; path: string }
const textInput = (text: string): NativeInput => ({
  type: 'text',
  text,
  text_elements: [],
})

class CodexActivation implements HarnessHandle {
  readonly generation = randomUUID()
  private confirmed: ReturnType<
    typeof confirmedNativeBindingSchema.parse
  > | null = null
  private connection?: CodexConnection
  private rpc?: JsonlRpcTransport
  private requests?: CodexRequests
  private readonly budget = new CodexBudget()
  private readonly normalizer: CodexNormalizer
  private policy?: CodexOptions
  private nativeOptions?: EffectiveOptions
  private root?: Pick<NativeThread, 'id' | 'sessionId' | 'cwd'>
  private readonly owners = new Map<string, TurnOwner>()
  private readonly identities = new Set<string>()
  private readonly identityReleases = new Map<string, () => void>()
  private readonly lineage = new Map<string, Lineage>()
  private readonly assignments = new Map<string, Assignment>()
  private readonly assignmentIds = new Map<string, () => void>()
  private readonly buffers: Buffered[] = []
  private readonly metadata = new Map<string, Metadata>()
  private readonly metadataQueue: Metadata[] = []
  private readonly failedMetadata = new Map<string, () => void>()
  private metadataRunning = 0
  private readonly echoes = new Map<string, () => void>()
  private active?: TurnOwner
  private ordinary?: Attempt
  private steering?: Attempt
  private closed?: Error
  private closing?: Promise<void>
  private cancelling?: Promise<void>
  private settingsValidation?: Promise<void>
  private resolutionTimer?: ReturnType<typeof setTimeout>
  private models: CodexModel[] = []
  private releaseModels?: () => void
  private global = new Map<string, { value: unknown; release: () => void }>()
  private readonly releaseOptions: () => void
  private readonly releasePolicyReserve: () => void
  private readonly releaseControlReserve: (() => void)[]
  private readonly startupMessages: { message: string; release: () => void }[] =
    []

  constructor(
    private readonly options: CodexAdapterOptions,
    private readonly session: HarnessSession,
    emit: (event: HarnessEvent) => void,
  ) {
    this.normalizer = new CodexNormalizer(
      this.generation,
      emit,
      this.budget,
      options.secrets,
    )
    this.releaseOptions = this.budget.charge(
      'configuration',
      byteSize(options.initialOptions ?? {}) +
        byteSize(options.env ?? {}) +
        byteSize(options.args ?? []) +
        byteSize(options.secrets ?? []) +
        512,
      1,
      MiB,
    )
    // Admission reserves the bounded native baseline/provenance and all three 64 KiB option layers.
    // Setters and settings refreshes replace data within this reservation.
    this.releasePolicyReserve = this.budget.charge(
      'policy-state',
      512 * 1024,
      1,
      MiB,
    )
    // One startup control, one shared ownership timer and one interrupt grace timer.
    this.releaseControlReserve = Array.from({ length: 3 }, () =>
      this.budget.charge('control-resources', 256, 512, 256 * 1024),
    )
  }
  get binding() {
    return this.confirmed
  }
  get availableModels() {
    const selected = this.policy?.resolve().model
    return this.models
      .filter((model) => !model.hidden || model.model === selected)
      .map((model) => ({ id: model.id, displayName: model.displayName }))
  }
  async start(load: boolean) {
    if (
      this.session.provider !== this.options.provider ||
      (this.session.accountId ?? null) !== this.options.accountId
    )
      fail('SESSION_SCOPE')
    idSchema.parse(this.session.id)
    let cwd = this.session.cwd
    if (load) {
      const binding = this.session.binding
      if (
        !binding ||
        !binding.providerSessionId ||
        binding.provider !== this.options.provider ||
        binding.accountId !== this.options.accountId
      )
        fail('BINDING_SCOPE')
      idSchema.parse(binding.providerSessionId)
    } else if (this.session.binding) fail('SPAWN_BINDING')
    try {
      await connectCodex(
        this.options,
        cwd,
        async (connection) => {
          this.connection = connection
          this.rpc = connection.rpc
          this.requests ??= new CodexRequests(
            connection.rpc,
            this.normalizer.emit,
            this.budget,
            this.options.secrets,
          )
          this.policy = new CodexOptions(
            connection.baseline,
            this.options.initialOptions,
          )
          const initial = this.policy.resolve()
          const body = initialBody(initial, cwd)
          try {
            this.globalFrame(
              'account/read',
              accountSchema.parse(
                await connection.request('account/read', {
                  refreshToken: false,
                }),
              ),
            )
          } catch {
            this.startupDiagnostic('Account discovery failed')
          }
          try {
            const models = await readModels(connection)
            this.releaseModels = this.budget.charge(
              'models',
              byteSize(models) + models.length * 128,
              1,
              16 * MiB,
            )
            this.models = models
          } catch {
            this.startupDiagnostic('Model discovery failed')
          }
          try {
            await readSkills(connection)
          } catch {
            this.startupDiagnostic('Skill discovery failed')
          }
          const expectedId = load
            ? this.session.binding!.providerSessionId!
            : undefined
          const response = validateThreadResponse(
            await connection.request(
              load ? 'thread/resume' : 'thread/start',
              load
                ? { ...body, threadId: expectedId, excludeTurns: true }
                : { ...body, ephemeral: false },
            ),
            cwd,
            initial,
            expectedId,
          )
          if (
            response.modelProvider !== connection.provenance.selectedProviderId
          )
            fail('THREAD_PROVIDER')
          this.policy.observed(response, initial)
          this.nativeOptions = this.policy.resolve()
          this.root = {
            id: response.thread.id,
            sessionId: response.thread.sessionId,
            cwd: response.thread.cwd,
          }
          this.confirmed = confirmedNativeBindingSchema.parse({
            provider: this.options.provider,
            accountId: this.options.accountId,
            cwd,
            providerSessionId: response.thread.id,
          })
          // Confirmation precedes every buffered thread event.
          this.drainBuffers()
          void connection.process.done
            .then((reason) => this.retire(reason))
            .catch(() => {})
          return this
        },
        (message, rpc) => {
          this.rpc ??= rpc
          this.requests ??= new CodexRequests(
            rpc,
            this.normalizer.emit,
            this.budget,
            this.options.secrets,
          )
          this.receive(message)
        },
        undefined,
        this.generation,
        (canonical) => {
          cwd = canonical
          if (load && this.session.binding!.cwd !== cwd) fail('BINDING_SCOPE')
        },
        this.budget,
      )
      return this
    } catch (error) {
      await this.retire(diagnosticError(error, this.options.secrets))
      throw diagnosticError(error, this.options.secrets)
    }
  }
  prompt(
    input: PromptInput[] | string,
    options?: DispatchOptions,
    identity?: { runId: string; turnId: string },
  ): Promise<HarnessReceipt> {
    return this.dispatch(false, input, options, identity)
  }
  steer(
    input: PromptInput[] | string,
    options?: DispatchOptions,
    identity?: { runId: string; turnId: string },
  ): Promise<HarnessReceipt> {
    return this.dispatch(true, input, options, identity)
  }
  private async dispatch(
    steer: boolean,
    value: PromptInput[] | string,
    call?: DispatchOptions,
    identity?: { runId: string; turnId: string },
  ): Promise<HarnessReceipt> {
    this.assertLive()
    if (this.settingsValidation) fail('SETTINGS_PENDING')
    if (
      steer
        ? this.steering || !this.active || this.active.outcome
        : this.ordinary || this.active || this.cancelling
    )
      fail('BUSY')
    const captured = steer ? this.active! : undefined
    if (
      identity &&
      (typeof identity !== 'object' ||
        !idSchema.safeParse(identity.runId).success ||
        !idSchema.safeParse(identity.turnId).success ||
        (captured &&
          (identity.runId !== captured.runId ||
            identity.turnId !== captured.turnId)))
    )
      fail('DISPATCH_IDENTITY')
    const effective = this.policy!.resolve(call, captured?.effective)
    const raw =
      typeof value === 'string' ? [{ type: 'text', text: value }] : value
    if (!Array.isArray(raw) || raw.length > 128 || byteSize(raw) > 4 * MiB)
      fail('INPUT_LIMIT')
    const input = z.array(promptInputSchema).max(128).parse(raw)
    const ids = captured ??
      identity ?? { runId: randomUUID(), turnId: randomUUID() }
    const pair = tupleId(ids.runId, ids.turnId)
    if (!steer && this.identities.has(pair)) fail('DISPATCH_IDENTITY_REUSED')
    // Reserve all required charges before inserting either logical owner or identity.
    const release = this.budget.charge(
      steer ? 'steer-attempt' : 'ordinary-attempt',
      byteSize(input) + byteSize(effective) + 512,
      1,
      4 * MiB + 64 * 1024,
    )
    let releaseIdentity: (() => void) | undefined
    let releaseWork: (() => void) | undefined
    try {
      releaseWork = this.budget.charge(
        'preparations',
        byteSize(input) + byteSize(effective) + 256,
        2,
        8 * MiB + 128 * 1024,
      )
      const preparationCharge = releaseWork
      const preparationControl = this.budget.charge(
        'control-resources',
        256,
        512,
        256 * 1024,
      )
      releaseWork = () => {
        preparationCharge()
        preparationControl()
      }
      if (!steer)
        releaseIdentity = this.budget.charge(
          'forge-identities',
          byteSize([ids.runId, ids.turnId, pair]),
          8192,
          8 * MiB,
        )
    } catch (error) {
      releaseWork?.()
      release()
      if (
        error instanceof Error &&
        error.message === 'CODEX_FORGE-IDENTITIES_LIMIT'
      )
        void this.retire(error)
      throw error
    }
    let finish!: () => void
    const done = new Promise<void>((resolve) => {
      finish = resolve
    })
    const attempt: Attempt = {
      done,
      finish,
      phase: 'preparing',
      controller: new AbortController(),
      input,
      effective,
      runId: ids.runId,
      turnId: ids.turnId,
      receiptId: randomUUID(),
      clientId: randomUUID(),
      completion: captured
        ? { handle: captured.completion!, settle: captured.settle! }
        : createCompletionHandle({
            completionId: randomUUID(),
            runId: ids.runId,
            turnId: ids.turnId,
          }),
      cancelled: false,
      captured,
      release,
      deadline:
        performance.now() + (this.options.preparationTimeoutMs ?? 30_000),
    }
    if (steer) this.steering = attempt
    else {
      this.ordinary = attempt
      this.identities.add(pair)
      this.identityReleases.set(pair, releaseIdentity!)
    }
    try {
      const prepared = await this.prepare(attempt, releaseWork)
      this.checkAttempt(attempt)
      const releaseEcho = this.budget.charge(
        'echoes',
        byteSize(attempt.clientId),
        1024,
        MiB,
      )
      this.echoes.set(attempt.clientId, releaseEcho)
      attempt.phase = 'submitted'
      let response: unknown
      try {
        response = await this.connection!.request(
          steer ? 'turn/steer' : 'turn/start',
          {
            threadId: this.root!.id,
            clientUserMessageId: attempt.clientId,
            input: prepared,
            ...(steer
              ? { expectedTurnId: captured!.nativeTurnId }
              : {
                  cwd: this.confirmed!.cwd,
                  approvalPolicy: effective.approvalPolicy,
                  approvalsReviewer: effective.approvalsReviewer,
                  sandboxPolicy: effective.sandboxPolicy,
                  summary: 'auto',
                  ...(effective.model === undefined
                    ? {}
                    : { model: effective.model }),
                  ...(effective.reasoning === undefined
                    ? {}
                    : { effort: effective.reasoning }),
                  ...(effective.serviceTier === undefined
                    ? {}
                    : { serviceTier: effective.serviceTier }),
                }),
          },
        )
      } catch (error) {
        const explicit =
          error instanceof Error && / \(code -?\d+\)$/.test(error.message)
        if (!steer) {
          // The shared router surfaces explicit peer errors with a terminal code suffix.
          if (!explicit || this.buffers.length)
            await this.retire(new Error('CODEX_DELIVERY_UNKNOWN'))
        }
        attempt.phase = 'rejected'
        if (attempt.cancelled) fail('CANCELLED')
        if (!explicit || this.closed) fail('DELIVERY_UNKNOWN')
        this.echoes.get(attempt.clientId)?.()
        this.echoes.delete(attempt.clientId)
        throw diagnosticError(error, this.options.secrets)
      }
      if (this.closed)
        fail(attempt.cancelled ? 'CANCELLED' : 'DELIVERY_UNKNOWN')
      let owner: TurnOwner
      if (steer) {
        const parsed = z.object({ turnId: idSchema }).safeParse(response)
        if (!parsed.success || parsed.data.turnId !== captured!.nativeTurnId) {
          await this.retire(new Error('CODEX_DELIVERY_CONFLICT'))
          fail('DELIVERY_CONFLICT')
        }
        owner = captured!
      } else {
        const parsed = z.object({ turn: turnSchema }).safeParse(response)
        if (!parsed.success) {
          await this.retire(new Error('CODEX_DELIVERY_UNKNOWN'))
          fail(attempt.cancelled ? 'CANCELLED' : 'DELIVERY_UNKNOWN')
        }
        const previous = this.owners.get(
          tupleId(this.root!.id, parsed.data.turn.id),
        )
        if (previous) {
          this.normalizer.diagnostic(
            previous,
            'delivery',
            'CODEX_DELIVERY_CONFLICT',
            'Native input reached an already owned turn',
          )
          await this.retire(new Error('CODEX_DELIVERY_CONFLICT'))
          fail(attempt.cancelled ? 'CANCELLED' : 'DELIVERY_CONFLICT')
        }
        owner = this.admitOwner(this.root!.id, parsed.data.turn.id, attempt)
        this.policy!.sent(effective)
        this.nativeOptions = effective
        this.active = owner
        this.normalizer.lifecycle(owner, 'run_started')
        this.normalizer.lifecycle(owner, 'turn_started')
        this.normalizer.lifecycle(owner, 'prompt_accepted', {
          receiptId: attempt.receiptId,
        })
        this.drainBuffers()
        this.normalizer.turn(owner, parsed.data.turn)
        const outcome = terminalOutcome(parsed.data.turn, this.options.secrets)
        if (outcome) this.finish(owner, outcome)
      }
      attempt.phase = 'accepted'
      if (steer)
        this.normalizer.lifecycle(owner, 'steer_accepted', {
          receiptId: attempt.receiptId,
        })
      if (attempt.cancelled) {
        await this.interrupt(owner)
        fail('CANCELLED')
      }
      return {
        receiptId: attempt.receiptId,
        runId: owner.runId,
        turnId: owner.turnId,
        completion: attempt.completion.handle,
      }
    } catch (error) {
      if (attempt.phase === 'submitted' && !this.closed)
        await this.retire(diagnosticError(error, this.options.secrets))
      throw error
    } finally {
      if (this.ordinary === attempt) this.ordinary = undefined
      if (this.steering === attempt) this.steering = undefined
      attempt.release()
      if (attempt.phase !== 'accepted') {
        attempt.phase = 'rejected'
        attempt.controller.abort()
        if (!steer) {
          this.identities.delete(pair)
          this.identityReleases.get(pair)?.()
          this.identityReleases.delete(pair)
        }
      }
      attempt.finish()
    }
  }
  private async prepare(
    attempt: Attempt,
    releaseWork: () => void,
  ): Promise<NativeInput[]> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const work = (async () => {
      const inputs: NativeInput[] = []
      const files: {
        path: string
        size: number
        ino: number
        mtimeMs: number
      }[] = []
      let imageBytes = 0
      for (const input of attempt.input) {
        this.checkAttempt(attempt)
        if (input.type === 'text') inputs.push(textInput(input.text))
        else if (input.type === 'review_reference')
          inputs.push(
            textInput(
              `Review reference${input.title ? `: ${input.title}` : ''}\n${input.url}`,
            ),
          )
        else {
          const file = await this.options.loadAttachment(
            this.session.id,
            input.attachmentId,
            attempt.controller.signal,
          )
          this.checkAttempt(attempt)
          if (
            !file ||
            file.mime !== input.mime ||
            !Number.isSafeInteger(file.sizeBytes) ||
            file.sizeBytes < 0 ||
            !isAbsolute(file.path)
          )
            fail('ATTACHMENT')
          pathSchema.parse(file.path)
          const canonical = await realpath(file.path)
          this.checkAttempt(attempt)
          if (canonical !== file.path) fail('ATTACHMENT_PATH')
          const info = await stat(canonical)
          this.checkAttempt(attempt)
          if (!info.isFile() || info.size !== file.sizeBytes)
            fail('ATTACHMENT_CHANGED')
          files.push({
            path: canonical,
            size: info.size,
            ino: info.ino,
            mtimeMs: info.mtimeMs,
          })
          if (file.mime.startsWith('image/')) {
            if (
              !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(
                file.mime,
              ) ||
              info.size > 10 * MiB ||
              (imageBytes += info.size) > 25 * MiB
            )
              fail('IMAGE_LIMIT')
            const model = this.models.find(
              (model) =>
                model.model === attempt.effective.model ||
                model.id === attempt.effective.model,
            )
            if (
              model?.inputModalities &&
              !model.inputModalities.includes('image')
            )
              fail('MODEL_IMAGE_UNSUPPORTED')
            inputs.push({ type: 'localImage', path: canonical })
          } else
            inputs.push(
              textInput(`Local file attachment: ${file.name}\n${canonical}`),
            )
        }
      }
      for (const file of files) {
        const info = await stat(file.path)
        this.checkAttempt(attempt)
        if (
          !info.isFile() ||
          info.size !== file.size ||
          info.ino !== file.ino ||
          info.mtimeMs !== file.mtimeMs ||
          (await realpath(file.path)) !== file.path
        )
          fail('ATTACHMENT_CHANGED')
      }
      this.checkAttempt(attempt)
      if (byteSize(inputs) > 4 * MiB) fail('INPUT_LIMIT')
      return inputs
    })().finally(releaseWork)
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          onAbort = () => reject(new Error('CODEX_PREPARATION_CANCELLED'))
          attempt.controller.signal.addEventListener('abort', onAbort, {
            once: true,
          })
          timer = setTimeout(
            () => {
              attempt.controller.abort()
            },
            Math.max(1, attempt.deadline - performance.now()),
          )
          if (attempt.controller.signal.aborted) onAbort()
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
      if (onAbort)
        attempt.controller.signal.removeEventListener('abort', onAbort)
    }
  }
  private checkAttempt(attempt: Attempt) {
    this.assertLive()
    if (this.settingsValidation) fail('SETTINGS_PENDING')
    if (
      attempt.controller.signal.aborted ||
      attempt.cancelled ||
      performance.now() >= attempt.deadline ||
      attempt.phase !== 'preparing' ||
      (attempt.captured
        ? this.steering !== attempt ||
          this.active !== attempt.captured ||
          !!attempt.captured.outcome
        : this.ordinary !== attempt || !!this.active)
    )
      fail('PREPARATION_CANCELLED')
  }
  private assertLive() {
    if (
      this.closed ||
      !this.root ||
      !this.policy ||
      this.connection?.process.signal.aborted
    )
      fail('RUNTIME_UNAVAILABLE')
  }
  cancel(): Promise<void> {
    if (this.cancelling) return this.cancelling
    const attempt = this.ordinary
    if (attempt?.phase === 'preparing') {
      attempt.cancelled = true
      attempt.controller.abort()
      this.ordinary = undefined
      return Promise.resolve()
    }
    if (this.steering?.phase === 'preparing') {
      this.steering.cancelled = true
      this.steering.controller.abort()
    }
    if (attempt?.phase === 'submitted') {
      attempt.cancelled = true
      // The original response deadline bounds cancellation; no unknown turn is interrupted.
      this.cancelling = attempt.done.finally(() => {
        this.cancelling = undefined
      })
      return this.cancelling
    }
    if (!this.active || this.active.outcome) return Promise.resolve()
    this.cancelling = this.interrupt(this.active).finally(() => {
      this.cancelling = undefined
    })
    return this.cancelling
  }
  private async interrupt(owner: TurnOwner) {
    if (owner.outcome || this.closed) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const grace = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(
          () => resolve('timeout'),
          this.options.interruptGraceMs ?? 5000,
        )
      })
      void this.connection!.request('turn/interrupt', {
        threadId: owner.nativeThreadId,
        turnId: owner.nativeTurnId,
      }).catch(() => {})
      const result = await Promise.race([owner.completion!, grace])
      if (result === 'timeout' && !owner.outcome) {
        this.finish(owner, {
          status: 'interrupted',
          reason: 'Codex process stopped after interrupt deadline',
        })
        await this.retire(new Error('CODEX_INTERRUPT_TIMEOUT'))
      }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  kill() {
    return this.retire(new Error('CODEX_KILLED'), true)
  }
  replyPermission(reply: PermissionReply) {
    return this.requests!.replyPermission(reply)
  }
  replyQuestion(requestId: string, answers: Record<string, QuestionAnswer>) {
    return this.requests!.replyQuestion(requestId, answers)
  }
  setModel(modelId: string) {
    const model = this.models.find((model) => model.id === modelId)
    if (!model) fail('MODEL_UNAVAILABLE')
    this.policy!.set({ model: model.model })
  }
  configOptions() {
    const selected = this.policy!.resolve()
    const model = this.models.find((entry) => entry.model === selected.model)
    return [
      {
        id: 'model',
        name: 'Model for the next turn',
        type: 'select' as const,
        currentValue: model?.id ?? selected.model ?? '',
        options: this.availableModels.map((entry) => ({
          value: entry.id,
          name: entry.displayName,
        })),
      },
      {
        id: 'reasoning',
        name: 'Reasoning for the next turn',
        type: 'select' as const,
        currentValue: selected.reasoning ?? '',
        options:
          model?.supportedReasoningEfforts.map((entry) => ({
            value: entry.reasoningEffort,
            name: entry.reasoningEffort,
            description: entry.description,
          })) ?? [],
      },
      {
        id: 'serviceTier',
        name: 'Service tier for the next turn',
        type: 'select' as const,
        currentValue: selected.serviceTier ?? 'default',
        options: [
          { value: 'default', name: 'Default' },
          ...(model?.serviceTiers
            ?.filter((tier) => tier.id !== 'default')
            .map((tier) => ({
              value: tier.id,
              name: tier.name,
              description: tier.description,
            })) ?? []),
        ],
      },
      {
        id: 'permissionMode',
        name: 'Permissions for the next turn',
        type: 'select' as const,
        currentValue: selected.permissionMode,
        options: ['manual', 'auto', 'yolo'].map((value) => ({
          value,
          name: value,
        })),
      },
    ]
  }
  async setConfigOption(configId: string, value: string | boolean) {
    const selected = this.models.find(
      (model) => model.model === this.policy!.resolve().model,
    )
    if (
      configId === 'permissionMode' &&
      typeof value === 'string' &&
      ['manual', 'auto', 'yolo'].includes(value)
    )
      this.policy!.set({ permissionMode: value })
    else if (configId === 'model' && typeof value === 'string')
      this.setModel(value)
    else if (
      configId === 'reasoning' &&
      typeof value === 'string' &&
      selected?.supportedReasoningEfforts.some(
        (effort) => effort.reasoningEffort === value,
      )
    )
      this.policy!.set({ reasoning: value })
    else if (
      configId === 'serviceTier' &&
      typeof value === 'string' &&
      (value === 'default' ||
        selected?.serviceTiers?.some((tier) => tier.id === value))
    )
      this.policy!.set({ serviceTier: value })
    else fail('CONFIG_OPTION')
  }
  private admitOwner(
    thread: string,
    turn: string,
    attempt?: Attempt,
    parent?: TurnOwner,
    assignment?: Assignment,
  ) {
    idSchema.parse(thread)
    idSchema.parse(turn)
    const key = tupleId(thread, turn)
    if (this.owners.has(key)) fail('TURN_OWNER_CONFLICT')
    if (!attempt && !parent && this.active) fail('ROOT_TURN_CONFLICT')
    const child = thread !== this.root!.id
    const runId = attempt?.runId ?? parent?.runId ?? randomUUID()
    const turnId = attempt?.turnId ?? parent?.turnId ?? randomUUID()
    const completion =
      attempt?.completion ??
      createCompletionHandle({ completionId: randomUUID(), runId, turnId })
    const effective = child
      ? undefined
      : (attempt?.effective ?? this.nativeOptions!)
    const retainedBytes = byteSize([thread, turn, runId, turnId, key]) + 256
    const release = this.budget.charge(
      'owners',
      retainedBytes + byteSize(effective) + 256,
      8192,
      8 * MiB,
    )
    let childRelease: (() => void) | undefined
    let releaseActive: (() => void) | undefined
    let releaseFull: (() => void) | undefined
    try {
      releaseFull = this.budget.charge('full-owners', 0, 4096, 8 * MiB)
      if (child)
        releaseActive = this.budget.charge(
          'active-children',
          byteSize([thread, turn, runId, turnId]) + 256,
          128,
          2 * MiB,
        )
      if (child)
        childRelease = this.budget.charge(
          'child-executions',
          byteSize([thread, turn, key]) + 256,
          8192,
          8 * MiB,
        )
    } catch (error) {
      releaseActive?.()
      releaseFull?.()
      release()
      throw error
    }
    const owner: TurnOwner = {
      runId,
      turnId,
      nativeThreadId: thread,
      nativeTurnId: turn,
      effective,
      completion: completion.handle,
      settle: completion.settle,
      releaseActive,
      releaseFull,
      resize: release.resize,
      retainedBytes,
      ...(child
        ? {
            childId: randomUUID(),
            parentChildId: parent?.childId,
            parentToolCallId: assignment?.toolId,
          }
        : {}),
      release: () => {
        release()
        childRelease?.()
        releaseActive?.()
        releaseFull?.()
      },
    }
    this.owners.set(key, owner)
    return owner
  }
  private finish(owner: TurnOwner, outcome: TerminalOutcome) {
    if (owner.outcome) return
    owner.outcome = outcome
    owner.releaseActive?.()
    if (owner.childId)
      this.normalizer.emit(owner, 'child', {
        type: 'child_finished',
        childId: owner.childId,
        outcome,
      })
    else {
      if (this.active === owner) this.active = undefined
      if (
        this.steering?.captured === owner &&
        this.steering.phase === 'preparing'
      )
        this.steering.controller.abort()
      this.normalizer.lifecycle(owner, 'turn_completed', { outcome })
      if (outcome.status === 'failed')
        this.normalizer.lifecycle(owner, 'run_failed', {
          code: outcome.code,
          message: outcome.message,
        })
    }
    owner.settle?.({ runId: owner.runId, turnId: owner.turnId, ...outcome })
    // Keep native identity and first outcome; external receipts retain their settled promise.
    owner.resize(owner.retainedBytes + byteSize(outcome))
    owner.effective = undefined
    owner.completion = undefined
    owner.settle = undefined
    owner.releaseFull?.()
    owner.releaseFull = undefined
  }
  private receive(message: JsonRpcIncoming) {
    if (this.closed) return
    try {
      if (message.type === 'request' && typeof message.id === 'string')
        idSchema.parse(message.id)
      const params = message.params
      if (!record(params)) {
        if (message.type === 'request') {
          void this.requests!.unsupported(message)
          return
        }
        fail('NOTIFICATION_SHAPE')
      }
      if (
        message.type === 'notification' &&
        message.method.startsWith('turn/') &&
        ![
          'turn/started',
          'turn/completed',
          'turn/plan/updated',
          'turn/diff/updated',
        ].includes(message.method)
      )
        fail('LIFECYCLE_UNSUPPORTED')
      if (
        message.type === 'request' &&
        ((message.method === 'mcpServer/elicitation/request' &&
          (params.mode !== 'form' || params.turnId == null)) ||
          ![
            'item/commandExecution/requestApproval',
            'item/fileChange/requestApproval',
            'item/permissions/requestApproval',
            'item/tool/requestUserInput',
            'mcpServer/elicitation/request',
          ].includes(message.method))
      ) {
        void this.requests!.unsupported(message)
        return
      }
      if (message.method === 'serverRequest/resolved') {
        const data = z
          .object({
            threadId: idSchema,
            requestId: z.union([idSchema, z.number().int()]),
          })
          .parse(params)
        this.requests!.resolve(data.threadId, data.requestId)
        for (let index = this.buffers.length - 1; index >= 0; index--) {
          const entry = this.buffers[index]!
          const request = entry.message
          if (
            request.type === 'request' &&
            request.id === data.requestId &&
            record(request.params) &&
            request.params.threadId === data.threadId
          ) {
            this.buffers.splice(index, 1)
            this.rpc!.dismiss(request)
            entry.release()
          }
        }
        return
      }
      if (message.method.startsWith('account/')) {
        this.globalFrame(message.method, params)
        return
      }
      if (!this.root) {
        this.buffer(message)
        return
      }
      this.route(message)
    } catch (error) {
      void this.retire(diagnosticError(error, this.options.secrets))
    }
  }
  private route(message: JsonRpcIncoming, buffered = false): boolean {
    const params = message.params as Record<string, unknown>
    if (message.method === 'thread/started') {
      const thread = threadSchema.parse(params.thread)
      if (thread.id !== this.root!.id) this.discover(thread)
      return true
    }
    if (message.method === 'thread/settings/updated') {
      if (params.threadId === this.root!.id && record(params.threadSettings)) {
        const settings = params.threadSettings
        if (settings.cwd !== this.confirmed!.cwd) fail('SETTINGS_CWD')
        // A settings change cannot replace the bound workspace or weaken the active policy.
        if (
          this.active &&
          (!same(
            settings.approvalPolicy,
            this.active.effective!.approvalPolicy,
          ) ||
            !sameSandbox(
              settings.sandboxPolicy,
              this.active.effective!.sandboxPolicy,
            ))
        )
          fail('SETTINGS_RESTRICTIONS')
        const provider = idSchema.parse(settings.modelProvider)
        if (
          this.connection &&
          provider !== this.connection.provenance.selectedProviderId
        ) {
          if (this.settingsValidation) fail('SETTINGS_CONFLICT')
          this.settingsValidation = this.connection!.request('config/read', {
            cwd: this.confirmed!.cwd,
            includeLayers: false,
          })
            .then((value) => {
              if (this.closed) return
              const admitted = admitCodexConfiguration(value, {
                accountId: this.options.accountId,
                expectedHome: this.options.expectedCodexHome,
              })
              if (admitted.provenance.selectedProviderId !== provider)
                fail('SETTINGS_PROVIDER')
              this.connection!.provenance = admitted.provenance
            })
            .catch((error: unknown) =>
              this.retire(diagnosticError(error, this.options.secrets)),
            )
            .finally(() => {
              this.settingsValidation = undefined
            })
        }
      }
      return true
    }
    if (typeof params.threadId !== 'string') {
      if (
        message.type === 'request' ||
        message.method.startsWith('turn/') ||
        message.method.startsWith('item/')
      )
        fail('NOTIFICATION_SCOPE')
      this.startupDiagnostic('Unsupported global notification')
      return true
    }
    const threadId = idSchema.parse(params.threadId)
    const nativeTurn =
      message.method === 'turn/started' || message.method === 'turn/completed'
        ? turnSchema.parse(params.turn)
        : undefined
    const turnId =
      nativeTurn?.id ??
      (params.turnId == null ? undefined : idSchema.parse(params.turnId))
    if (!turnId) {
      if (
        message.type === 'request' ||
        message.method.startsWith('turn/') ||
        message.method.startsWith('item/')
      )
        fail('NOTIFICATION_SCOPE')
      return true
    }
    let owner = this.owners.get(tupleId(threadId, turnId))
    if (!owner && message.method === 'turn/started') {
      if (threadId === this.root!.id) {
        if (this.ordinary?.phase === 'submitted') {
          if (!buffered) this.buffer(message)
          return false
        }
        owner = this.admitOwner(threadId, turnId)
        this.active = owner
        if (this.ordinary?.phase === 'preparing')
          this.ordinary.controller.abort()
        this.normalizer.lifecycle(owner, 'run_started')
        this.normalizer.lifecycle(owner, 'turn_started')
      } else {
        const lineage = this.lineage.get(threadId)
        if (!lineage || this.lineageDepth(threadId) === undefined) {
          this.scheduleMetadata(threadId)
          if (!buffered) this.buffer(message)
          return false
        }
        const candidates = [...this.assignments.values()].filter(
          (assignment) => assignment.target === threadId,
        )
        if (candidates.length > 1) {
          if (!buffered) this.buffer(message)
          return false
        }
        const assignment = candidates[0]
        const parent = assignment?.owner ?? lineage.rootOwner
        if (!parent) {
          if (!buffered) this.buffer(message)
          return false
        }
        owner = this.admitOwner(threadId, turnId, undefined, parent, assignment)
        lineage.rootOwner ??= parent
        if (assignment) {
          this.assignments.delete(assignment.key)
          assignment.release()
        }
        this.normalizer.emit(owner, 'child', {
          type: 'child_started',
          childId: owner.childId,
          providerChildId: threadId,
          ...(owner.parentChildId
            ? { parentChildId: owner.parentChildId }
            : {}),
          ...(owner.parentToolCallId
            ? { parentToolCallId: owner.parentToolCallId }
            : {}),
          description: 'Codex child task',
        })
      }
    }
    if (!owner) {
      if (threadId !== this.root!.id) this.scheduleMetadata(threadId)
      if (!buffered) this.buffer(message)
      return false
    }
    if (message.type === 'request') {
      this.requests!.receive(message, owner)
      return true
    }
    if (nativeTurn) {
      if (message.method === 'turn/completed') {
        this.normalizer.turn(owner, nativeTurn)
        const outcome = terminalOutcome(nativeTurn, this.options.secrets)
        if (!outcome) fail('COMPLETION_STATUS')
        this.finish(owner, outcome)
      }
      return true
    }
    if (
      (message.method === 'item/started' ||
        message.method === 'item/completed') &&
      record(params.item)
    ) {
      const item = params.item
      if (item.type === 'userMessage' && typeof item.clientId === 'string') {
        this.echoes.get(item.clientId)?.()
        this.echoes.delete(item.clientId)
      }
      if (
        item.type === 'collabAgentToolCall' ||
        item.type === 'subAgentActivity'
      )
        this.collaboration(owner, item)
    }
    this.normalizer.notification(owner, message.method, params)
    return true
  }
  private collaboration(owner: TurnOwner, item: Record<string, unknown>) {
    const itemId = idSchema.parse(item.id)
    const toolId = tupleId(
      owner.nativeThreadId,
      owner.nativeTurnId,
      itemId,
      'tool',
    )
    if (item.type === 'collabAgentToolCall') {
      if (
        item.senderThreadId !== owner.nativeThreadId ||
        !Array.isArray(item.receiverThreadIds)
      )
        fail('CHILD_ANCESTRY')
      for (const value of item.receiverThreadIds) {
        const target = idSchema.parse(value)
        if (target === this.root!.id) continue
        if (item.tool === 'spawnAgent')
          this.addLineage(target, owner.nativeThreadId, owner)
        else if (!this.lineage.has(target)) this.scheduleMetadata(target)
        if (
          item.tool === 'spawnAgent' ||
          item.tool === 'followupTask' ||
          item.tool === 'sendInput'
        )
          this.assign(target, owner, itemId, toolId, item.tool === 'spawnAgent')
      }
    } else {
      const target = idSchema.parse(item.agentThreadId)
      if (target === this.root!.id) return
      if (!this.lineage.has(target)) this.scheduleMetadata(target)
      if (item.kind === 'started' || item.kind === 'interacted')
        this.assign(target, owner, itemId, toolId, item.kind === 'started')
    }
    this.drainBuffers()
  }
  private assign(
    target: string,
    owner: TurnOwner,
    item: string,
    toolId: string,
    enrichProvisional = false,
  ) {
    const key = tupleId(owner.nativeThreadId, owner.nativeTurnId, item, target)
    if (this.assignmentIds.has(key)) return
    const releaseId = this.budget.charge(
      'items',
      byteSize(key),
      32768,
      12 * MiB,
    )
    if (enrichProvisional) {
      const candidates = [...this.owners.values()].filter(
        (entry) =>
          entry.nativeThreadId === target &&
          entry.runId === owner.runId &&
          entry.turnId === owner.turnId &&
          entry.parentToolCallId === undefined,
      )
      if (candidates.length === 1) {
        const execution = candidates[0]!
        execution.parentToolCallId = toolId
        execution.parentChildId = owner.childId
        this.assignmentIds.set(key, releaseId)
        this.normalizer.emit(execution, 'child', {
          type: 'child_updated',
          childId: execution.childId,
          parentToolCallId: toolId,
          providerChildId: target,
          ...(owner.childId ? { parentChildId: owner.childId } : {}),
        })
        return
      }
    }
    let release: () => void
    try {
      release = this.budget.charge(
        'assignments',
        byteSize([key, target, toolId, owner.runId, owner.turnId]) + 128,
        256,
        MiB,
      )
    } catch (error) {
      releaseId()
      throw error
    }
    this.assignmentIds.set(key, releaseId)
    this.assignments.set(key, {
      key,
      target,
      owner,
      toolId,
      deadline: performance.now() + 30_000,
      release,
    })
    this.armResolution()
  }
  private addLineage(
    thread: string,
    parent: string,
    owner?: TurnOwner,
    sessionId?: string,
  ) {
    if (thread === this.root!.id || thread === parent) fail('CHILD_ANCESTRY')
    const old = this.lineage.get(thread)
    if (old) {
      if (
        old.parent !== parent ||
        (old.sessionId && sessionId && old.sessionId !== sessionId)
      )
        fail('CHILD_ANCESTRY')
      old.rootOwner ??= owner
      old.sessionId ??= sessionId
    } else {
      const release = this.budget.charge(
        'lineage',
        byteSize([thread, parent, sessionId, owner?.runId, owner?.turnId]) +
          136,
        2048,
        4 * MiB,
      )
      this.lineage.set(thread, {
        threadId: thread,
        parent,
        rootOwner: owner,
        sessionId,
        release,
      })
    }
    // Only incomplete paths need another proof when an ancestor arrives.
    for (const lineage of this.lineage.values())
      if (lineage.depth === undefined)
        lineage.depth = this.lineageDepth(lineage.threadId)
  }
  private lineageDepth(thread: string): number | undefined {
    let ancestor = thread
    const seen = new Set<string>()
    let depth = 0
    while (ancestor !== this.root!.id) {
      if (seen.has(ancestor) || ++depth > 32) fail('CHILD_DEPTH')
      seen.add(ancestor)
      const lineage = this.lineage.get(ancestor)
      if (!lineage) {
        this.scheduleMetadata(ancestor)
        return undefined
      }
      ancestor = lineage.parent
    }
    return depth
  }
  private discover(thread: NativeThread) {
    if (thread.sessionId !== this.root!.sessionId) fail('CHILD_FOREIGN_TREE')
    const source = thread.source
    const sourceParent =
      record(source) &&
      record(source.subAgent) &&
      record(source.subAgent.thread_spawn)
        ? source.subAgent.thread_spawn.parent_thread_id
        : undefined
    if (sourceParent !== undefined) idSchema.parse(sourceParent)
    if (
      thread.parentThreadId &&
      sourceParent &&
      thread.parentThreadId !== sourceParent
    )
      fail('CHILD_ANCESTRY')
    const parent = thread.parentThreadId ?? sourceParent
    if (typeof parent !== 'string') fail('CHILD_ANCESTRY')
    const parentOwners = [...this.owners.values()].filter(
      (owner) => owner.nativeThreadId === parent,
    )
    const unique = parentOwners.length === 1 ? parentOwners[0] : undefined
    this.addLineage(thread.id, parent, unique, thread.sessionId)
    this.drainBuffers()
  }
  private scheduleMetadata(threadId: string) {
    if (this.metadata.has(threadId) || this.lineage.has(threadId)) return
    if (this.failedMetadata.has(threadId)) fail('METADATA_UNAVAILABLE')
    if (this.metadataQueue.length >= 64) fail('METADATA_QUEUE_LIMIT')
    const release = this.budget.charge(
      'metadata',
      byteSize(threadId),
      68,
      256 * 1024,
    )
    const task = { threadId, deadline: performance.now() + 30_000, release }
    this.metadata.set(threadId, task)
    this.metadataQueue.push(task)
    this.drainMetadata()
    this.armResolution()
  }
  private drainMetadata() {
    if (!this.connection || this.closed) return
    while (this.metadataRunning < 4 && this.metadataQueue.length) {
      const task = this.metadataQueue.shift()!
      this.metadataRunning++
      void this.connection!.request(
        'thread/read',
        { threadId: task.threadId, includeTurns: false },
        {
          timeoutMs: Math.max(1, Math.floor(task.deadline - performance.now())),
        },
      )
        .then((value) => {
          if (this.closed || performance.now() >= task.deadline) return
          const data = z.object({ thread: threadSchema }).parse(value)
          if (data.thread.id !== task.threadId) fail('METADATA_ID')
          this.discover(data.thread)
        })
        .catch(() => {
          if (this.closed) return
          if (!this.failedMetadata.has(task.threadId))
            this.failedMetadata.set(
              task.threadId,
              this.budget.charge(
                'failed-metadata',
                byteSize(task.threadId),
                256,
                256 * 1024,
              ),
            )
        })
        .finally(() => {
          this.metadataRunning--
          this.metadata.delete(task.threadId)
          task.release()
          this.drainMetadata()
        })
        .catch((error: unknown) => {
          void this.retire(diagnosticError(error, this.options.secrets))
        })
    }
  }
  private buffer(message: JsonRpcIncoming) {
    const release = this.budget.charge(
      'buffers',
      byteSize(message.params) + byteSize(message.method) + 128,
      1024,
      8 * MiB,
    )
    let releaseWaiter: () => void
    try {
      releaseWaiter = this.budget.charge(
        'metadata-waiters',
        64,
        1024,
        256 * 1024,
      )
    } catch (error) {
      release()
      throw error
    }
    this.buffers.push({
      message,
      release: () => {
        release()
        releaseWaiter()
      },
      deadline: performance.now() + 30_000,
    })
    this.armResolution()
  }
  private draining = false
  private drainBuffers() {
    if (!this.root || this.draining || this.closed) return
    this.draining = true
    try {
      for (let index = 0; index < this.buffers.length;) {
        const entry = this.buffers[index]!
        if (entry.message.signal.aborted || this.route(entry.message, true)) {
          this.buffers.splice(index, 1)
          entry.release()
        } else index++
      }
    } finally {
      this.draining = false
    }
  }
  private armResolution() {
    if (this.resolutionTimer || this.closed) return
    const deadlines = [
      ...this.buffers.map((entry) => entry.deadline),
      ...[...this.assignments.values()].map((entry) => entry.deadline),
      ...[...this.metadata.values()].map((entry) => entry.deadline),
    ]
    if (!deadlines.length) return
    this.resolutionTimer = setTimeout(
      () => {
        this.resolutionTimer = undefined
        if (this.closed) return
        const now = performance.now()
        const expired = this.buffers.filter((entry) => entry.deadline <= now)
        for (const entry of expired)
          if (entry.message.type === 'request')
            void this.requests!.unsupported(entry.message)
        if (
          expired.length ||
          [...this.assignments.values()].some((entry) => entry.deadline <= now)
        ) {
          void this.retire(new Error('CODEX_OWNERSHIP_UNRESOLVED'))
          return
        }
        this.armResolution()
      },
      Math.max(1, Math.min(...deadlines) - performance.now()),
    )
  }
  private globalFrame(method: string, params: Record<string, unknown>) {
    if (byteSize(params) > 256 * 1024) fail('GLOBAL_LIMIT')
    let key = 'account'
    if (method === 'account/rateLimits/updated') {
      if (!record(params.rateLimits)) fail('GLOBAL_SHAPE')
      key = `rate:${tupleId(idSchema.parse(params.rateLimits.limitId ?? 'default'))}`
      if (
        !this.global.has(key) &&
        [...this.global.keys()].filter((key) => key.startsWith('rate:'))
          .length >= 32
      )
        fail('GLOBAL_RATE_LIMIT')
    } else if (method !== 'account/updated' && method !== 'account/read') {
      this.startupDiagnostic('Unsupported account notification')
      return
    }
    const old = this.global.get(key)
    old?.release()
    this.global.delete(key)
    const release = this.budget.charge(
      'global',
      byteSize(params) + byteSize(key),
      33,
      256 * 1024,
    )
    this.global.set(key, { value: params, release })
  }
  private startupDiagnostic(message: string) {
    if (this.startupMessages.length >= 64)
      this.startupMessages.shift()!.release()
    const release = this.budget.charge(
      'startup-diagnostics',
      byteSize(message),
      64,
      64 * 1024,
    )
    this.startupMessages.push({ message, release })
  }
  private retire(reason: Error, interrupted = false): Promise<void> {
    if (this.closing) return this.closing
    this.closed = reason
    this.closing = Promise.resolve().then(async () => {
      this.ordinary?.controller.abort()
      this.steering?.controller.abort()
      this.requests?.expireAll('Codex runtime ended')
      if (this.resolutionTimer) clearTimeout(this.resolutionTimer)
      for (const owner of this.owners.values())
        if (!owner.outcome)
          this.finish(
            owner,
            interrupted || this.ordinary?.cancelled
              ? { status: 'interrupted', reason: 'Codex process stopped' }
              : {
                  status: 'failed',
                  code: 'CODEX_RUNTIME_FAILED',
                  message: diagnosticError(reason, this.options.secrets)
                    .message,
                },
          )
      try {
        await this.connection?.process.close(reason)
        if (!this.connection) await this.rpc?.close(reason)
      } finally {
        for (const entry of this.buffers) entry.release()
        this.buffers.length = 0
        for (const entry of this.assignments.values()) entry.release()
        this.assignments.clear()
        for (const release of this.assignmentIds.values()) release()
        this.assignmentIds.clear()
        for (const entry of this.metadata.values()) entry.release()
        this.metadata.clear()
        this.metadataQueue.length = 0
        for (const release of this.failedMetadata.values()) release()
        this.failedMetadata.clear()
        for (const release of this.echoes.values()) release()
        this.echoes.clear()
        for (const entry of this.global.values()) entry.release()
        this.global.clear()
        for (const entry of this.startupMessages) entry.release()
        this.startupMessages.length = 0
        for (const entry of this.lineage.values()) entry.release()
        this.lineage.clear()
        for (const entry of this.owners.values()) entry.release()
        this.owners.clear()
        for (const release of this.identityReleases.values()) release()
        this.identityReleases.clear()
        this.identities.clear()
        this.normalizer.close()
        this.releaseModels?.()
        this.models = []
        this.releaseOptions()
        this.releasePolicyReserve()
        for (const release of this.releaseControlReserve) release()
      }
    })
    return this.closing
  }
}

export function createCodexAdapter(input: CodexAdapterOptions): HarnessAdapter {
  parseOptions(input.initialOptions)
  if (
    (input.secrets?.length ?? 0) > 256 ||
    byteSize(input.secrets ?? []) > 256 * 1024
  )
    fail('SECRETS_LIMIT')
  const launch = copyLaunchOptions(input)
  const options = {
    ...input,
    ...launch,
    initialOptions:
      input.initialOptions === undefined
        ? undefined
        : structuredClone(input.initialOptions),
    secrets: [...(input.secrets ?? [])],
  } as CodexAdapterOptions
  if (typeof options.loadAttachment !== 'function') fail('ATTACHMENT_LOADER')
  for (const value of [
    options.startupTimeoutMs ?? 30_000,
    options.interruptGraceMs ?? 5000,
    options.preparationTimeoutMs ?? 30_000,
  ])
    positiveLimit(value, 'Codex duration')
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
    spawn: (session, emit) =>
      new CodexActivation(options, structuredClone(session), emit).start(false),
    load: (session, emit) =>
      new CodexActivation(options, structuredClone(session), emit).start(true),
  }
}
