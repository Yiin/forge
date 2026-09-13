import { randomUUID } from 'node:crypto'
import type {
  TerminalOutcome,
  CompletionFailureIdentity,
} from '@forge/protocol/harness'
import {
  createCompletionHandle,
  isCompletionPersistenceFailure,
  type RejectingCompletionProducer,
  type DispatchOptions,
  type HarnessEvent,
  type HarnessSession,
  type PromptInput,
} from '../types.js'
import {
  KimiBudget,
  KimiError,
  boundedString,
  deadline,
  jsonBytes,
  sequence,
  reserveAll,
} from './limits.js'
import {
  captureInput,
  prepareInput,
  resolveSettings,
  promptTextBytes,
  validatePromptEnvelope,
  validateExactPromptEnvelope,
  type KimiSettings,
} from './input.js'
import { digest, record, KimiRecords } from './records.js'
import {
  KimiCompletionPersistenceError,
  type KimiCommitAttempt,
} from './persistence.js'
import { KimiReplay, KimiTranscript } from './transcript.js'
import { KimiInteractions } from './interactions.js'
import {
  preserveMessage,
  readCatalog,
  validateNativeSession,
  readHistoryPage,
  checkHistoryDeadline,
} from './discovery.js'
import { sessionFrame, subscriptionAck, type KimiFrame } from './wire.js'
import { object } from './transport.js'
import { validateSession, type EffectiveAuthority } from './authority.js'
import type { KimiHostOwner, KimiLease } from './host.js'
import type {
  KimiAdapterOptions,
  KimiCatalog,
  KimiChildOwner,
  KimiDelivery,
  KimiHandle,
  KimiPromptAcceptance,
  KimiReceipt,
  KimiRoot,
  KimiNativeRecord,
} from './types.js'

function controlled<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((end) => {
    resolve = end
  })
  return { promise, resolve }
}
type Operation = {
  receipt: KimiReceipt
  identity: CompletionFailureIdentity
  root: KimiRoot
  input: readonly PromptInput[]
  settings: KimiSettings
  controller: AbortController
  acceptance: ReturnType<typeof controlled<KimiPromptAcceptance>>
  delivery: ReturnType<typeof controlled<KimiDelivery>>
  completion: RejectingCompletionProducer
  accepted?: Extract<KimiPromptAcceptance, { status: 'accepted' }>
  providerTurn?: string
  baseline: number
  candidates: KimiFrame[]
  candidateReleases: (() => void)[]
  settled: boolean
  preparing: boolean
  postAttempted?: boolean
  promptTerminal?: KimiFrame
  turnTerminal?: KimiFrame
  parent?: Operation
  steerAck?: boolean
  steerEdge?: KimiFrame
  release: () => void
  terminal: ReturnType<typeof controlled<void>>
  beforeMessage?: { id: string; revision: string } | null
  finishing?: Promise<void>
  finalizing?: Promise<void>
  terminalAttempt?: KimiCommitAttempt
  persistenceFailure?: KimiCompletionPersistenceError
  releaseQueue?: () => void
  outcome?: TerminalOutcome
  steerCommitted?: boolean
  aborting?: Promise<void>
}
export class KimiRuntime implements KimiHandle {
  private transcriptStoreRevision = 0
  private storeIdentity() {
    return digest([
      this.lease.server.transcriptStore,
      this.binding.providerSessionId,
      this.transcriptStoreRevision,
    ])
  }
  private async installTranscriptBaseline(
    agent: string,
    read?: (path: string, maximum: number) => Promise<Record<string, unknown>>,
    end = performance.now() + this.budget.limits.historyMs,
  ) {
    const limits = this.budget.limits,
      pages: Record<string, unknown>[] = [],
      releases: (() => void)[] = [],
      seen = new Set<string>()
    let before: string | undefined,
      watermark: number | undefined,
      globalHash: string | undefined
    try {
      for (let page = 0; page < limits.historyPages; page++) {
        if (performance.now() >= end)
          throw new KimiError('kimi_history_deadline')
        const path = `${this.basePath()}/transcript?agent_id=${encodeURIComponent(agent)}&page_size=${limits.pageTurns}${before ? `&before_turn=${encodeURIComponent(before)}` : ''}`
        const owned = await readHistoryPage(
          this.lease,
          this.host,
          this.budget,
          path,
          this.controller.signal,
          end,
          read,
        )
        const { value, bytes } = owned
        releases.push(owned.release)
        this.budget.add('historyBytes', bytes)
        if (
          value.agent_id !== agent ||
          !Array.isArray(value.items) ||
          typeof value.has_more !== 'boolean' ||
          value.items.filter((item) => object(item).kind === 'turn').length >
            limits.pageTurns
        )
          throw new KimiError('kimi_transcript_baseline')
        const seq = sequence(value.seq),
          { items, has_more: _more, ...global } = value,
          hash = digest(global)
        if (
          watermark !== undefined &&
          (seq !== watermark || globalHash !== hash)
        )
          throw new KimiError('kimi_baseline_changed')
        watermark = seq
        globalHash = hash
        pages.unshift(value)
        if (!value.has_more) {
          const snapshot = {
            ...value,
            items: pages.flatMap((page) => page.items as unknown[]),
            has_more: false,
          }
          if (performance.now() >= end)
            throw new KimiError('kimi_history_deadline')
          await this.transcript.baseline(
            agent,
            snapshot,
            this.storeIdentity(),
            end,
          )
          if (performance.now() >= end)
            throw new KimiError('kimi_history_deadline')
          return
        }
        const first = items.find((item) => object(item).kind === 'turn')
        before = boundedString(
          first && object(first).turnId,
          limits.cursorBytes,
        )
        if (seen.has(before) || seen.size >= limits.cursorEntries)
          throw new KimiError('kimi_history_progress')
        seen.add(before)
      }
      throw new KimiError('kimi_history_page_limit')
    } finally {
      releases.forEach((release) => release())
    }
  }
  readonly binding
  readonly catalog: KimiCatalog
  readonly availableModels
  private readonly generation = randomUUID()
  private readonly controller = new AbortController()
  private readonly operations = new Map<string, Operation>()
  private persistenceFailure?: KimiCompletionPersistenceError
  private readonly roots = new Map<string, Operation>()
  private readonly retainedState = new Set<() => void>()
  private releaseSnapshot: () => void = () => {}
  private retainState(
    value: unknown,
    owner: 'ownerBytes' | 'childOwnerBytes' | 'retainedBytes' = 'ownerBytes',
    count = true,
  ) {
    const bytes = jsonBytes(
      value,
      this.budget.limits,
      this.budget.limits[owner],
    )
    const free = reserveAll([
      ...(count ? [[this.budget, 'ownerEntries'] as const] : []),
      [this.budget, owner, bytes],
      [this.host.budget, 'hostRetainedBytes', bytes],
    ])
    const release = () => {
      free()
      this.retainedState.delete(release)
    }
    this.retainedState.add(release)
    return release
  }
  private clearRetainedState() {
    this.roots.clear()
    this.restoredOwners.clear()
    this.toolOwners.clear()
    this.childTurns.clear()
    this.children.clear()
    this.latestUsage.clear()
    this.operations.clear()
    this.releaseSnapshot()
    for (const release of this.retainedState) release()
  }
  private readonly restoredOwners = new Map<string, KimiRoot>()
  private readonly toolOwners = new Map<string, KimiRoot>()
  private readonly childTurns = new Map<string, KimiChildOwner>()
  private readonly latestUsage = new Map<
    string,
    {
      event: Extract<HarnessEvent, { type: 'usage' }>
      hash?: string
      release: () => void
    }
  >()
  private readonly children = new Map<
    string,
    {
      owner: KimiChildOwner
      end?: number
      finished: boolean
      restored?: boolean
    }[]
  >()
  private records: KimiRecords
  private readonly interactions: KimiInteractions
  private readonly transcript: KimiTranscript
  private replay!: KimiReplay
  private lifeId = randomUUID()
  private transcriptId = randomUUID()
  private recovery?: Promise<void>
  private transcriptReady = false
  private transcriptFlush: Promise<void> = Promise.resolve()
  private readonly transcriptPending: {
    frame: KimiFrame
    release: () => void
  }[] = []
  private mutation: Promise<void> = Promise.resolve()
  private steeringQueued = false
  private active?: Operation
  private admitting?: Operation
  private retired?: Error
  private released = false
  private defaults: KimiSettings
  private snapshot!: Record<string, unknown>
  private hookWorking = false
  private initialized = false
  private failureDiagnostic = false

  private constructor(
    private readonly session: HarnessSession,
    private readonly authority: EffectiveAuthority,
    private readonly host: KimiHostOwner,
    private readonly lease: KimiLease,
    binding: NonNullable<KimiHandle['binding']>,
    catalog: KimiCatalog,
    private readonly options: KimiAdapterOptions,
    emit: (event: HarnessEvent) => void,
    private readonly budget: KimiBudget,
  ) {
    this.binding = binding
    let records: KimiRecords | undefined
    try {
      this.retainState({ binding, catalog, session }, 'retainedBytes', false)
      this.catalog = catalog
      this.availableModels = catalog.models.map((model) => ({
        id: model.id,
        displayName: model.displayName ?? model.id,
      }))
      this.defaults = {
        model: authority.selected.account.config?.model,
        thinking: authority.selected.account.config?.thinking,
        permission_mode: 'manual',
      }
      this.records = records = new KimiRecords(
        { sessionId: session.id, binding, runtimeGeneration: this.generation },
        budget,
        host,
        options.commitRecords,
        emit,
        this.controller.signal,
        undefined,
        Object.entries(authority.environment)
          .filter(([key]) => /KEY|TOKEN|SECRET|PASSWORD/.test(key))
          .flatMap(([, value]) => (value ? [value] : [])),
      )
      this.interactions = new KimiInteractions(
        this.records,
        lease,
        (work) => this.mutate(work),
        (error) => this.retire(error),
      )
      this.transcript = new KimiTranscript(
        this.records,
        (root) => this.interactions.expire('Native turn removed', root),
        (agent, callId) => this.toolOwners.get(digest([agent, callId])),
      )
      void lease.server.done
        .then(async () => {
          if (!lease.server.cleanupProved) return
          await this.records.drain().catch(() => {})
          this.transcript.close()
          this.interactions.close()
          this.records.close()
          this.clearRetainedState()
        })
        .catch(() => {})
    } catch (error) {
      records?.close()
      this.clearRetainedState()
      throw error
    }
  }
  static async create(
    session: HarnessSession,
    authority: EffectiveAuthority,
    host: KimiHostOwner,
    options: KimiAdapterOptions,
    emit: (event: HarnessEvent) => void,
    load: boolean,
  ): Promise<KimiRuntime> {
    const validated = await validateSession(
      session,
      authority,
      load,
      host.budget.limits,
    )
    options.signal?.throwIfAborted()
    const lease = await host.acquire(
      authority,
      'session',
      validated.binding
        ? `native:${validated.binding.providerSessionId}`
        : `forge:${session.id}`,
    )
    const budget = new KimiBudget(host.budget.limits)
    let runtime: KimiRuntime | undefined
    let releaseCatalog = () => {}
    try {
      const ownedCatalog = await readCatalog(
        lease,
        budget,
        options.signal ?? new AbortController().signal,
      )
      const catalog = ownedCatalog.catalog
      releaseCatalog = ownedCatalog.release
      let binding = validated.binding
      const confirm = lease.resident(binding?.providerSessionId)
      if (!binding) {
        const response = object(
          await lease.server.http(lease.lane, '/api/v1/sessions', {
            method: 'POST',
            body: { metadata: { cwd: validated.cwd } },
            signal: options.signal,
          }),
        )
        binding = Object.freeze({
          provider: session.provider,
          accountId: authority.selected.account.id,
          cwd: validated.cwd,
          providerSessionId: boundedString(
            response.id,
            budget.limits.nativeIdBytes,
          ),
        })
        await validateNativeSession(response, binding)
      } else
        await validateNativeSession(
          await lease.server.http(
            lease.lane,
            `/api/v1/sessions/${encodeURIComponent(binding.providerSessionId)}`,
            { signal: options.signal },
          ),
          binding,
        )
      confirm(binding.providerSessionId)
      lease.claimWriter(binding.providerSessionId)
      runtime = new KimiRuntime(
        validated.session,
        authority,
        host,
        lease,
        binding,
        catalog,
        options,
        emit,
        budget,
      )
      await runtime.initialize()
      return runtime
    } catch (error) {
      if (runtime) await runtime.release()
      else await lease.close()
      throw new KimiError(
        load ? 'kimi_resume_failed' : 'kimi_startup_failed',
        error instanceof KimiError ? error.code : 'Kimi initialization failed',
      )
    } finally {
      releaseCatalog()
    }
  }
  private basePath() {
    return `/api/v1/sessions/${encodeURIComponent(this.binding.providerSessionId)}`
  }
  private base(op: Operation) {
    return {
      runId: op.root.runId,
      turnId: op.root.turnId,
      runtimeGeneration: this.generation,
      deliveryId: '',
      ...(op.providerTurn ? { providerTurnId: op.providerTurn } : {}),
    }
  }
  private async readSnapshot() {
    const owned = await readHistoryPage(
      this.lease,
      this.host,
      this.budget,
      `${this.basePath()}/snapshot`,
      this.controller.signal,
      performance.now() + this.budget.limits.historyMs,
    )
    const snapshot = owned.value
    try {
      await validateNativeSession(snapshot.session, this.binding)
      sequence(snapshot.as_of_seq)
      boundedString(snapshot.epoch, this.budget.limits.cursorBytes, true)
      const old = this.releaseSnapshot
      this.snapshot = snapshot
      this.releaseSnapshot = owned.release
      old()
      return snapshot
    } catch (error) {
      owned.release()
      throw error
    }
  }
  private async initialize() {
    const ownRecords = this.records
    const records = await this.lease.ingestion(
      this.binding.providerSessionId,
      this.session.id,
      () => ({
        records: ownRecords,
        ready: ownRecords.restore(this.options.readState),
      }),
    )
    if (records !== ownRecords) throw new KimiError('kimi_session_reader_busy')
    const sameStore =
      this.records.checkpoint.transcriptStores?.main === this.storeIdentity()
    if (this.records.restored?.pending.length) {
      const pending = this.records.restored.pending
      const reason = sameStore
        ? 'Kimi request restored in a new generation'
        : 'Native transcript store changed'
      await this.records.commit(
        ['store-requests-expired', this.storeIdentity()],
        pending.map((entry) =>
          record(
            this.records.scope,
            'local',
            [entry.recordId, this.storeIdentity(), 'expired'],
            'request.expired',
            {
              requestId: object(entry.payload).requestId,
              reason,
            },
            entry.root,
            entry.agentId,
          ),
        ),
        pending.map((entry) => ({
          runId: entry.root!.runId,
          turnId: entry.root!.turnId,
          ...(entry.root!.childId ? { childId: entry.root!.childId } : {}),
          runtimeGeneration: this.generation,
          deliveryId: '',
          type: 'request_cancelled' as const,
          itemId: digest([entry.recordId, 'expired']),
          requestId: boundedString(
            object(entry.payload).requestId,
            this.budget.limits.forgeIdBytes,
          ),
          reason,
        })),
        undefined,
        true,
      )
    }
    for (const owner of sameStore
      ? (this.records.restored?.owners ?? [])
      : []) {
      if (owner.sourceIdentity.domain !== 'live-engine') continue
      this.retainState(owner)
      if (owner.providerTurnId !== undefined) {
        const key = digest([owner.agentId, owner.providerTurnId]),
          before = this.restoredOwners.get(key)
        if (before && digest(before) !== digest(owner.root))
          throw new KimiError('kimi_state_owner_conflict')
        this.restoredOwners.set(key, owner.root)
      }
      if (owner.providerToolCallId !== undefined)
        this.toolOwners.set(
          digest([owner.agentId, owner.providerToolCallId]),
          owner.root,
        )
      if (owner.child) {
        const entries = this.children.get(owner.agentId) ?? []
        if (
          !entries.some(
            (entry) => entry.owner.executionId === owner.child!.executionId,
          )
        ) {
          this.retainState(owner.child, 'childOwnerBytes', false)
          entries.push({ owner: owner.child, finished: false, restored: true })
          entries.sort(
            (a, b) => a.owner.spawnCursor.seq - b.owner.spawnCursor.seq,
          )
          for (let index = 1; index < entries.length; index++)
            entries[index - 1].end = entries[index].owner.spawnCursor.seq - 1
          this.children.set(owner.agentId, entries)
        }
        if (owner.providerTurnId !== undefined)
          this.childTurns.set(
            digest([owner.agentId, owner.providerTurnId]),
            owner.child,
          )
      }
    }
    this.snapshot = await this.readSnapshot()
    const baseline = this.records.checkpoint.session ?? {
      seq: sequence(this.snapshot.as_of_seq),
      epoch: String(this.snapshot.epoch),
    }
    this.replay = new KimiReplay(
      baseline,
      this.budget,
      (frame) => this.records.ingest(() => this.lifecycle(frame)),
      this.host.budget,
      () => this.records.holdIngestion(),
    )
    await this.openLifecycle()
    await this.subscribeLife()
    for (const pending of sameStore
      ? (this.records.restored?.pending ?? [])
      : []) {
      const payload = object(pending.payload),
        raw = object(payload.raw),
        agent = pending.agentId ?? 'main'
      const turn = String(sequence(raw.turn_id)),
        root = this.owner(agent, turn)
      if (root && digest(root) === digest(pending.root))
        await this.interactions.observe(
          payload.kind as 'question' | 'approval',
          raw,
          root,
          turn,
          agent,
        )
    }
    await this.installTranscriptBaseline('main')
    await this.openTranscript()
    await this.subscribeTranscript()
    await this.flushTranscript()
    this.options.signal?.addEventListener(
      'abort',
      () => {
        void this.kill().catch(() => {})
      },
      { once: true },
    )
    if (this.retired) throw this.retired
    this.initialized = true
  }
  private socketFailure(error: Error) {
    if (this.retired || this.released || this.recovery) return
    if (!this.initialized) {
      void this.retire(error)
      return
    }
    void this.recover(true).catch(() => this.retire(error))
  }
  private async openLifecycle() {
    const id = this.lifeId
    await this.lease.server.openSocket(
      this.lease.lane,
      id,
      (value) => {
        if (id !== this.lifeId || this.retired || this.released) return
        try {
          const frame = sessionFrame(
            value,
            this.binding.providerSessionId,
            this.budget.limits,
          )
          if (!frame) return
          if (frame.type === 'resync_required') {
            if (frame.payload.reason === 'session_recreated' && !this.recovery)
              this.transcriptStoreRevision++
            void this.recover().catch((error) => this.retire(error))
            return
          }
          this.replay.push(frame)
          void this.replay.drain().catch((error) => this.retire(error))
        } catch (error) {
          void this.recover().catch(() => this.retire(error as Error))
        }
      },
      (error) => {
        if (id === this.lifeId) this.socketFailure(error)
      },
    )
  }
  private async openTranscript() {
    const id = this.transcriptId
    await this.lease.server.openSocket(
      this.lease.lane,
      id,
      (value) => {
        if (id !== this.transcriptId || this.retired || this.released) return
        try {
          const frame = sessionFrame(
            value,
            this.binding.providerSessionId,
            this.budget.limits,
          )
          if (!frame || frame.type !== 'transcript.ops') return
          const release = reserveAll([
            [this.budget, 'replayFrames'],
            [
              this.budget,
              'replayBytes',
              jsonBytes(
                frame,
                this.budget.limits,
                this.budget.limits.wsMessageBytes,
              ),
            ],
            [
              this.host.budget,
              'hostRetainedBytes',
              jsonBytes(
                frame,
                this.budget.limits,
                this.budget.limits.wsMessageBytes,
              ),
            ],
          ])
          const freeIngestion = this.records.holdIngestion()
          this.transcriptPending.push({
            frame,
            release: () => {
              release()
              freeIngestion()
            },
          })
          if (this.transcriptReady && !this.admitting)
            void this.flushTranscript().catch((error) => {
              if (
                error instanceof KimiError &&
                [
                  'kimi_transcript_recovery_incomplete',
                  'kimi_transcript_recovery_gap',
                  'kimi_append_target',
                  'kimi_append_offset',
                ].includes(error.code)
              )
                void this.recover().catch((failure) => this.retire(failure))
              else void this.retire(error)
            })
        } catch (error) {
          void this.retire(error as Error)
        }
      },
      (error) => {
        if (id === this.transcriptId) this.socketFailure(error)
      },
    )
  }
  private async subscribeTranscript() {
    this.transcriptReady = false
    const agents = Object.keys(this.records.checkpoint.transcripts)
    if (agents.length > this.budget.limits.childSubscriptions)
      throw new KimiError('kimi_child_subscription_limit')
    const ack = await this.lease.server.control(
      this.transcriptId,
      'subscribe_v2',
      {
        session_id: this.binding.providerSessionId,
        transcript: {
          '*': 'off',
          ...Object.fromEntries(agents.map((agent) => [agent, 'delta'])),
        },
        transcript_since: this.records.checkpoint.transcripts,
      },
    )
    subscriptionAck(ack, this.binding.providerSessionId, this.budget.limits)
    this.transcriptReady = true
  }
  private async subscribeLife() {
    this.replay.pause()
    const ack = await this.lease.server.control(this.lifeId, 'subscribe', {
      session_ids: [this.binding.providerSessionId],
      cursors: { [this.binding.providerSessionId]: this.replay.cursor },
    })
    await this.replay.acknowledge(
      subscriptionAck(ack, this.binding.providerSessionId, this.budget.limits),
    )
  }
  private async cut() {
    if (this.recovery) await this.recovery
    const snapshot = await this.readSnapshot(),
      seq = sequence(snapshot.as_of_seq)
    if (snapshot.epoch !== this.replay.cursor.epoch)
      throw new KimiError('kimi_epoch_changed')
    await this.subscribeLife()
    if (this.replay.cursor.seq < seq)
      throw new KimiError('kimi_lifecycle_cut_gap')
    this.snapshot = snapshot
    return seq
  }
  private async recover(reconnect = false): Promise<void> {
    if (this.recovery) return this.recovery
    if (this.retired || this.released)
      return Promise.reject(
        this.retired ?? new KimiError('kimi_session_closed'),
      )
    this.budget.add('recoveries')
    this.replay.pause()
    this.transcriptReady = false
    const budget = new KimiBudget(this.budget.limits),
      end =
        performance.now() +
        Math.min(budget.limits.recoveryMs, budget.limits.reconnectMs)
    const read = async (
      path: string,
      maximum = budget.limits.httpJsonBytes,
    ) => {
      budget.add('recoveryReads')
      const value = object(
        await this.lease.server.http(this.lease.lane, path, {
          maxBytes: Math.min(
            maximum,
            budget.limits.recoveryBytes - budget.count('recoveryBytes'),
          ),
          signal: this.controller.signal,
        }),
      )
      budget.add(
        'recoveryBytes',
        jsonBytes(value, budget.limits, budget.limits.httpJsonBytes),
      )
      if (this.retired || this.released || performance.now() >= end)
        throw new KimiError('kimi_recovery_expired')
      return value
    }
    const work = async () => {
      let last: unknown
      for (
        let attempt = 0;
        attempt < budget.limits.reconnectAttempts;
        attempt++
      ) {
        let releaseSnapshot = () => {}
        try {
          const owned = await readHistoryPage(
            this.lease,
            this.host,
            budget,
            `${this.basePath()}/snapshot`,
            this.controller.signal,
            end,
            read,
          )
          releaseSnapshot = owned.release
          const snapshot = owned.value
          await validateNativeSession(snapshot.session, this.binding)
          if (snapshot.epoch !== this.replay.cursor.epoch)
            throw new KimiError('kimi_completion_unknown')
          if (reconnect || attempt) {
            const oldLife = this.lifeId,
              oldTranscript = this.transcriptId
            this.lifeId = randomUUID()
            this.transcriptId = randomUUID()
            await Promise.all([
              this.lease.server.closeSocket(oldLife),
              this.lease.server.closeSocket(oldTranscript),
            ])
            await this.openLifecycle()
            await this.openTranscript()
          }
          for (const agent of Object.keys(
            this.records.checkpoint.transcripts,
          )) {
            await this.installTranscriptBaseline(agent, read, end)
          }
          await this.subscribeLife()
          if (this.replay.cursor.seq < sequence(snapshot.as_of_seq))
            throw new KimiError('kimi_recovery_gap')
          await this.subscribeTranscript()
          await this.flushTranscript()
          return
        } catch (error) {
          last = error
          if (performance.now() >= end) break
        } finally {
          releaseSnapshot()
        }
      }
      throw last ?? new KimiError('kimi_recovery_exhausted')
    }
    this.recovery = deadline(
      work(),
      Math.max(1, end - performance.now()),
      this.controller.signal,
      this.budget,
      this.host.budget,
    ).finally(() => {
      this.recovery = undefined
    })
    return this.recovery
  }
  private flushTranscript() {
    const work = this.transcriptFlush.then(() => this.drainTranscript())
    this.transcriptFlush = work.catch(() => {})
    return work
  }
  private async drainTranscript() {
    while (
      this.transcriptReady &&
      !this.admitting &&
      this.transcriptPending.length
    ) {
      this.transcriptPending.sort(
        (a, b) => sequence(a.frame.payload.seq) - sequence(b.frame.payload.seq),
      )
      const { frame, release } = this.transcriptPending.shift()!
      try {
        const agent = String(frame.payload.agent_id),
          current = this.records.checkpoint.transcripts[agent] ?? 0
        if (sequence(frame.payload.seq) > current + 1) {
          this.budget.add('recoveries')
          const end = performance.now() + this.budget.limits.recoveryMs
          const owned = await readHistoryPage(
            this.lease,
            this.host,
            this.budget,
            `${this.basePath()}/transcript/ops?agent_id=${encodeURIComponent(agent)}&since_seq=${current}`,
            this.controller.signal,
            end,
          )
          try {
            const response = owned.value
            if (
              response.agent_id !== agent ||
              response.complete !== true ||
              !Array.isArray(response.batches) ||
              response.batches.length >
                this.budget.limits.transcriptCatchupBatches
            )
              throw new KimiError('kimi_transcript_recovery_incomplete')
            for (const value of response.batches) {
              checkHistoryDeadline(end)
              await this.records.ingest(() =>
                this.transcript.apply({
                  ...frame,
                  payload: {
                    ...object(value),
                    type: 'transcript.ops',
                    agent_id: agent,
                  },
                }),
              )
            }
            if (
              (this.records.checkpoint.transcripts[agent] ?? 0) !==
              sequence(response.latest_seq)
            )
              throw new KimiError('kimi_transcript_recovery_gap')
          } finally {
            owned.release()
          }
        }
        await this.records.ingest(() => this.transcript.apply(frame))
      } finally {
        release()
      }
    }
  }
  private mutate<T>(work: () => Promise<T>): Promise<T> {
    let release: () => void
    try {
      release = this.budget.reserve('pendingControls')
    } catch (error) {
      return Promise.reject(error)
    }
    const task = this.mutation
      .then(() => {
        if (this.retired) throw this.retired
        return work()
      })
      .finally(release)
    this.mutation = task.then(
      () => {},
      () => {},
    )
    return task
  }
  prompt(
    input: PromptInput[] | string,
    options?: DispatchOptions,
    identity?: { runId: string; turnId: string },
  ) {
    return this.admit('prompt', input, options, identity)
  }
  queue(
    input: PromptInput[] | string,
    options?: DispatchOptions,
    identity?: { runId: string; turnId: string },
  ) {
    return this.admit('queue', input, options, identity)
  }
  steer(
    input: PromptInput[] | string,
    options?: DispatchOptions,
    identity?: { runId: string; turnId: string },
  ) {
    return this.admit('steer', input, options, identity)
  }
  private admit(
    kind: 'prompt' | 'queue' | 'steer',
    input: PromptInput[] | string,
    options?: DispatchOptions,
    identity?: { runId: string; turnId: string },
  ): KimiReceipt {
    if (this.persistenceFailure) throw this.persistenceFailure
    if (this.retired || this.released)
      throw this.retired ?? new KimiError('kimi_session_closed')
    if (
      this.operations.size >=
      this.budget.limits.promptTerminalEntries +
        this.budget.limits.promptReceipts
    )
      throw new KimiError('kimi_prompt_identity_limit')
    if (kind === 'prompt' && (this.active || this.admitting))
      throw new KimiError('kimi_root_busy')
    const captured = captureInput(input, this.budget),
      settings = resolveSettings(
        options,
        this.defaults,
        this.catalog,
        this.budget.limits,
      )
    validatePromptEnvelope(captured, settings, this.budget)
    const parent = this.active
    if (
      kind !== 'prompt' &&
      (!parent || digest(parent.settings) !== digest(settings))
    )
      throw new KimiError('kimi_queued_options_conflict')
    const root: KimiRoot = {
      runId: boundedString(
        identity?.runId ?? randomUUID(),
        this.budget.limits.forgeIdBytes,
      ),
      turnId: boundedString(
        identity?.turnId ?? randomUUID(),
        this.budget.limits.forgeIdBytes,
      ),
      operationId: randomUUID(),
    }
    const receiptId = randomUUID(),
      completion = createCompletionHandle(
        {
          completionId: receiptId,
          runId: root.runId,
          turnId: root.turnId,
        },
        { persistenceRejection: true },
      )
    const acceptance = controlled<KimiPromptAcceptance>(),
      delivery = controlled<KimiDelivery>(),
      release = reserveAll([
        [this.budget, 'promptReceipts'],
        [
          this.budget,
          'retainedBytes',
          jsonBytes(
            captured,
            this.budget.limits,
            this.budget.limits.retainedBytes,
          ),
        ],
        [
          this.host.budget,
          'hostRetainedBytes',
          jsonBytes(
            captured,
            this.budget.limits,
            this.budget.limits.retainedBytes,
          ),
        ],
      ])
    let releaseQueue: (() => void) | undefined
    try {
      if (kind !== 'prompt')
        releaseQueue = reserveAll([
          [this.budget, 'nativeQueuedPrompts'],
          [this.budget, 'queuedTextBytes', promptTextBytes(captured)],
        ])
    } catch (error) {
      release()
      throw error
    }
    const receipt: KimiReceipt = {
      receiptId,
      runId: root.runId,
      turnId: root.turnId,
      completion: completion.handle,
      nativeAcceptance: acceptance.promise,
      delivery: delivery.promise,
    }
    let releaseIdentity: (() => void) | undefined
    try {
      releaseIdentity = this.retainState(
        { root, receiptId, settings },
        'retainedBytes',
        false,
      )
      // One frozen projection, two attempt snapshots, private owner facts and serialization scratch.
      const releaseFailure = reserveAll([
        [this.budget, 'retainedBytes', 65536],
        [this.host.budget, 'hostRetainedBytes', 65536],
      ])
      this.retainedState.add(releaseFailure)
    } catch (error) {
      releaseIdentity?.()
      release()
      releaseQueue?.()
      throw error
    }
    const op: Operation = {
      receipt,
      identity: Object.freeze({
        sessionId: this.records.scope.sessionId,
        receiptId,
        completionId: receiptId,
        runId: root.runId,
        turnId: root.turnId,
      }),
      root,
      input: structuredClone(captured),
      settings,
      controller: new AbortController(),
      acceptance,
      delivery,
      completion,
      baseline: this.replay.cursor.seq,
      candidates: [],
      candidateReleases: [],
      settled: false,
      preparing: true,
      parent,
      release,
      releaseQueue,
      terminal: controlled<void>(),
    }
    this.operations.set(receiptId, op)
    if (kind === 'prompt') {
      this.admitting = op
      this.active = op
    }
    void this.mutate(() => this.dispatch(op, kind)).catch((error) =>
      this.failOperation(op, error),
    )
    return receipt
  }
  private async dispatch(op: Operation, kind: 'prompt' | 'queue' | 'steer') {
    const signal = op.controller.signal
    signal.throwIfAborted()
    await this.cut()
    op.baseline = this.replay.cursor.seq
    op.candidateReleases.splice(0).forEach((release) => release())
    op.candidates = []
    if (kind === 'prompt') {
      const queue = object(
        await this.lease.server.http(
          this.lease.lane,
          `${this.basePath()}/prompts`,
          { signal },
        ),
      )
      if (
        queue.active !== null ||
        !Array.isArray(queue.queued) ||
        queue.queued.length ||
        this.snapshot.in_flight_turn !== null ||
        (this.snapshot.pending_questions as unknown[]).length ||
        (this.snapshot.pending_approvals as unknown[]).length
      )
        throw new KimiError('kimi_turn_owner_unknown')
      const messages = object(
        await this.lease.server.http(
          this.lease.lane,
          `${this.basePath()}/messages?page_size=1`,
          { signal, maxBytes: this.budget.limits.httpJsonBytes },
        ),
      )
      if (
        !Array.isArray(messages.items) ||
        messages.items.length > 1 ||
        typeof messages.has_more !== 'boolean'
      )
        throw new KimiError('kimi_content_anchor')
      const before =
        messages.items[0] === undefined ? undefined : object(messages.items[0])
      op.beforeMessage = before
        ? {
            id: boundedString(before.id, this.budget.limits.nativeIdBytes),
            revision: digest(before),
          }
        : null
    }
    const prepared = await prepareInput(
      op.input,
      this.session.id,
      this.lease,
      this.host,
      this.budget,
      this.options.loadAttachment,
      signal,
      async (ids) => {
        await this.records.commit(
          [op.root.operationId, 'orphan_upload'],
          [
            record(
              this.records.scope,
              'local',
              [op.root.operationId, 'orphan_upload'],
              'upload.orphan',
              { ids },
              op.root,
            ),
          ],
        )
      },
    )
    try {
      signal.throwIfAborted()
      validateExactPromptEnvelope(prepared.content, op.settings, this.budget)
      if (this.options.beforeDispatch) {
        if (this.hookWorking) throw new KimiError('kimi_hook_busy')
        const release = this.host.budget.reserve('sinkCalls')
        this.hookWorking = true
        const physical = this.host.track(
          Promise.resolve()
            .then(() =>
              this.options.beforeDispatch!({
                sessionId: this.session.id,
                runtimeGeneration: this.generation,
                ...op.root,
                cwd: this.binding.cwd,
                kind: kind === 'prompt' ? 'prompt' : 'steer',
                signal,
              }),
            )
            .finally(() => {
              release()
              this.hookWorking = false
            }),
        )
        await deadline(
          physical,
          this.budget.limits.sinkMs,
          signal,
          this.budget,
          this.host.budget,
        )
      }
      signal.throwIfAborted()
    } catch (error) {
      await prepared.abandon()
      throw error
    }
    if (kind !== 'prompt') {
      const messages = object(
        await this.lease.server.http(
          this.lease.lane,
          `${this.basePath()}/messages?page_size=1`,
          { signal, maxBytes: this.budget.limits.httpJsonBytes },
        ),
      )
      if (
        !Array.isArray(messages.items) ||
        messages.items.length > 1 ||
        typeof messages.has_more !== 'boolean'
      )
        throw new KimiError('kimi_content_anchor')
      const before =
        messages.items[0] === undefined ? undefined : object(messages.items[0])
      op.beforeMessage = before
        ? {
            id: boundedString(before.id, this.budget.limits.nativeIdBytes),
            revision: digest(before),
          }
        : null
      this.admitting = op
    }
    op.preparing = false
    op.postAttempted = true
    const response = object(
      await this.lease.server.http(
        this.lease.lane,
        `${this.basePath()}/prompts`,
        {
          method: 'POST',
          body: { content: prepared.content, ...op.settings },
          signal,
        },
      ),
    )
    const promptId = boundedString(
        response.prompt_id,
        this.budget.limits.nativeIdBytes,
      ),
      userMessageId = boundedString(
        response.user_message_id,
        this.budget.limits.nativeIdBytes,
      )
    if (!['running', 'queued', 'blocked'].includes(String(response.status)))
      throw new KimiError(
        'kimi_prompt_acceptance',
        'Kimi prompt acceptance is unknown',
        true,
      )
    op.accepted = {
      status: 'accepted',
      promptId,
      userMessageId,
      nativeStatus: response.status as 'running' | 'queued' | 'blocked',
    }
    await this.records.commit(
      [op.root.operationId, 'accepted'],
      [
        record(
          this.records.scope,
          'local',
          [op.root.operationId, 'accepted'],
          'prompt.accepted',
          op.accepted,
          op.root,
        ),
      ],
      [
        {
          ...this.base(op),
          type: 'prompt_accepted',
          receiptId: op.receipt.receiptId,
        },
      ],
    )
    op.acceptance.resolve(op.accepted)
    if (op.accepted.nativeStatus === 'queued') {
      if (kind === 'prompt') throw new KimiError('kimi_turn_owner_unknown')
      this.admitting = undefined
      await this.cut()
      for (const frame of op.candidates) await this.processOwned(frame)
      op.candidates = []
      op.candidateReleases.splice(0).forEach((release) => release())
      if (kind === 'steer') await this.steerOwned([op])
      return
    }
    await this.cut()
    if (op.accepted.nativeStatus === 'blocked') {
      this.admitting = undefined
      for (const frame of op.candidates)
        if (frame.payload.promptId === promptId) await this.processOwned(frame)
      return
    }
    const starts = op.candidates.filter(
      (frame) =>
        frame.type === 'turn.started' &&
        (frame.payload.agentId ?? 'main') === 'main',
    )
    if (
      starts.length !== 1 ||
      object(starts[0].payload.origin).kind !== 'user' ||
      op.candidates.some(
        (frame) =>
          (frame.type === 'prompt.completed' ||
            frame.type === 'prompt.aborted') &&
          frame.payload.promptId !== promptId &&
          frame.payload.promptId !== op.parent?.accepted?.promptId,
      ) ||
      op.candidates.some(
        (frame) =>
          frame.type === 'turn.ended' &&
          (frame.payload.agentId ?? 'main') === 'main' &&
          frame.payload.turnId !== starts[0]?.payload.turnId &&
          String(frame.payload.turnId) !== op.parent?.providerTurn,
      )
    )
      throw new KimiError('kimi_turn_owner_unknown')
    op.providerTurn = String(sequence(starts[0].payload.turnId))
    op.releaseQueue?.()
    this.retainState({ root: op.root, providerTurn: op.providerTurn })
    this.budget.add('retainedTurns')
    this.roots.set(op.providerTurn, op)
    this.active = op
    this.admitting = undefined
    await this.records.commit(
      [op.root.operationId, 'owner'],
      [
        record(
          this.records.scope,
          'live-engine',
          [this.replay.cursor.epoch, 'main', op.providerTurn],
          'turn.owner',
          { providerTurnId: op.providerTurn, promptId, userMessageId },
          op.root,
        ),
      ],
      [
        { ...this.base(op), type: 'run_started' },
        { ...this.base(op), type: 'turn_started' },
      ],
    )
    op.delivery.resolve({
      status: 'delivered',
      mode: 'root',
      promptId,
      activePromptId: promptId,
      providerTurnId: op.providerTurn,
    })
    for (const frame of op.candidates) await this.processOwned(frame)
    op.candidates = []
    op.candidateReleases.splice(0).forEach((release) => release())
    await this.flushTranscript()
    await this.maybeFinish(op)
  }
  private async lifecycle(frame: KimiFrame) {
    await this.records.commit(
      ['lifecycle', frame.epoch, frame.seq],
      [
        record(
          this.records.scope,
          'live-engine',
          [frame.epoch, frame.seq],
          frame.type,
          frame.payload,
          undefined,
          boundedString(
            frame.payload.agentId ?? 'main',
            this.budget.limits.nativeIdBytes,
          ),
        ),
      ],
      [],
      {
        ...this.records.checkpoint,
        session: { seq: frame.seq, epoch: frame.epoch },
      },
    )
    if (this.admitting) {
      this.admitting.candidateReleases.push(
        reserveAll([
          [this.budget, 'orphanFrames'],
          [
            this.host.budget,
            'hostRetainedBytes',
            jsonBytes(
              frame,
              this.budget.limits,
              this.budget.limits.wsMessageBytes,
            ),
          ],
          [
            this.budget,
            'orphanBytes',
            jsonBytes(
              frame,
              this.budget.limits,
              this.budget.limits.wsMessageBytes,
            ),
          ],
        ]),
      )
      this.admitting.candidates.push(frame)
      return
    }
    await this.processOwned(frame)
  }
  private owner(agent: string, turn: string): KimiRoot | undefined {
    if (agent === 'main')
      return (
        this.roots.get(turn)?.root ??
        this.restoredOwners.get(digest([agent, turn]))
      )
    const child = this.childTurns.get(digest([agent, turn]))
    return child
      ? {
          runId: child.runId,
          turnId: child.turnId,
          operationId: child.operationId,
          childId: child.childId,
        }
      : this.restoredOwners.get(digest([agent, turn]))
  }
  private async processOwned(frame: KimiFrame) {
    const payload = frame.payload,
      agent = boundedString(
        payload.agentId ?? 'main',
        this.budget.limits.nativeIdBytes,
      )
    if (frame.type === 'turn.started') {
      const turn = String(sequence(payload.turnId))
      if (agent === 'main' && !this.owner(agent, turn))
        throw new KimiError('kimi_turn_owner_unknown')
      if (agent !== 'main') {
        const entries = this.children.get(agent),
          entry = entries?.[entries.length - 1]
        if (
          entry &&
          !entry.finished &&
          entry.owner.spawnCursor.epoch === frame.epoch &&
          entry.owner.spawnCursor.seq <= frame.seq
        ) {
          this.retainState(entry.owner)
          this.childTurns.set(digest([agent, turn]), entry.owner)
        }
      }
    }
    if (frame.type === 'turn.step.started') {
      const turn = String(sequence(payload.turnId)),
        step = `t${turn}.${sequence(payload.step)}`
      const root = this.owner(agent, turn)
      if (root) this.transcript.step(agent, `t${turn}`, step, root)
    }
    if (frame.type === 'assistant.delta' || frame.type === 'thinking.delta') {
      const root = this.owner(agent, String(sequence(payload.turnId)))
      if (root) await this.transcript.engineDelta(frame, root)
    }
    if (frame.type === 'turn.step.completed' && payload.usage !== undefined) {
      const root = this.owner(agent, String(sequence(payload.turnId)))
      if (root) {
        const usage = object(payload.usage),
          inputOther = sequence(usage.inputOther),
          outputTokens = sequence(usage.output),
          cachedInputTokens = sequence(usage.inputCacheRead),
          cacheWriteInputTokens = sequence(usage.inputCacheCreation)
        const inputTokens = sequence(
            inputOther + cachedInputTokens + cacheWriteInputTokens,
          ),
          totalTokens = sequence(inputTokens + outputTokens)
        const event: Extract<HarnessEvent, { type: 'usage' }> = {
          runId: root.runId,
          turnId: root.turnId,
          ...(root.childId ? { childId: root.childId } : {}),
          runtimeGeneration: this.generation,
          deliveryId: '',
          itemId: digest(['usage', agent, payload.turnId, payload.step]),
          type: 'usage',
          inputTokens,
          outputTokens,
          totalTokens,
          cachedInputTokens,
          cacheWriteInputTokens,
        }
        await this.records.commit(
          ['usage', frame.epoch, frame.seq],
          [],
          [event],
        )
        const release = this.retainState(event, 'retainedBytes', false)
        this.latestUsage.get(agent)?.release()
        this.latestUsage.set(agent, { event, release })
      }
    }
    if (frame.type === 'agent.status.updated') {
      const latest = this.latestUsage.get(agent)
      if (
        latest &&
        (payload.usage !== undefined || payload.maxContextTokens !== undefined)
      ) {
        const total =
          payload.usage === undefined ? undefined : object(payload.usage).total
        let cumulative: Extract<HarnessEvent, { type: 'usage' }>['cumulative']
        if (total !== undefined) {
          const usage = object(total),
            cachedInputTokens = sequence(usage.inputCacheRead),
            cacheWriteInputTokens = sequence(usage.inputCacheCreation),
            outputTokens = sequence(usage.output)
          const inputTokens = sequence(
            sequence(usage.inputOther) +
              cachedInputTokens +
              cacheWriteInputTokens,
          )
          cumulative = {
            inputTokens,
            outputTokens,
            totalTokens: sequence(inputTokens + outputTokens),
            cachedInputTokens,
            cacheWriteInputTokens,
          }
        }
        const event = {
          ...latest.event,
          ...(cumulative ? { cumulative } : {}),
          ...(payload.maxContextTokens !== undefined
            ? {
                modelContextWindow:
                  payload.maxContextTokens === null
                    ? null
                    : sequence(payload.maxContextTokens),
              }
            : {}),
        }
        const hash = digest(event)
        if (latest.hash !== hash) {
          await this.records.commit(
            ['usage.status', frame.epoch, frame.seq],
            [],
            [event],
          )
          latest.hash = hash
        }
      }
    }
    if (frame.type === 'turn.step.retrying') {
      const root = this.owner(agent, String(sequence(payload.turnId)))
      if (root)
        await this.records.commit(
          ['retry', frame.epoch, frame.seq],
          [],
          [
            this.records.diagnostic(
              root,
              digest(['retry', frame.epoch, frame.seq]),
              payload.message ?? 'Kimi retried a step',
              'warning',
              'kimi_step_retry',
            ),
          ],
        )
    }
    if (frame.type === 'tool.call.started') {
      const root = this.owner(agent, String(payload.turnId))
      if (root) {
        const key = digest([
          agent,
          boundedString(payload.toolCallId, this.budget.limits.nativeIdBytes),
        ])
        const existing = this.toolOwners.get(key)
        if (existing && digest(existing) !== digest(root))
          throw new KimiError('kimi_tool_owner_conflict')
        if (!existing) {
          this.retainState({ key, root })
        }
        this.toolOwners.set(
          digest([
            agent,
            boundedString(payload.toolCallId, this.budget.limits.nativeIdBytes),
          ]),
          root,
        )
      }
    }
    if (frame.type.startsWith('subagent.')) await this.child(frame)
    if (
      frame.type === 'agent.disposed' &&
      agent !== 'main' &&
      this.children.has(agent)
    )
      await this.child({ ...frame, payload: { ...payload, subagentId: agent } })
    if (
      frame.type === 'event.question.requested' ||
      frame.type === 'event.approval.requested'
    ) {
      const root = payload.tool_call_id
        ? this.toolOwners.get(digest([agent, payload.tool_call_id]))
        : this.owner(agent, String(payload.turn_id))
      if (root)
        await this.interactions.observe(
          frame.type === 'event.question.requested' ? 'question' : 'approval',
          payload,
          root,
          String(payload.turn_id),
          agent,
        )
    }
    if (
      [
        'event.question.answered',
        'event.question.dismissed',
        'event.approval.resolved',
      ].includes(frame.type)
    )
      await this.interactions.expire(
        'Native request resolved',
        undefined,
        String(payload.question_id ?? payload.approval_id),
      )
    if (frame.type === 'context.spliced' && payload.deleteCount !== 0) {
      await this.transcript.unavailable(payload)
      throw new KimiError('kimi_projection_rebuild_required')
    }
    if (frame.type === 'prompt.steered') {
      if (!Array.isArray(payload.promptIds))
        throw new KimiError('kimi_steer_edge')
      for (const op of this.operations.values())
        if (op.accepted && payload.promptIds.includes(op.accepted.promptId)) {
          if (
            !op.parent?.accepted ||
            payload.activePromptId !== op.parent.accepted.promptId ||
            !op.parent.providerTurn
          )
            throw new KimiError('kimi_steer_owner_unknown')
          if (!op.steerEdge) this.retainState(frame, 'retainedBytes', false)
          op.steerEdge = frame
          await this.confirmSteer(op)
        }
    }
    for (const op of this.operations.values()) {
      if (
        (frame.type === 'prompt.completed' ||
          frame.type === 'prompt.aborted') &&
        op.accepted?.promptId === payload.promptId
      ) {
        if (
          op.promptTerminal &&
          digest(op.promptTerminal.payload) !== digest(payload)
        )
          throw new KimiError('kimi_terminal_conflict')
        if (!op.promptTerminal) this.retainState(frame, 'retainedBytes', false)
        op.promptTerminal = frame
        op.terminal.resolve()
      }
      if (
        frame.type === 'turn.ended' &&
        agent === 'main' &&
        op.providerTurn === String(payload.turnId)
      ) {
        if (
          op.turnTerminal &&
          digest(op.turnTerminal.payload) !== digest(payload)
        )
          throw new KimiError('kimi_terminal_conflict')
        if (!op.turnTerminal) this.retainState(frame, 'retainedBytes', false)
        op.turnTerminal = frame
      }
      if (op.settled) continue
      void this.maybeFinish(op).catch((error) => this.retire(error))
    }
  }
  private async child(frame: KimiFrame) {
    const p = frame.payload,
      agent = boundedString(p.subagentId, this.budget.limits.nativeIdBytes)
    const entries = this.children.get(agent) ?? []
    if (frame.type === 'subagent.spawned') {
      const parentAgent = boundedString(
        p.parentAgentId ?? p.callerAgentId ?? 'main',
        this.budget.limits.nativeIdBytes,
      )
      const tool = boundedString(
          p.parentToolCallId,
          this.budget.limits.nativeIdBytes,
        ),
        root = this.toolOwners.get(digest([parentAgent, tool]))
      if (!root) throw new KimiError('kimi_child_owner_unknown')
      let depth = 1,
        parentChildId = root.childId
      const ancestry = new Set<string>()
      while (parentChildId) {
        if (ancestry.has(parentChildId))
          throw new KimiError('kimi_child_ancestry_cycle')
        ancestry.add(parentChildId)
        const parent = [...this.children.values()]
          .flat()
          .find((entry) => entry.owner.childId === parentChildId)
        if (!parent) throw new KimiError('kimi_child_owner_unknown')
        parentChildId = parent.owner.parentChildId
        if (++depth > this.budget.limits.childDepth)
          throw new KimiError('kimi_child_depth_limit')
      }
      if (depth > this.budget.limits.childDepth)
        throw new KimiError('kimi_child_depth_limit')
      const previous = entries[entries.length - 1]
      if (previous && !previous.finished && !previous.restored)
        throw new KimiError('kimi_child_execution_overlap')
      if (previous && !previous.finished && previous.restored) {
        const owner = previous.owner,
          outcome = {
            status: 'failed' as const,
            code: 'kimi_child_completion_unknown',
            message: 'Kimi child completion is unknown',
          }
        await this.interactions.expire('Native child replaced', owner)
        await this.records.commit(
          ['child', owner.executionId, 'replacement'],
          [
            record(
              this.records.scope,
              'local',
              [owner.executionId, 'replacement'],
              'child.terminal',
              {
                outcome,
                contentCoverage: 'partial',
                replacementCursor: { seq: frame.seq, epoch: frame.epoch },
              },
              owner,
              agent,
            ),
          ],
          [
            {
              runId: owner.runId,
              turnId: owner.turnId,
              childId: owner.childId,
              itemId: owner.childId,
              runtimeGeneration: this.generation,
              deliveryId: '',
              type: 'child_finished',
              outcome,
            },
          ],
        )
        previous.finished = true
        this.budget.add('childOwnerTombstones')
      }
      if (previous) previous.end = frame.seq - 1
      this.budget.add('children')
      const executionId = digest([
          this.binding,
          frame.epoch,
          frame.seq,
          parentAgent,
          tool,
          agent,
        ]),
        childId = `child-${executionId}`
      const owner: KimiChildOwner = {
        providerAgentId: agent,
        executionId,
        spawnCursor: { seq: frame.seq, epoch: frame.epoch },
        providerParentAgentId: parentAgent,
        providerParentToolCallId: tool,
        childId,
        parentChildId: root.childId,
        parentToolCallId: tool,
        runId: root.runId,
        turnId: root.turnId,
        operationId: root.operationId,
        providerRootTurnId:
          [...this.roots.values()].find(
            (entry) => entry.root.operationId === root.operationId,
          )?.providerTurn ??
          [...this.children.values()]
            .flat()
            .find((entry) => entry.owner.childId === root.childId)?.owner
            .providerRootTurnId ??
          '',
      }
      this.retainState(owner, 'childOwnerBytes')
      entries.push({ owner, finished: false })
      this.children.set(agent, entries)
      this.latestUsage.get(agent)?.release()
      this.latestUsage.delete(agent)
      await this.records.commit(
        ['child', executionId],
        [
          record(
            this.records.scope,
            'live-engine',
            [executionId],
            'child.owner',
            owner,
            { ...root, childId },
            agent,
          ),
        ],
        [
          {
            ...root,
            runtimeGeneration: this.generation,
            deliveryId: '',
            itemId: childId,
            childId,
            type: 'child_started',
            parentToolCallId: tool,
            providerChildId: agent,
            parentChildId: root.childId,
            description: typeof p.description === 'string' ? p.description : '',
          },
        ],
      )
      if (!Object.hasOwn(this.records.checkpoint.transcripts, agent)) {
        if (
          Object.keys(this.records.checkpoint.transcripts).length >=
          this.budget.limits.childSubscriptions
        )
          throw new KimiError('kimi_child_subscription_limit')
        this.transcriptReady = false
        await this.installTranscriptBaseline(agent)
        await this.subscribeTranscript()
        void this.flushTranscript().catch((error) => this.retire(error))
      }
      return
    }
    const entry = entries.find(
      (entry) =>
        entry.owner.spawnCursor.epoch === frame.epoch &&
        frame.seq >= entry.owner.spawnCursor.seq &&
        (entry.end === undefined || frame.seq <= entry.end),
    )
    if (!entry) throw new KimiError('kimi_child_execution_unknown')
    if (
      (frame.type === 'subagent.completed' ||
        frame.type === 'subagent.failed' ||
        frame.type === 'agent.disposed') &&
      !entry.finished
    ) {
      entry.finished = true
      this.budget.add('childOwnerTombstones')
      const owner = entry.owner
      await this.interactions.expire('Native child ended', owner)
      this.transcript.finishOwner(owner)
      await this.records.commit(
        ['child', owner.executionId, 'terminal'],
        [
          record(
            this.records.scope,
            'live-engine',
            [owner.executionId, 'terminal'],
            'child.terminal',
            { event: p, contentCoverage: 'partial' },
            owner,
            agent,
          ),
        ],
        [
          {
            runId: owner.runId,
            turnId: owner.turnId,
            runtimeGeneration: this.generation,
            deliveryId: '',
            itemId: owner.childId,
            childId: owner.childId,
            type: 'child_finished',
            outcome:
              frame.type === 'subagent.completed'
                ? { status: 'completed' }
                : {
                    status: 'failed',
                    code:
                      frame.type === 'agent.disposed'
                        ? 'kimi_child_disposed'
                        : 'kimi_child_failed',
                    message:
                      frame.type === 'agent.disposed'
                        ? 'Kimi child ended without a terminal result'
                        : 'Kimi child failed',
                  },
          },
        ],
      )
    }
  }
  private maybeFinish(op: Operation): Promise<void> {
    if (op.finishing) return op.finishing
    if (op.settled || !op.promptTerminal) return Promise.resolve()
    if (
      op.promptTerminal.type !== 'prompt.aborted' &&
      !['failed', 'blocked'].includes(
        String(op.promptTerminal.payload.reason),
      ) &&
      !op.turnTerminal
    )
      return Promise.resolve()
    op.finishing = this.finishReady(op)
    return op.finishing
  }
  private async finishReady(op: Operation) {
    if (op.settled || !op.promptTerminal) return
    const terminal = op.promptTerminal
    if (terminal.type === 'prompt.aborted') {
      await this.finish(op, {
        status: 'interrupted',
        reason: 'Kimi prompt aborted',
      })
      return
    }
    if (
      terminal.payload.reason === 'failed' ||
      terminal.payload.reason === 'blocked'
    ) {
      await this.finish(op, {
        status: 'failed',
        code: `kimi_prompt_${terminal.payload.reason}`,
        message: 'Kimi prompt did not complete',
      })
      return
    }
    if (!op.turnTerminal || !op.providerTurn) return
    if (op.turnTerminal.payload.reason !== 'completed') {
      await this.finish(op, {
        status: 'failed',
        code: 'kimi_turn_failed',
        message: 'Kimi turn did not complete',
      })
      return
    }
    // Both native terminals precede this main-message call. Native messageHistory flushes its wire journal here.
    try {
      await this.reconcileFinal(op)
    } catch (error) {
      if (
        !(error instanceof KimiError) ||
        ![
          'kimi_content_owner_unknown',
          'kimi_content_unavailable',
          'kimi_content_anchor_missing',
          'kimi_content_interval_changed',
          'kimi_media_unavailable',
          'kimi_content_page',
          'kimi_history_deadline',
          'kimi_deadline',
          'kimi_http_buffer_limit',
          'kimi_resource_limit',
        ].includes(error.code)
      )
        throw error
      await this.records.commit(
        [op.root.operationId, 'final-content-unavailable'],
        [
          record(
            this.records.scope,
            'local',
            [op.root.operationId, 'final-content-unavailable'],
            'content.unavailable',
            {
              coverage: 'unavailable',
              reason: error.code,
              nativePromptTerminal: op.promptTerminal.payload,
              nativeTurnTerminal: op.turnTerminal.payload,
            },
            op.root,
          ),
        ],
        [],
        undefined,
        true,
      )
      await this.finish(op, {
        status: 'failed',
        code: 'kimi_final_content_unavailable',
        message: 'Kimi final content ownership is unavailable',
      })
      return
    }
    await this.finish(op, { status: 'completed' })
  }
  private async reconcileFinal(op: Operation) {
    if (this.recovery) await this.recovery
    if (!op.accepted) throw new KimiError('kimi_content_owner_unknown')
    const messages: unknown[] = [],
      seen = new Set<string>(),
      snapshotId = digest([
        this.generation,
        op.root.operationId,
        op.accepted.userMessageId,
      ])
    let before: string | undefined,
      found = false,
      provedBefore = false
    const messageBudget = new KimiBudget(this.budget.limits)
    const end = performance.now() + this.budget.limits.messageMs
    const releases: (() => void)[] = []
    try {
      for (let page = 0; page < this.budget.limits.messagePages; page++) {
        if (performance.now() >= end)
          throw new KimiError('kimi_content_unavailable')
        const owned = await readHistoryPage(
            this.lease,
            this.host,
            this.budget,
            `${this.basePath()}/messages?page_size=${this.budget.limits.pageMessages}${before ? `&before_id=${encodeURIComponent(before)}` : ''}`,
            this.controller.signal,
            end,
          ),
          response = owned.value
        releases.push(owned.release)
        messageBudget.add(
          'messageBytes',
          jsonBytes(
            response,
            this.budget.limits,
            this.budget.limits.httpJsonBytes,
          ),
        )
        if (
          !Array.isArray(response.items) ||
          response.items.length > this.budget.limits.pageMessages ||
          typeof response.has_more !== 'boolean'
        )
          throw new KimiError('kimi_content_page')
        for (const value of response.items) {
          const message = object(value),
            id = boundedString(message.id, this.budget.limits.nativeIdBytes)
          if (seen.has(id)) throw new KimiError('kimi_content_progress')
          if (seen.size >= this.budget.limits.cursorEntries)
            throw new KimiError('kimi_cursor_limit')
          releases.push(
            reserveAll([
              [this.budget, 'cursorStateBytes', Buffer.byteLength(id)],
              [this.host.budget, 'hostRetainedBytes', Buffer.byteLength(id)],
            ]),
          )
          seen.add(id)
          if (id === op.accepted.userMessageId) {
            if (
              found ||
              message.role !== 'user' ||
              message.session_id !== this.binding.providerSessionId
            )
              throw new KimiError('kimi_content_owner_unknown')
            found = true
            continue
          }
          if (found) {
            if (
              !op.beforeMessage ||
              id !== op.beforeMessage.id ||
              digest(message) !== op.beforeMessage.revision
            )
              throw new KimiError('kimi_content_interval_changed')
            provedBefore = true
            break
          }
          if (
            message.role === 'user' ||
            (message.metadata &&
              object(message.metadata).origin &&
              object(object(message.metadata).origin).kind !== 'user')
          )
            throw new KimiError('kimi_content_owner_unknown')
          messages.push(value)
        }
        if (provedBefore) break
        if (found && !response.has_more && op.beforeMessage === null) {
          provedBefore = true
          break
        }
        if (!response.has_more || !response.items.length)
          throw new KimiError('kimi_content_anchor_missing')
        before = String(object(response.items[response.items.length - 1]).id)
      }
      if (!found || !provedBefore)
        throw new KimiError('kimi_content_unavailable')
      checkHistoryDeadline(end)
      await deadline(
        this.cut(),
        Math.max(1, end - performance.now()),
        this.controller.signal,
        this.budget,
        this.host.budget,
      )
      checkHistoryDeadline(end)
      if (this.retired || this.released)
        throw this.retired ?? new KimiError('kimi_session_closed')
      const finalRecords: KimiNativeRecord[] = [],
        finalEvents: HarnessEvent[] = []
      for (const message of messages.reverse()) {
        checkHistoryDeadline(end)
        const preserved = await preserveMessage(
          message,
          snapshotId,
          this.records,
          this.lease,
          this.host,
          this.options.storeAttachment,
          op.root,
          undefined,
          end,
        )
        releases.push(preserved.release)
        if (preserved.unavailable) throw new KimiError('kimi_media_unavailable')
        if (
          finalRecords.length + preserved.records.length + 1 >
          this.budget.limits.sinkBatchRecords
        )
          throw new KimiError('kimi_final_record_limit')
        finalRecords.push(...preserved.records)
        finalEvents.push(...preserved.events)
        this.records.preflight(finalRecords, finalEvents)
      }
      await this.records.ingest(() =>
        this.transcript.replaceRoot(
          op.root,
          op.providerTurn!,
          finalRecords,
          finalEvents,
          end,
        ),
      )
    } finally {
      releases.forEach((release) => release())
    }
  }
  private finish(op: Operation, outcome: TerminalOutcome): Promise<void> {
    if (op.settled) return Promise.resolve()
    if (op.finalizing) return op.finalizing
    const task = this.host.track(
      Promise.resolve().then(() => this.finalize(op, outcome)),
    )
    op.finalizing = task
    void task.catch(() => {})
    return task
  }
  private async finalize(
    op: Operation,
    outcome: TerminalOutcome,
    originalError?: Error,
  ) {
    let terminal = this.records.beginAttempt([op.root], true, true)
    op.terminalAttempt = terminal
    let failure: unknown
    const terminalEvents = (
      result: TerminalOutcome,
      diagnostic: boolean,
    ): HarnessEvent[] => {
      const events: HarnessEvent[] = [
        { ...this.base(op), type: 'turn_completed', outcome: result },
      ]
      if (diagnostic && !this.failureDiagnostic && result.status === 'failed') {
        this.failureDiagnostic = true
        events.unshift({
          ...this.base(op),
          type: 'diagnostic',
          itemId: `failure-${op.root.operationId}`,
          code: result.code,
          message: result.message,
          severity: 'error',
        })
      }
      return events
    }
    try {
      this.budget.add('promptTerminalEntries')
      await this.interactions.expire('Native owner ended', op.root)
      await this.records.commit(
        [op.root.operationId, originalError ? 'failure' : 'terminal'],
        [
          record(
            this.records.scope,
            'local',
            [op.root.operationId, originalError ? 'failure' : 'terminal'],
            originalError ? 'turn.failure' : 'turn.terminal',
            {
              outcome,
              nativePromptTerminal: op.promptTerminal?.payload,
              nativeTurnTerminal: op.turnTerminal?.payload,
            },
            op.root,
          ),
        ],
        terminalEvents(outcome, !!originalError),
        undefined,
        outcome.status !== 'completed',
        Infinity,
        terminal,
      )
      await this.records.drain(op.root)
      if (
        this.records.requiredEvidence(op.root, terminal).state !== 'committed'
      )
        throw new KimiError('kimi_completion_persistence')
    } catch (error) {
      failure = error
      terminal.fail(error)
      const cause = terminal.cause ?? this.records.failedAttempt ?? terminal
      if (
        !originalError &&
        terminal.latest.phase !== 'acknowledged' &&
        this.records.terminalWritable
      ) {
        const failedOutcome = {
          status: 'failed' as const,
          code: 'kimi_completion_failed',
          message: 'Kimi completion persistence failed',
        }
        const replacement = this.records.beginAttempt([op.root], true, true)
        op.terminalAttempt = terminal = replacement
        try {
          await this.records.commit(
            [op.root.operationId, 'failure'],
            [
              record(
                this.records.scope,
                'local',
                [op.root.operationId, 'failure'],
                'turn.failure',
                { outcome: failedOutcome },
                op.root,
              ),
            ],
            terminalEvents(failedOutcome, true),
            undefined,
            true,
            Infinity,
            replacement,
          )
        } catch (replacementError) {
          replacement.fail(replacementError)
        }
      }
      const drained = this.host.track(
        this.records.drain(op.root).catch(() => {}),
      )
      if (
        this.records.requiredEvidence(op.root, terminal, true).state !==
        'unproved'
      )
        await drained
      const failureAttempt = cause.cause ?? cause
      const persistence = new KimiCompletionPersistenceError(
        {
          ...op.identity,
        },
        op.root,
        failureAttempt,
        terminal,
        (historical) =>
          this.records.requiredEvidence(op.root, terminal, historical),
      )
      op.persistenceFailure = persistence
      this.persistenceFailure ??= persistence
      op.completion.reject(persistence)
    }
    if (!failure) {
      op.completion.settle({
        ...outcome,
        runId: op.root.runId,
        turnId: op.root.turnId,
      })
      op.outcome = outcome
    }
    op.settled = true
    this.transcript.finishOwner(op.root)
    op.candidateReleases.splice(0).forEach((release) => release())
    op.candidates = []
    if (failure && (op.accepted || op.postAttempted)) {
      void this.lease.server.done
        .then(() => {
          if (this.lease.server.cleanupProved) {
            op.release()
            op.releaseQueue?.()
            op.input = []
          }
        })
        .catch(() => {})
    } else {
      op.release()
      op.releaseQueue?.()
      op.input = []
    }
    if (!op.providerTurn && !op.steerEdge)
      op.delivery.resolve({
        status: 'not_delivered',
        code: 'kimi_prompt_not_started',
        message: 'Kimi prompt did not start',
      })
    op.terminal.resolve()
    if (this.active === op) this.active = undefined
    if (this.admitting === op) this.admitting = undefined
    for (const child of this.operations.values())
      if (
        child.parent === op &&
        child.steerAck &&
        child.steerEdge &&
        !child.settled
      ) {
        if (failure) this.failOperation(child, failure)
        else await this.finish(child, outcome)
      }
    if (failure) throw op.persistenceFailure
  }
  private failOperation(op: Operation, error: unknown) {
    if (op.settled || op.finalizing) return
    let reason =
      error instanceof KimiError
        ? error
        : new KimiError('kimi_operation_failed')
    if (
      op.postAttempted &&
      !op.accepted &&
      !reason.uncertain &&
      !reason.code.startsWith('kimi_native_')
    )
      reason = new KimiError(
        'kimi_delivery_unknown',
        'Kimi prompt delivery is unknown',
        true,
      )
    op.acceptance.resolve({
      status: reason.uncertain ? 'unknown' : 'rejected',
      code: reason.code,
      message: reason.message,
    })
    op.delivery.resolve({
      status: reason.uncertain || op.accepted ? 'unknown' : 'not_delivered',
      code: reason.code,
      message: reason.message,
    })
    const original = error instanceof Error ? error : reason
    const task = this.host.track(
      Promise.resolve().then(() =>
        this.finalize(
          op,
          {
            status: 'failed',
            code: reason.code,
            message: reason.message,
          },
          original,
        ),
      ),
    )
    op.finalizing = task
    void task.catch(() => {})
    if (op.accepted || reason.uncertain)
      void this.retire(original).catch(() => {})
  }
  private async retire(error: Error) {
    if (this.retired) return
    this.retired = error
    this.records.retire()
    this.replay?.dispose()
    this.transcriptPending.splice(0).forEach((entry) => entry.release())
    for (const op of this.operations.values()) this.failOperation(op, error)
    await this.interactions.expire('Kimi generation ended').catch(() => {})
    for (const entries of this.children.values())
      for (const entry of entries)
        if (!entry.finished) {
          entry.finished = true
          const owner = entry.owner,
            outcome = {
              status: 'failed' as const,
              code: 'kimi_child_completion_unknown',
              message: 'Kimi child completion is unknown',
            }
          await this.records
            .commit(
              ['child', owner.executionId, 'generation-ended'],
              [
                record(
                  this.records.scope,
                  'local',
                  [owner.executionId, 'generation-ended'],
                  'child.terminal',
                  { outcome, contentCoverage: 'partial' },
                  owner,
                  owner.providerAgentId,
                ),
              ],
              [
                {
                  runId: owner.runId,
                  turnId: owner.turnId,
                  childId: owner.childId,
                  itemId: owner.childId,
                  runtimeGeneration: this.generation,
                  deliveryId: '',
                  type: 'child_finished',
                  outcome,
                },
              ],
              undefined,
              true,
            )
            .catch(() => {})
        }
    // Retain this lease while uncertain native work can still own the home. Other sessions continue.
    await Promise.allSettled([
      this.lease.server.closeSocket(this.lifeId),
      this.lease.server.closeSocket(this.transcriptId),
    ])
  }
  async steerQueued(receiptIds: readonly string[]) {
    if (this.steeringQueued) throw new KimiError('kimi_steer_busy')
    if (
      !Array.isArray(receiptIds) ||
      receiptIds.length > this.budget.limits.nativeQueuedPrompts
    )
      throw new KimiError('kimi_steer_ids')
    const ids = [...receiptIds]
    if (!ids.length || new Set(ids).size !== ids.length)
      throw new KimiError('kimi_steer_ids')
    const ops = ids.map((id) => {
      const op = this.operations.get(id)
      if (
        !op?.accepted ||
        op.accepted.nativeStatus !== 'queued' ||
        op.steerAck ||
        op.settled
      )
        throw new KimiError('kimi_steer_receipt')
      return op
    })
    this.steeringQueued = true
    try {
      await this.mutate(() => this.steerOwned(ops))
    } catch (error) {
      if (error instanceof KimiError && error.uncertain)
        await this.retire(error)
      throw error
    } finally {
      this.steeringQueued = false
    }
  }
  private async steerOwned(ops: Operation[]) {
    if (
      ops.some(
        (op) =>
          op.settled || op.steerAck || op.accepted?.nativeStatus !== 'queued',
      )
    )
      throw new KimiError('kimi_steer_receipt')
    const parent = ops[0].parent
    if (
      !parent?.accepted ||
      !parent.providerTurn ||
      parent.settled ||
      ops.some((op) => op.parent !== parent)
    )
      throw new KimiError('kimi_steer_owner_unknown')
    const queued = object(
      await this.lease.server.http(
        this.lease.lane,
        `${this.basePath()}/prompts`,
      ),
    )
    if (
      object(queued.active).prompt_id !== parent.accepted.promptId ||
      !Array.isArray(queued.queued)
    )
      throw new KimiError('kimi_steer_owner_unknown')
    const ids = ops.map((op) => op.accepted!.promptId)
    if (
      ids.some(
        (id) =>
          !(queued.queued as unknown[]).some(
            (row) => object(row).prompt_id === id,
          ),
      )
    )
      throw new KimiError('kimi_steer_queue_changed')
    const response = object(
      await this.lease.server.http(
        this.lease.lane,
        `${this.basePath()}/prompts:steer`,
        { method: 'POST', body: { prompt_ids: ids } },
      ),
    )
    if (
      response.steered !== true ||
      !Array.isArray(response.prompt_ids) ||
      digest([...response.prompt_ids].sort()) !== digest([...ids].sort())
    )
      throw new KimiError('kimi_steer_response')
    for (const op of ops) {
      op.steerAck = true
      await this.confirmSteer(op)
    }
    // Native snapshot drains dispatch. A covered cut must contain the acknowledged assignment edge.
    await this.cut()
    if (ops.some((op) => !op.steerEdge))
      throw new KimiError(
        'kimi_steer_delivery_unknown',
        'Kimi steering delivery is unknown',
        true,
      )
  }
  private async confirmSteer(op: Operation) {
    if (
      !op.steerAck ||
      !op.steerEdge ||
      !op.parent?.providerTurn ||
      !op.accepted ||
      !op.parent.accepted
    )
      return
    if (op.steerCommitted) return
    await this.records.commit(
      [op.root.operationId, 'steered'],
      [
        record(
          this.records.scope,
          'live-engine',
          [op.steerEdge.epoch, op.steerEdge.seq, op.accepted.promptId],
          'prompt.steered',
          op.steerEdge.payload,
          op.root,
        ),
      ],
      [
        {
          ...this.base(op),
          type: 'steer_accepted',
          receiptId: op.receipt.receiptId,
        },
      ],
    )
    op.delivery.resolve({
      status: 'delivered',
      mode: 'steer',
      promptId: op.accepted.promptId,
      activePromptId: op.parent.accepted.promptId,
      providerTurnId: op.parent.providerTurn,
    })
    op.steerCommitted = true
    op.releaseQueue?.()
    if (op.parent.settled && op.parent.outcome && !op.settled) {
      await this.finish(op, op.parent.outcome)
    }
  }
  abortPrompt(receiptId: string): Promise<void> {
    const op = this.operations.get(receiptId)
    if (op?.persistenceFailure) return Promise.reject(op.persistenceFailure)
    if (op?.aborting) return op.aborting
    if (!op || op.settled) return Promise.resolve()
    op.aborting = this.abortOwned(op)
    return op.aborting
  }
  private async abortOwned(op: Operation) {
    let admitted = false
    if (!op.preparing && !op.accepted)
      throw new KimiError(
        'kimi_cleanup_uncertain',
        'Kimi cancellation is uncertain',
        true,
      )
    try {
      if (op.preparing) op.controller.abort()
      else {
        if (!op.accepted) throw new KimiError('kimi_cleanup_uncertain')
        await this.mutate(async () => {
          admitted = true
          if (op.settled) return
          if (!op.accepted) throw new KimiError('kimi_cleanup_uncertain')
          await this.lease.server.http(
            this.lease.lane,
            `${this.basePath()}/prompts/${encodeURIComponent(op.accepted!.promptId)}:abort`,
            { method: 'POST' },
          )
        })
      }
      // Aborting preparation only fences dispatch. Its admitted receipt still
      // owns a terminal write and finalization, including persistence failure.
      const finalized = this.host.track(
        op.terminal.promise.then(async () => {
          await op.completion.handle
          await op.finalizing
        }),
      )
      await deadline(
        finalized,
        this.budget.limits.shutdownMs,
        undefined,
        this.budget,
        this.host.budget,
      )
    } catch (cause) {
      if (isCompletionPersistenceFailure(cause)) throw cause
      if (
        !admitted &&
        cause instanceof KimiError &&
        cause.code === 'kimi_resource_limit'
      ) {
        op.aborting = undefined
        throw cause
      }
      const error = new KimiError(
        'kimi_cleanup_uncertain',
        'Kimi cancellation is uncertain',
        true,
      )
      await this.retire(error)
      throw error
    }
  }
  async cancel() {
    if (this.persistenceFailure) throw this.persistenceFailure
    if (this.active) await this.abortPrompt(this.active.identity.receiptId)
    if (this.persistenceFailure) throw this.persistenceFailure
  }
  async kill() {
    await this.cancel()
    if (this.persistenceFailure) throw this.persistenceFailure
    if (this.retired) throw this.retired
    await this.release()
  }
  private async release() {
    if (this.released) return
    this.released = true
    await this.interactions.expire('Kimi handle closed').catch(() => {})
    await Promise.allSettled([
      this.lease.server.closeSocket(this.lifeId),
      this.lease.server.closeSocket(this.transcriptId),
    ])
    this.replay?.dispose()
    this.transcriptPending.splice(0).forEach((entry) => entry.release())
    this.transcript.close()
    this.interactions.close()
    this.records.close()
    this.clearRetainedState()
    this.controller.abort()
    await this.lease.close()
  }
  async replyPermission(
    reply: Parameters<NonNullable<KimiHandle['replyPermission']>>[0],
  ) {
    return this.interactions.replyPermission(reply)
  }
  async replyQuestion(
    requestId: string,
    answers: Parameters<NonNullable<KimiHandle['replyQuestion']>>[1],
  ) {
    return this.interactions.replyQuestion(requestId, answers)
  }
  async dismissQuestion(requestId: string) {
    return this.interactions.dismissQuestion(requestId)
  }
  setModel(model: string) {
    this.defaults = resolveSettings(
      { model, permissionMode: this.defaults.permission_mode },
      this.defaults,
      this.catalog,
    )
  }
  async setConfigOption(id: string, value: string | boolean) {
    if (typeof value !== 'string') throw new KimiError('kimi_config_option')
    if (id === 'model') this.setModel(value)
    else if (id === 'thinking')
      this.defaults = resolveSettings(
        { reasoning: value, permissionMode: this.defaults.permission_mode },
        this.defaults,
        this.catalog,
      )
    else if (
      id === 'permissionMode' &&
      ['manual', 'auto', 'yolo'].includes(value)
    )
      this.defaults.permission_mode = value as KimiSettings['permission_mode']
    else throw new KimiError('kimi_config_option')
  }
  configOptions() {
    return [
      {
        id: 'model',
        name: 'Model',
        type: 'select' as const,
        currentValue: this.defaults.model ?? '',
        options: this.availableModels.map((model) => ({
          value: model.id,
          name: model.displayName,
        })),
      },
      {
        id: 'thinking',
        name: 'Thinking',
        type: 'select' as const,
        currentValue: this.defaults.thinking ?? '',
        options: (
          this.catalog.models.find((model) => model.id === this.defaults.model)
            ?.efforts ?? []
        ).map((value) => ({ value, name: value })),
      },
      {
        id: 'permissionMode',
        name: 'Permission mode',
        type: 'select' as const,
        currentValue: this.defaults.permission_mode,
        options: ['manual', 'auto', 'yolo'].map((value) => ({
          value,
          name: value,
        })),
      },
    ]
  }
}
