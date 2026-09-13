import { createHash } from 'node:crypto'
import {
  harnessEventSchema,
  type RequiredTerminalEvidence,
} from '@forge/protocol/harness'
import {
  KimiCommitAttempt,
  validateKimiAcknowledgement,
} from './persistence.js'
import type { HarnessEvent } from '../types.js'
import { redactSecrets } from '../diagnostics.js'
import {
  KimiBudget,
  KimiError,
  boundedString,
  deadline,
  jsonBytes,
  sequence,
  reserveAll,
} from './limits.js'
import type {
  KimiCheckpoint,
  KimiNativeRecord,
  KimiRecordScope,
  KimiRecordSink,
  KimiStateReader,
  KimiRoot,
} from './types.js'
import type { KimiHostOwner } from './host.js'

/** Input preflight belongs to the caller. Canonical keys never expose raw native text. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`
  return JSON.stringify(value)
}
export function digest(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}
export function record(
  scope: KimiRecordScope,
  domain: KimiNativeRecord['sourceIdentity']['domain'],
  key: unknown,
  kind: string,
  payload: unknown,
  root?: KimiRoot,
  agentId = 'main',
): KimiNativeRecord {
  const sourceIdentity = {
    domain,
    key: digest([scope.binding, agentId, domain, key]),
    revision: digest(payload),
  }
  return {
    recordId: digest(sourceIdentity),
    sourceIdentity,
    kind,
    payload,
    agentId,
    ...(root ? { root } : {}),
  }
}
export function eventId(
  generation: string,
  batchId: string,
  index: number,
  type: string,
  slot = 0,
) {
  return digest([generation, batchId, index, type, slot])
}
export function validateCheckpoint(
  checkpoint: KimiCheckpoint,
  budget: KimiBudget,
) {
  jsonBytes(checkpoint, budget.limits, budget.limits.cursorStateBytes)
  if (checkpoint.session) {
    sequence(checkpoint.session.seq)
    boundedString(checkpoint.session.epoch, budget.limits.cursorBytes, true)
  }
  const entries = Object.entries(checkpoint.transcripts)
  if (entries.length > budget.limits.cursorEntries)
    throw new KimiError('kimi_cursor_limit')
  for (const [id, seq] of entries) {
    boundedString(id, budget.limits.nativeIdBytes)
    sequence(seq)
  }
  for (const [agent, store] of Object.entries(
    checkpoint.transcriptStores ?? {},
  )) {
    boundedString(agent, budget.limits.nativeIdBytes)
    boundedString(store, budget.limits.cursorBytes)
    if (!Object.hasOwn(checkpoint.transcripts, agent))
      throw new KimiError('kimi_cursor_store')
  }
  if (checkpoint.history) {
    if (checkpoint.history.source !== 'transcript')
      throw new KimiError('kimi_cursor_domain')
    for (const value of Object.values(checkpoint.history))
      boundedString(value, budget.limits.cursorBytes)
  }
  if (checkpoint.messages) {
    if (
      checkpoint.messages.source !== 'messages' ||
      checkpoint.messages.agentId !== 'main'
    )
      throw new KimiError('kimi_cursor_domain')
    for (const value of Object.values(checkpoint.messages))
      boundedString(value, budget.limits.cursorBytes)
  }
}

/** One durable ingestion owner serializes both sockets and local acceptance/reply transactions. */
export class KimiRecords {
  private serial: Promise<void> = Promise.resolve()
  private ingestion: Promise<void> = Promise.resolve()
  private failed?: Error
  private sinkUnavailable = false
  private publishing = true
  private terminalBytes = 0
  private terminalEvents = 0
  private admitted = 0
  private readonly idle = new Set<() => void>()
  private readonly sealed = new Set<string>()
  private releaseRestored: () => void = () => {}
  private readonly releaseTerminalStorage: () => void
  private readonly physicalSinks = new Set<Promise<unknown>>()
  /** Admission ends only after the original asynchronous ingestion settles. */
  holdIngestion() {
    this.admitted++
    let held = true
    return () => {
      if (!held) return
      held = false
      if (--this.admitted === 0) {
        const ready = [...this.idle]
        this.idle.clear()
        for (const finish of ready) finish()
      }
    }
  }
  ingest<T>(work: () => Promise<T>): Promise<T> {
    const release = this.holdIngestion()
    const result = this.ingestion.then(work)
    this.ingestion = result
      .then(
        () => {},
        () => {},
      )
      .finally(release)
    return result
  }
  private readonly committedBatches = new Map<
    string,
    { hash: string; ordinal: number; release: () => void }
  >()
  ordinal = 0
  checkpoint: KimiCheckpoint = { transcripts: {} }
  restored?: Awaited<ReturnType<KimiStateReader>>
  get accepting() {
    return this.publishing
  }
  retire() {
    this.publishing = false
  }
  retainItem(bytes: number, tool: boolean) {
    return reserveAll([
      [this.budget, 'retainedItems'],
      [this.budget, 'retainedBytes', bytes],
      [this.host.budget, 'hostRetainedBytes', bytes],
      ...(tool
        ? [[this.budget, 'toolItems'] as [KimiBudget, 'toolItems']]
        : []),
    ])
  }
  preflight(
    records: readonly KimiNativeRecord[],
    events: readonly HarnessEvent[],
  ) {
    if (records.length > this.budget.limits.sinkBatchRecords)
      throw new KimiError('kimi_sink_batch_limit')
    jsonBytes(
      { records, events },
      this.budget.limits,
      this.budget.limits.sinkBatchBytes,
    )
    for (const event of events) {
      const wire = { ...event, deliveryId: 'preflight' } as HarnessEvent & {
        operationId?: string
      }
      delete wire.operationId
      harnessEventSchema.parse(wire)
    }
  }
  diagnostic(
    root: KimiRoot,
    itemId: string,
    message: unknown,
    severity: 'info' | 'warning' | 'error',
    code = 'kimi_native_notice',
    details?: unknown,
  ): HarnessEvent {
    const limits = this.budget.limits
    const event: HarnessEvent = {
      runId: root.runId,
      turnId: root.turnId,
      ...(root.childId ? { childId: root.childId } : {}),
      runtimeGeneration: this.scope.runtimeGeneration,
      deliveryId: '',
      itemId,
      type: 'diagnostic',
      severity,
      code: boundedString(code, 256),
      message: redactSecrets(
        boundedString(message, limits.diagnosticMessageBytes, true),
        this.secrets,
      ),
      ...(typeof details === 'string'
        ? {
            details: redactSecrets(
              boundedString(details, limits.diagnosticDetailBytes, true),
              this.secrets,
            ),
          }
        : {}),
    }
    this.budget.add('diagnostics')
    this.budget.add(
      'diagnosticBytes',
      jsonBytes(event, limits, limits.diagnosticBytes),
    )
    return event
  }
  constructor(
    readonly scope: KimiRecordScope,
    readonly budget: KimiBudget,
    readonly host: KimiHostOwner,
    private readonly sink: KimiRecordSink,
    private readonly emit: (event: HarnessEvent) => void,
    readonly signal: AbortSignal,
    private readonly importId?: string,
    private readonly secrets: readonly string[] = [],
  ) {
    // One MiB of terminal output plus its simultaneous normalization/capture copy.
    // Ordinary content cannot borrow this storage, including after output exhaustion.
    this.releaseTerminalStorage = reserveAll([
      [
        budget,
        'retainedBytes',
        2 * 1048576 + 4 * budget.limits.cursorStateBytes,
      ],
      [
        host.budget,
        'hostRetainedBytes',
        2 * 1048576 + 4 * budget.limits.cursorStateBytes,
      ],
    ])
  }
  async restore(reader: KimiStateReader) {
    const releaseMemory = reserveAll([
      [this.budget, 'retainedBytes', this.budget.limits.stateReadBytes],
      [
        this.host.budget,
        'hostRetainedBytes',
        this.budget.limits.stateReadBytes,
      ],
    ])
    let physical: Promise<Awaited<ReturnType<KimiStateReader>>> | undefined
    try {
      const release = this.host.budget.reserve('sinkCalls')
      physical = this.host.track(
        Promise.resolve()
          .then(() =>
            reader({
              sessionId: this.scope.sessionId,
              binding: this.scope.binding,
              signal: this.signal,
            }),
          )
          .finally(release),
      )
      const state = await deadline(
        physical,
        this.budget.limits.sinkMs,
        this.signal,
        this.budget,
        this.host.budget,
      )
      jsonBytes(state, this.budget.limits, this.budget.limits.stateReadBytes)
      sequence(state.committed.ordinal)
      if (!Array.isArray(state.owners) || !Array.isArray(state.pending))
        throw new KimiError('kimi_state_shape')
      if (
        state.owners.length > this.budget.limits.stateReadOwners ||
        state.pending.length > this.budget.limits.stateReadRequests
      )
        throw new KimiError('kimi_state_limit')
      const checkpoint = state.checkpoint ?? { transcripts: {} }
      validateCheckpoint(checkpoint, this.budget)
      for (const owner of state.owners) {
        boundedString(owner.agentId, this.budget.limits.nativeIdBytes)
        for (const field of [
          'providerTurnId',
          'providerPromptId',
          'providerToolCallId',
          'providerItemId',
        ] as const)
          if (owner[field] !== undefined)
            boundedString(owner[field], this.budget.limits.nativeIdBytes)
        boundedString(
          owner.sourceIdentity.key,
          this.budget.limits.nativeIdBytes,
        )
        boundedString(
          owner.sourceIdentity.revision,
          this.budget.limits.nativeIdBytes,
        )
        for (const key of ['runId', 'turnId', 'operationId'] as const)
          boundedString(owner.root[key], this.budget.limits.forgeIdBytes)
        if (
          ![
            'live-engine',
            'live-projection',
            'message',
            'cold-import',
            'local',
          ].includes(owner.sourceIdentity.domain)
        )
          throw new KimiError('kimi_state_owner')
        if (owner.child) {
          const child = owner.child
          for (const key of [
            'providerAgentId',
            'executionId',
            'providerParentAgentId',
            'providerParentToolCallId',
            'providerRootTurnId',
          ] as const)
            boundedString(child[key], this.budget.limits.nativeIdBytes)
          for (const key of [
            'childId',
            'parentToolCallId',
            'runId',
            'turnId',
            'operationId',
          ] as const)
            boundedString(child[key], this.budget.limits.forgeIdBytes)
          sequence(child.spawnCursor.seq)
          boundedString(child.spawnCursor.epoch, this.budget.limits.cursorBytes)
          if (
            child.providerAgentId !== owner.agentId ||
            child.runId !== owner.root.runId ||
            child.turnId !== owner.root.turnId ||
            child.operationId !== owner.root.operationId ||
            child.childId !== owner.root.childId
          )
            throw new KimiError('kimi_state_child_owner')
        }
      }
      for (const pending of state.pending) {
        if (
          pending.kind !== 'request.pending' ||
          !pending.root ||
          pending.sourceIdentity.domain !== 'live-engine'
        )
          throw new KimiError('kimi_state_request')
        const payload = pending.payload as Record<string, unknown>,
          raw = payload?.raw as Record<string, unknown>
        if (
          !raw ||
          raw.session_id !== this.scope.binding.providerSessionId ||
          !['question', 'approval'].includes(String(payload.kind))
        )
          throw new KimiError('kimi_state_request_binding')
        boundedString(payload.nativeId, this.budget.limits.nativeIdBytes)
        boundedString(pending.recordId, this.budget.limits.nativeIdBytes)
        for (const key of ['runId', 'turnId', 'operationId'] as const)
          boundedString(pending.root[key], this.budget.limits.forgeIdBytes)
      }
      for (const cursor of [checkpoint.history, checkpoint.messages])
        if (
          cursor &&
          cursor.nativeSessionId !== this.scope.binding.providerSessionId
        )
          throw new KimiError('kimi_state_binding')
      const bytes = jsonBytes(
        state,
        this.budget.limits,
        this.budget.limits.stateReadBytes,
      )
      const releaseState = reserveAll([
        [this.budget, 'retainedBytes', bytes],
        [this.host.budget, 'hostRetainedBytes', bytes],
      ])
      try {
        this.restored = structuredClone(state)
      } catch (error) {
        releaseState()
        throw error
      }
      this.releaseRestored()
      this.releaseRestored = releaseState
      this.ordinal = state.committed.ordinal
      this.checkpoint = structuredClone(checkpoint)
    } finally {
      if (physical) void physical.finally(releaseMemory).catch(() => {})
      else releaseMemory()
    }
  }
  readonly attempts = new Set<KimiCommitAttempt>()
  failedAttempt?: KimiCommitAttempt
  get terminalWritable() {
    return !this.sinkUnavailable
  }
  beginAttempt(
    roots: readonly KimiRoot[] = [],
    terminal = false,
    reserved = false,
  ) {
    const release = reserved
      ? () => {}
      : reserveAll([
          [this.budget, 'retainedBytes', 8192],
          [this.host.budget, 'hostRetainedBytes', 8192],
        ])
    const attempt = new KimiCommitAttempt(
      this.scope,
      roots,
      this.ordinal,
      terminal,
      release,
    )
    this.attempts.add(attempt)
    return attempt
  }
  requiredEvidence(
    root: KimiRoot,
    terminal: KimiCommitAttempt,
    historical = false,
  ): RequiredTerminalEvidence {
    if (
      terminal.scope !== this.scope ||
      !terminal.roots.some(
        (owner) =>
          owner.operationId === root.operationId &&
          owner.runId === root.runId &&
          owner.turnId === root.turnId,
      )
    )
      throw new KimiError('kimi_completion_owner')
    const evidence = (attempt: KimiCommitAttempt) =>
      historical ? (attempt.failureEvidence ?? attempt.latest) : attempt.latest
    const terminalEvidence = evidence(terminal)
    const involved = [
      ...new Set([
        ...this.attempts,
        ...(this.failedAttempt ? [this.failedAttempt] : []),
      ]),
    ].filter(
      (attempt) =>
        attempt === this.failedAttempt ||
        attempt.roots.some((owner) => owner.operationId === root.operationId),
    )
    const unproved = involved.some(
      (attempt) =>
        (attempt === this.failedAttempt ||
          attempt.roots.some(
            (owner) => owner.operationId === root.operationId,
          )) &&
        (evidence(attempt).phase === 'scheduled' ||
          evidence(attempt).phase === 'entered'),
    )
    if (unproved) return { state: 'unproved', terminal: terminalEvidence }
    if (
      involved.some(
        (attempt) =>
          attempt !== terminal &&
          attempt.underlying &&
          evidence(attempt).phase !== 'acknowledged',
      )
    )
      return { state: 'not_committed', terminal: terminalEvidence }
    if (
      terminalEvidence.phase === 'acknowledged' &&
      terminal.sealedOrdinal !== undefined
    )
      return {
        state: 'committed',
        terminal: terminalEvidence,
        sealedThrough: {
          kind: 'batch_ordinal',
          ordinal: Math.max(
            terminal.sealedOrdinal,
            terminalEvidence.acknowledgement.ordinal,
          ),
        },
      }
    return { state: 'not_committed', terminal: terminalEvidence }
  }
  commit(
    key: unknown,
    nativeRecords: readonly KimiNativeRecord[],
    events: readonly HarnessEvent[] = [],
    checkpoint?: KimiCheckpoint,
    terminal = false,
    end = Infinity,
    suppliedAttempt?: KimiCommitAttempt,
  ): Promise<number> {
    const roots = [
      ...new Map(
        nativeRecords.flatMap((entry) =>
          entry.root ? [[digest(entry.root), entry.root] as const] : [],
        ),
      ).values(),
    ]
    const attempt = suppliedAttempt ?? this.beginAttempt(roots, terminal)
    if (attempt.scope !== this.scope)
      throw new KimiError('kimi_completion_owner')
    const failed = (error: unknown) => {
      attempt.fail(error)
      if (!attempt.cause) this.failedAttempt ??= attempt
      this.failed = attempt.cause?.underlying ?? attempt.underlying
      throw error
    }
    try {
      return this.commitAttempt(
        attempt,
        key,
        nativeRecords,
        events,
        checkpoint,
        terminal,
        end,
      ).catch(failed)
    } catch (error) {
      return Promise.reject().catch(() => failed(error))
    }
  }
  private commitAttempt(
    attempt: KimiCommitAttempt,
    key: unknown,
    nativeRecords: readonly KimiNativeRecord[],
    events: readonly HarnessEvent[] = [],
    checkpoint?: KimiCheckpoint,
    terminal = false,
    end = Infinity,
  ): Promise<number> {
    if (performance.now() >= end)
      return Promise.reject(new KimiError('kimi_history_deadline'))
    const limits = this.budget.limits
    for (const entry of nativeRecords)
      if (entry.root && this.sealed.has(digest(entry.root)))
        return Promise.reject(new KimiError('kimi_owner_sealed'))
    if (nativeRecords.length > limits.sinkBatchRecords)
      return Promise.reject(new KimiError('kimi_sink_batch_limit'))
    const incomingBytes = jsonBytes(
      { nativeRecords, events, checkpoint },
      limits,
      limits.sinkBatchBytes,
    )
    const keyBytes = jsonBytes(key, limits, limits.sinkBatchBytes)
    const transformBytes = (incomingBytes + keyBytes) * 2 + events.length * 128
    const freeTransform = terminal
      ? () => {}
      : reserveAll([
          [this.budget, 'retainedBytes', transformBytes],
          [this.host.budget, 'hostRetainedBytes', transformBytes],
        ])
    let normalized: HarnessEvent[]
    let batchId: string, batchHash: string
    try {
      batchId = digest([this.scope.runtimeGeneration, this.importId, key])
      batchHash = digest({ nativeRecords, events, checkpoint })
      attempt.observe({
        ...attempt.initial,
        phase: 'constructed',
        batch: { batchId, contentHash: batchHash },
      })
      normalized = events.map((event, index) => {
        const wire = { ...event } as HarnessEvent & { operationId?: string }
        delete wire.operationId
        return harnessEventSchema.parse({
          ...wire,
          deliveryId: eventId(
            this.scope.runtimeGeneration,
            batchId,
            index,
            event.type,
          ),
        })
      })
    } catch (error) {
      freeTransform()
      throw error
    }
    let bytes: number
    try {
      bytes = jsonBytes(
        { nativeRecords, events: normalized, checkpoint },
        limits,
        limits.sinkBatchBytes,
      )
    } catch (error) {
      freeTransform()
      throw error
    }
    let releaseQueued: () => void
    try {
      if (terminal) {
        if (
          events.some(
            (event) =>
              !(
                event.type === 'request_cancelled' ||
                (event.type === 'turn_completed' &&
                  event.outcome.status !== 'completed') ||
                (event.type === 'child_finished' &&
                  event.outcome.status !== 'completed') ||
                (event.type === 'diagnostic' && event.severity === 'error')
              ),
          )
        )
          throw new KimiError('kimi_terminal_reserve_scope')
        if (
          this.terminalBytes + bytes > 1048576 ||
          this.terminalEvents + events.length >
            limits.promptReceipts + limits.interactions + limits.children + 1
        )
          throw new KimiError('kimi_terminal_reserve_limit')
        this.terminalBytes += bytes
        this.terminalEvents += events.length
      }
      releaseQueued = terminal
        ? () => {}
        : reserveAll([
            [
              this.budget,
              'retainedBytes',
              bytes +
                (checkpoint
                  ? jsonBytes(this.checkpoint, limits, limits.cursorStateBytes)
                  : 0),
            ],
            [
              this.host.budget,
              'hostRetainedBytes',
              bytes +
                (checkpoint
                  ? jsonBytes(this.checkpoint, limits, limits.cursorStateBytes)
                  : 0),
            ],
          ])
    } finally {
      freeTransform()
    }
    const recordsCopy = structuredClone(nativeRecords)
    const nextCheckpoint = checkpoint ? structuredClone(checkpoint) : undefined
    const capturedCheckpoint = checkpoint
      ? structuredClone(this.checkpoint)
      : undefined
    const releaseAdmission = this.holdIngestion()
    let physicallySubmitted = false
    let releaseCheckpointWork = () => {}
    let releaseMetadata = () => {}
    attempt.releaseInput = () => {
      releaseQueued()
      releaseCheckpointWork()
      releaseMetadata()
    }
    const task = this.serial
      .then(async () => {
        if (performance.now() >= end)
          throw new KimiError('kimi_history_deadline')
        const existing = this.committedBatches.get(batchId)
        if (existing) {
          if (existing.hash !== batchHash)
            throw new KimiError('kimi_batch_conflict')
          if (existing.ordinal < 1 || existing.ordinal > this.ordinal)
            throw new KimiError('kimi_sink_ordinal')
          attempt.observe({
            kind: 'batch_ordinal',
            phase: 'acknowledged',
            lastAcknowledged: { kind: 'batch_ordinal', ordinal: this.ordinal },
            batch: { batchId, contentHash: batchHash },
            acknowledgement: { via: 'local_cache', ordinal: existing.ordinal },
            publication: {
              state: 'not_republished',
              totalEvents: normalized.length,
              attemptedEvents: 0,
              returnedEvents: 0,
            },
          })
          return existing.ordinal
        }
        if (this.failed && (!terminal || this.sinkUnavailable)) {
          attempt.cause = this.failedAttempt
          throw this.failed
        }
        if (!this.publishing && !terminal)
          throw new KimiError('kimi_generation_retired')
        this.signal.throwIfAborted()
        const checkpointWorkBytes =
          2 *
          (jsonBytes(this.checkpoint, limits, limits.cursorStateBytes) +
            jsonBytes(nextCheckpoint ?? null, limits, limits.cursorStateBytes))
        if (!terminal)
          releaseCheckpointWork = reserveAll([
            [this.budget, 'retainedBytes', checkpointWorkBytes],
            [this.host.budget, 'hostRetainedBytes', checkpointWorkBytes],
          ])
        // Merge only the domains this call changed. A queued socket cannot restore another socket's older watermark.
        const target: KimiCheckpoint = {
          ...this.checkpoint,
          transcripts: { ...this.checkpoint.transcripts },
          ...(this.checkpoint.transcriptStores
            ? { transcriptStores: { ...this.checkpoint.transcriptStores } }
            : {}),
        }
        let replayOnly = false
        if (nextCheckpoint) {
          const patch: {
            session?: KimiCheckpoint['session']
            history?: KimiCheckpoint['history']
            messages?: KimiCheckpoint['messages']
          } = {}
          for (const field of ['session', 'history', 'messages'] as const) {
            if (!Object.hasOwn(nextCheckpoint, field)) continue
            if (
              digest(nextCheckpoint[field] ?? null) !==
              digest(capturedCheckpoint?.[field] ?? null)
            )
              Object.assign(patch, { [field]: nextCheckpoint[field] })
          }
          Object.assign(target, patch)
          for (const [agent, seq] of Object.entries(
            nextCheckpoint.transcripts,
          )) {
            const store = nextCheckpoint.transcriptStores?.[agent],
              oldStore = this.checkpoint.transcriptStores?.[agent],
              rebased = store !== undefined && store !== oldStore
            if (
              rebased &&
              !recordsCopy.some(
                (entry) =>
                  entry.kind === 'transcript.store.baseline' &&
                  entry.agentId === agent &&
                  (entry.payload as { store?: unknown }).store === store,
              )
            )
              throw new KimiError('kimi_transcript_store_unproved')
            if (seq !== capturedCheckpoint?.transcripts[agent] || rebased) {
              if (!rebased && seq < (this.checkpoint.transcripts[agent] ?? 0))
                replayOnly = true
              else Object.assign(target.transcripts, { [agent]: seq })
            }
            if (store)
              Object.assign(target, {
                transcriptStores: {
                  ...target.transcriptStores,
                  [agent]: store,
                },
              })
          }
          if (
            target.session &&
            this.checkpoint.session &&
            (target.session.epoch !== this.checkpoint.session.epoch ||
              target.session.seq < this.checkpoint.session.seq)
          )
            replayOnly = true
        }
        validateCheckpoint(target, this.budget)
        const releaseCumulative = terminal
          ? () => {}
          : reserveAll([
              [this.budget, 'nativeRecords', recordsCopy.length],
              [this.budget, 'nativeRecordBytes', bytes],
              [this.budget, 'publishedEvents', normalized.length],
              [
                this.budget,
                'publishedBytes',
                jsonBytes(normalized, limits, limits.sinkBatchBytes),
              ],
            ])
        const identityBytes =
          Buffer.byteLength(batchId) + Buffer.byteLength(batchHash)
        while (
          this.committedBatches.size &&
          (this.budget.count('duplicateEntries') >= limits.duplicateEntries ||
            this.budget.count('duplicateBytes') + identityBytes >
              limits.duplicateBytes)
        ) {
          const first = this.committedBatches.keys().next().value!
          this.committedBatches.get(first)!.release()
          this.committedBatches.delete(first)
        }
        let freeIdentity = () => {}
        const expectedOrdinal = this.ordinal
        const input = {
          scope: this.scope,
          importId: this.importId,
          batchId,
          contentHash: batchHash,
          replayOnly,
          expectedOrdinal,
          expectedCheckpoint: this.checkpoint,
          checkpoint: target,
          records: recordsCopy,
          events: normalized,
          signal: this.signal,
        }
        attempt.input = input
        const prepared = {
          kind: 'batch_ordinal' as const,
          phase: 'prepared' as const,
          lastAcknowledged: {
            kind: 'batch_ordinal' as const,
            ordinal: expectedOrdinal,
          },
          batch: { batchId, contentHash: batchHash },
          input: { expectedOrdinal, replayOnly },
        }
        attempt.observe(prepared)
        let release: () => void
        try {
          if (!terminal)
            freeIdentity = reserveAll([
              [this.budget, 'duplicateEntries'],
              [this.budget, 'duplicateBytes', identityBytes],
              [this.host.budget, 'hostRetainedBytes', identityBytes],
            ])
          const inputBytes = jsonBytes(
            { ...input, signal: undefined },
            limits,
            limits.sinkBatchBytes,
          )
          releaseMetadata = terminal
            ? () => {}
            : reserveAll([
                [this.budget, 'retainedBytes', Math.max(0, inputBytes - bytes)],
                [
                  this.host.budget,
                  'hostRetainedBytes',
                  Math.max(0, inputBytes - bytes),
                ],
              ])
          const freeCall = this.host.budget.reserve('sinkCalls')
          release = () => {
            freeCall()
          }
        } catch (error) {
          freeIdentity()
          releaseCumulative()
          throw error
        }
        physicallySubmitted = true
        attempt.observe({
          ...prepared,
          phase: 'scheduled',
          physical: 'pending',
        })
        const physical = this.host.track(
          Promise.resolve()
            .then(() => {
              attempt.observe({
                ...prepared,
                phase: 'entered',
                physical: 'pending',
              })
              return this.sink(input)
            })
            .then(
              (value) => {
                let position
                try {
                  position = validateKimiAcknowledgement(
                    value,
                    expectedOrdinal,
                    replayOnly,
                  )
                } catch (error) {
                  attempt.observe({
                    ...prepared,
                    phase: 'entered',
                    physical: 'invalid_ack',
                  })
                  attempt.fail(error, 'invalid_ack')
                  throw error
                }
                attempt.observe({
                  ...prepared,
                  phase: 'acknowledged',
                  acknowledgement: { via: 'sink', ...position },
                  publication: {
                    state:
                      position.disposition === 'replayed'
                        ? 'not_republished'
                        : 'not_started',
                    totalEvents: normalized.length,
                    attemptedEvents: 0,
                    returnedEvents: 0,
                  },
                })
                return position
              },
              (error) => {
                attempt.observe({
                  ...prepared,
                  phase: 'entered',
                  physical: 'rejected',
                })
                attempt.fail(error, 'commit_failed')
                throw error
              },
            )
            .finally(() => {
              attempt.physicalSettled = true
              release()
            }),
        )
        this.physicalSinks.add(physical)
        void physical
          .finally(() => this.physicalSinks.delete(physical))
          .catch(() => {})
        let position
        try {
          position = await deadline(
            physical,
            Math.min(limits.sinkMs, Math.max(1, end - performance.now())),
            this.signal,
            this.budget,
            this.host.budget,
          )
        } catch (error) {
          this.sinkUnavailable = true
          attempt.fail(error)
          freeIdentity()
          throw error
        }
        if (position.disposition === 'replayed') {
          if (
            sequence(position.ordinal) > expectedOrdinal ||
            position.ordinal === 0
          ) {
            freeIdentity()
            throw new KimiError('kimi_sink_retry_ordinal')
          }
          releaseCumulative()
          freeIdentity()
          return position.ordinal
        }
        if (
          replayOnly ||
          position.disposition !== 'committed' ||
          sequence(position.ordinal) !== expectedOrdinal + 1
        ) {
          freeIdentity()
          throw new KimiError('kimi_sink_ordinal')
        }
        this.ordinal = position.ordinal
        this.checkpoint = target
        if (!terminal)
          this.committedBatches.set(batchId, {
            hash: batchHash,
            ordinal: position.ordinal,
            release: freeIdentity,
          })
        // The durable outbox owns recovery if publication fails after commit.
        if (performance.now() >= end) {
          if (attempt.latest.phase === 'acknowledged')
            attempt.observe({
              ...attempt.latest,
              publication: { ...attempt.latest.publication, state: 'stopped' },
            })
          throw new KimiError('kimi_history_deadline')
        }
        if (!this.publishing && !terminal && normalized.length) {
          if (attempt.latest.phase === 'acknowledged')
            attempt.observe({
              ...attempt.latest,
              publication: { ...attempt.latest.publication, state: 'stopped' },
            })
          throw new KimiError('kimi_generation_retired')
        }
        if (this.publishing || terminal)
          for (const event of normalized) {
            if (attempt.latest.phase !== 'acknowledged')
              throw new KimiError('kimi_completion_persistence')
            attempt.observe({
              ...attempt.latest,
              publication: {
                ...attempt.latest.publication,
                state: 'stopped',
                attemptedEvents: attempt.latest.publication.attemptedEvents + 1,
              },
            })
            this.emit(event)
            if (attempt.latest.phase === 'acknowledged')
              attempt.observe({
                ...attempt.latest,
                publication: {
                  ...attempt.latest.publication,
                  returnedEvents: attempt.latest.publication.returnedEvents + 1,
                },
              })
          }
        if (attempt.latest.phase === 'acknowledged')
          attempt.observe({
            ...attempt.latest,
            publication: { ...attempt.latest.publication, state: 'complete' },
          })
        return this.ordinal
      })
      .finally(() => {
        if (!physicallySubmitted) attempt.physicalSettled = true
      })
    this.serial = task
      .then(
        () => {
          if (!attempt.terminal) {
            attempt.close()
            this.attempts.delete(attempt)
          }
        },
        (error) => {
          attempt.fail(error)
          if (!attempt.cause) this.failedAttempt ??= attempt
          this.failed =
            error instanceof Error ? error : new KimiError('kimi_sink_failed')
        },
      )
      .finally(releaseAdmission)
    return task
  }
  drain(seal?: KimiRoot): Promise<number> {
    return new Promise((resolve, reject) => {
      const finish = () => {
        if (seal) {
          this.sealed.add(digest(seal))
          for (const attempt of this.attempts)
            if (
              attempt.terminal &&
              attempt.roots.some(
                (root) =>
                  root.operationId === seal.operationId &&
                  root.runId === seal.runId &&
                  root.turnId === seal.turnId,
              )
            )
              attempt.sealedOrdinal = this.ordinal
        }
        if (this.failed) {
          reject(this.failed)
          return
        }
        resolve(this.ordinal)
      }
      if (this.admitted) this.idle.add(finish)
      else finish()
    })
  }
  close() {
    this.retire()
    for (const batch of this.committedBatches.values()) batch.release()
    this.committedBatches.clear()
    this.releaseRestored()
    this.restored = undefined
    this.sealed.clear()
    void Promise.allSettled(this.physicalSinks).then(() => {
      for (const attempt of this.attempts) attempt.close()
      this.attempts.clear()
      this.releaseTerminalStorage()
    })
  }
}
