import { randomUUID } from 'node:crypto'
import {
  completionFailureProjectionSchema,
  type JournalPendingEvidence,
} from '@forge/protocol/harness'
import type {
  ConfirmedNativeBinding,
  HarnessEvent,
  CompletionPersistenceFailure,
  HarnessHistoryEvent,
} from '../types.js'
import { immutableData, canonical, digest } from './data.js'
import type { AcpResourceHost } from './limits.js'

export type AccountScope = Readonly<
  | { kind: 'native-default'; configurationId: string }
  | { kind: 'selected-account'; accountId: string }
>
export type AcpOwnerBase = Readonly<{
  sessionId: string
  providerInstanceId: string
  account: AccountScope
  runtimeGeneration: string
}>
export type AcpLiveOwner = AcpOwnerBase &
  Readonly<{
    phase: 'live'
    binding: ConfirmedNativeBinding
    runId: string
    turnId: string
  }>
export type AcpReplayOwner = AcpOwnerBase &
  Readonly<{
    phase: 'load_replay'
    binding: ConfirmedNativeBinding
    loadId: string
    requestedNativeSessionId: string
  }>
export type AcpControlOwner = AcpOwnerBase &
  Readonly<{
    phase: 'control'
    startupId: string
    expectedBinding: ConfirmedNativeBinding | null
  }>
export type AcpRecordOwner = AcpLiveOwner | AcpReplayOwner | AcpControlOwner
export type AcpSourceRef = Readonly<{
  artifactId: string
  mime: string
  bytes: number
  sha256: string
}>
export type AcpReplayEventBody = HarnessHistoryEvent
export type NeutralRecord =
  | Readonly<{ kind: 'event'; event: HarnessEvent }>
  | Readonly<{ kind: 'replay'; event: AcpReplayEventBody }>
  | Readonly<{ kind: 'binding'; binding: ConfirmedNativeBinding }>
  | Readonly<{ kind: 'source'; reference: AcpSourceRef }>
  | Readonly<{
      kind: 'interaction'
      requestId: string
      status: 'pending' | 'submitted' | 'retired' | 'indeterminate'
    }>
  | Readonly<{
      kind: 'disposition'
      status:
        | 'ignored'
        | 'replay_staged'
        | 'replay_visible'
        | 'replay_discarded'
        | 'failed'
      code?: string
    }>
export type RecordSubject = Readonly<{
  itemId?: string
  responseId?: string
  childId?: string
  intervalId?: string
  requestId?: string
}>
export type AcpRecordSource = Readonly<{
  transportGeneration?: string
  wireOrdinal?: number
  producerTicket: string
  kind: 'native' | 'local' | 'request' | 'terminal'
}>
export type DurableAcpRecord = Readonly<{
  journalId: string
  admissionOrdinal: number
  recordIndex: number
  recordId: string
  owner: AcpRecordOwner
  subject: RecordSubject
  source: AcpRecordSource
  value: NeutralRecord
  sourceRefs: readonly AcpSourceRef[]
}>
export type PrefixTransaction = Readonly<{
  transactionId: string
  journalId: string
  writerEpoch: string
  afterOrdinal: number
  throughOrdinal: number
  previousPrefixHash: string
  contentHash: string
  records: readonly DurableAcpRecord[]
}>
export type CommittedPrefix = Readonly<{
  transactionId: string
  throughOrdinal: number
  prefixHash: string
}>
export type AcpSessionWriter = {
  readonly journalId: string
  readonly writerEpoch: string
  readonly committedThrough: number
  readonly prefixHash: string
  commit(
    transaction: PrefixTransaction,
    signal: AbortSignal,
  ): Promise<CommittedPrefix>
  close(): Promise<void>
}
export type AcpIngestionFactory = {
  open(
    input: Readonly<{
      sessionId: string
      providerInstanceId: string
      account: AccountScope
      expectedBinding: ConfirmedNativeBinding | null
    }>,
    signal: AbortSignal,
  ): Promise<AcpSessionWriter>
}
export type AcpContentOwner = Readonly<{
  owner: AcpLiveOwner | AcpReplayOwner
  itemId: string
  responseId?: string
  childId?: string
  intervalId?: string
}>
export type AcpContentStore = {
  put(
    input: Readonly<{
      owner: AcpContentOwner
      purpose: 'content' | 'source_metadata' | 'replay'
      mime: string
      bytes: Uint8Array
      sha256: string
    }>,
    signal: AbortSignal,
  ): Promise<AcpSourceRef>
  discard(artifactId: string, owner: AcpContentOwner): Promise<void>
}
export type AcpRecordInput = Readonly<{
  value: NeutralRecord
  subject?: RecordSubject
  sourceRefs?: readonly AcpSourceRef[]
}>
type Slot = {
  ordinal: number
  owner: AcpRecordOwner
  source: AcpRecordSource
  records?: readonly DurableAcpRecord[]
  bytes: number
  releaseBytes?: () => void
  resolve: () => void
  reject: (error: unknown) => void
}
export type AcpTicket = {
  readonly ordinal: number
  readonly committed: Promise<void>
  finish(records: readonly AcpRecordInput[]): void
  failAdmission(): void
}

export const emptyPrefix = (journalId: string) =>
  digest(['acp-empty-v1', journalId])
export const committedPrefix = (transaction: PrefixTransaction) =>
  digest([
    'acp-prefix-v1',
    transaction.previousPrefixHash,
    transaction.transactionId,
    transaction.throughOrdinal,
    transaction.contentHash,
  ])

export class AcpUnknownAcknowledgement extends Error {}

export class AcpJournal {
  private readonly journalId: string
  private readonly writerEpoch: string
  private readonly slots: Slot[] = []
  private readonly liveOwners = new Set<string>()
  private readonly committedOwners = new Set<string>()
  private readonly terminalProofs = new Map<string, () => void>()
  private next: number
  private committedThrough: number
  private prefixHash: string
  private running?: Promise<void>
  private failure?: {
    evidence: JournalPendingEvidence
    owner: AcpRecordOwner
    operationId: string
    terminalOwners: readonly AcpRecordOwner[]
    classification:
      | 'commit_failed'
      | 'invalid_ack'
      | 'logical_deadline'
      | 'admission_failed'
      | 'ack_unknown'
  }
  private activeCommit?: {
    selected: readonly Slot[]
    evidence(): JournalPendingEvidence
  }
  private bytes = 0
  private credits = 0
  private readonly admissionWaiters = new Map<
    boolean,
    { promise: Promise<void>; resolve(): void; reject(error: unknown): void }
  >()
  private closed = false
  constructor(
    private readonly writer: AcpSessionWriter,
    private readonly options: {
      host: AcpResourceHost
      instanceId: string
      onFailure: () => void
      commitMs?: number
    },
  ) {
    if (
      !writer.journalId ||
      !writer.writerEpoch ||
      !Number.isSafeInteger(writer.committedThrough) ||
      writer.committedThrough < 0 ||
      !/^[a-f0-9]{64}$/.test(writer.prefixHash)
    )
      throw Error('Invalid ACP writer identity')
    this.journalId = writer.journalId
    this.writerEpoch = writer.writerEpoch
    this.next = this.committedThrough = writer.committedThrough
    this.prefixHash = writer.prefixHash
  }
  admissionReady(control = false): Promise<void> | undefined {
    if (this.closed || this.failure) throw Error('ACP journal is unavailable')
    if (this.next >= Number.MAX_SAFE_INTEGER)
      throw Error('ACP journal admission limit')
    if (this.slots.length + this.credits < (control ? 64 : 62)) return
    let waiter = this.admissionWaiters.get(control)
    if (!waiter) {
      let resolve!: () => void, reject!: (error: unknown) => void
      const promise = new Promise<void>((yes, no) => {
        resolve = yes
        reject = no
      })
      void promise.catch(() => {})
      waiter = { promise, resolve, reject }
      this.admissionWaiters.set(control, waiter)
    }
    return waiter.promise
  }
  private wakeAdmission() {
    for (const [control, waiter] of this.admissionWaiters) {
      if (this.closed || this.failure) {
        this.admissionWaiters.delete(control)
        waiter.reject(Error('ACP journal is unavailable'))
      } else if (this.slots.length + this.credits < (control ? 64 : 62)) {
        this.admissionWaiters.delete(control)
        waiter.resolve()
      }
    }
  }
  reserveCredits(count: number) {
    if (
      this.closed ||
      this.failure ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      this.slots.length + this.credits + count > 62
    )
      throw Error('ACP journal admission limit')
    this.credits += count
    let remaining = count
    return {
      consume: () => {
        if (!remaining) throw Error('ACP journal credit exhausted')
        remaining--
        this.credits--
        this.wakeAdmission()
      },
      release: () => {
        this.credits -= remaining
        remaining = 0
        this.wakeAdmission()
      },
    }
  }
  reserve(
    owner: AcpRecordOwner,
    source: AcpRecordSource,
    control = false,
  ): AcpTicket {
    if (this.closed || this.failure) throw Error('ACP journal is unavailable')
    if (
      this.slots.length + this.credits >= (control ? 64 : 62) ||
      this.next >= Number.MAX_SAFE_INTEGER
    )
      throw Error('ACP journal admission limit')
    const capturedOwner = immutableData(owner)
    const capturedSource = immutableData(source)
    if (capturedOwner.phase === 'live') {
      const key = digest(capturedOwner)
      if (!this.liveOwners.has(key) && this.liveOwners.size >= 256)
        throw Error('ACP journal owner limit')
      this.liveOwners.add(key)
    }
    let resolve!: () => void, reject!: (error: unknown) => void
    const committed = new Promise<void>((yes, no) => {
      resolve = yes
      reject = no
    })
    void committed.catch(() => {})
    const slot: Slot = {
      ordinal: ++this.next,
      owner: capturedOwner,
      source: capturedSource,
      bytes: 0,
      resolve,
      reject,
    }
    this.slots.push(slot)
    const journal = this
    const ticket: AcpTicket = {
      failAdmission() {
        if (this !== ticket) throw Error('Foreign ACP journal ticket')
        if (slot.records) throw Error('ACP journal ticket is already finished')
        if (journal.closed) throw Error('ACP journal is closed')
        journal.failAdmission(slot)
      },
      ordinal: slot.ordinal,
      committed,
      finish: (input) => {
        if (slot.records || this.failure || this.closed)
          throw Error('ACP journal ticket is retired')
        if (!input.length || input.length > 256)
          throw Error('ACP journal record limit')
        const records = immutableData(
          immutableData(input, 4 * 1024 * 1024).map((record, index) => ({
            journalId: this.journalId,
            admissionOrdinal: slot.ordinal,
            recordIndex: index,
            recordId: digest([this.journalId, slot.ordinal, index]),
            owner: slot.owner,
            subject: record.subject ?? {},
            source: slot.source,
            value: record.value,
            sourceRefs: record.sourceRefs ?? [],
          })),
          4 * 1024 * 1024,
        )
        const bytes = Buffer.byteLength(canonical(records))
        if (bytes > 4 * 1024 * 1024 || this.bytes + bytes > 4 * 1024 * 1024)
          throw Error('ACP journal byte limit')
        const releaseBytes = this.options.host.reserve(
          this.options.instanceId,
          'retained',
          bytes,
        )
        if (
          (slot.source.kind === 'terminal' && slot.owner.phase === 'live') ||
          (slot.owner.phase === 'load_replay' &&
            records.some(
              (record) =>
                record.value.kind === 'disposition' &&
                ['replay_visible', 'replay_discarded'].includes(
                  record.value.status,
                ),
            ))
        ) {
          const key = digest(slot.owner)
          if (!this.terminalProofs.has(key)) {
            try {
              if (this.terminalProofs.size >= 4096)
                throw Error('ACP terminal proof limit')
              this.terminalProofs.set(
                key,
                this.options.host.reserve(
                  this.options.instanceId,
                  'retained',
                  256,
                ),
              )
            } catch (error) {
              releaseBytes()
              throw error
            }
          }
        }
        slot.releaseBytes = releaseBytes
        slot.records = records
        slot.bytes = bytes
        this.bytes += bytes
        this.pump()
      },
    }
    return ticket
  }
  append(
    owner: AcpRecordOwner,
    value: NeutralRecord,
    kind: AcpRecordSource['kind'] = 'local',
  ) {
    const ticket = this.reserve(
      owner,
      { producerTicket: randomUUID(), kind },
      kind === 'terminal',
    )
    ticket.finish([{ value }])
    return ticket.committed
  }
  private failAdmission(first: Slot) {
    if (this.failure) return
    this.failure = {
      evidence: immutableData({
        kind: 'journal_prefix',
        journalId: this.journalId,
        phase: 'pre_admission',
        lastAcknowledged: {
          kind: 'journal_prefix',
          throughOrdinal: this.committedThrough,
          prefixHash: this.prefixHash,
        },
      }),
      owner: first.owner,
      operationId: first.source.producerTicket,
      terminalOwners: [],
      classification: 'admission_failed',
    }
    this.wakeAdmission()
    for (const slot of this.slots)
      if (!this.activeCommit?.selected.includes(slot))
        slot.reject(Error('ACP persistence admission failed'))
    try {
      this.options.onFailure()
    } catch {
      /* Failure is already latched. */
    }
  }
  private pump() {
    if (
      this.running ||
      this.activeCommit ||
      this.failure ||
      this.closed ||
      !this.slots[0]?.records
    )
      return
    this.running = this.commitNext()
      .catch(() => {
        this.failAdmission(this.slots[0]!)
      })
      .finally(() => {
        this.running = undefined
        this.pump()
      })
    void this.running.catch(() => {})
  }
  private async commitNext() {
    const selected: Slot[] = []
    let count = 0
    for (const slot of this.slots) {
      if (!slot.records || count + slot.records.length > 256) break
      selected.push(slot)
      count += slot.records.length
    }
    const records = selected.flatMap((slot) => slot.records!)
    const throughOrdinal = selected.at(-1)!.ordinal
    const contentHash = digest(records)
    const transaction: PrefixTransaction = immutableData(
      {
        transactionId: digest([
          this.journalId,
          this.writerEpoch,
          this.committedThrough,
          throughOrdinal,
          this.prefixHash,
          contentHash,
        ]),
        journalId: this.journalId,
        writerEpoch: this.writerEpoch,
        afterOrdinal: this.committedThrough,
        throughOrdinal,
        previousPrefixHash: this.prefixHash,
        contentHash,
        records,
      },
      4 * 1024 * 1024,
    )
    const releaseCommit = this.options.host.reserve(
      this.options.instanceId,
      'commits',
    )
    const base = {
      kind: 'journal_prefix' as const,
      journalId: this.journalId,
      lastAcknowledged: {
        kind: 'journal_prefix' as const,
        throughOrdinal: this.committedThrough,
        prefixHash: this.prefixHash,
      },
      transaction: {
        transactionId: transaction.transactionId,
        contentHash,
        fromOrdinal: this.committedThrough + 1,
        throughOrdinal,
      },
      invocation: 1 as 1 | 2,
      phase: 'entered' as const,
    }
    const controller = new AbortController()
    const fail = (
      physical: 'pending' | 'rejected' | 'invalid_ack',
      classification: 'logical_deadline' | 'commit_failed' | 'invalid_ack',
    ) => {
      if (this.failure && this.failure.classification !== 'admission_failed')
        return
      this.failure = {
        evidence: immutableData({ ...base, physical }),
        owner: selected[0]!.owner,
        operationId: selected[0]!.source.producerTicket,
        terminalOwners: selected
          .filter((slot) => slot.source.kind === 'terminal')
          .map((slot) => slot.owner),
        classification,
      }
      this.wakeAdmission()
      controller.abort()
      for (const slot of this.slots)
        slot.reject(Error('ACP persistence is unproved'))
      try {
        this.options.onFailure()
      } catch {
        /* Failure is already latched. */
      }
    }
    const timer = setTimeout(
      () => fail('pending', 'logical_deadline'),
      this.options.commitMs ?? 15000,
    )
    this.activeCommit = {
      selected,
      evidence: () => immutableData({ ...base, physical: 'pending' }),
    }
    try {
      let ack: CommittedPrefix
      try {
        ack = await this.writer.commit(transaction, controller.signal)
      } catch (error) {
        if (
          !(error instanceof AcpUnknownAcknowledgement) ||
          (this.failure &&
            this.failure.classification !== 'admission_failed') ||
          this.closed
        )
          throw error
        base.invocation = 2
        ack = await this.writer.commit(transaction, controller.signal)
      }
      if (this.failure && this.failure.classification !== 'admission_failed')
        return
      if (
        ack.transactionId !== transaction.transactionId ||
        ack.throughOrdinal !== throughOrdinal ||
        ack.prefixHash !== committedPrefix(transaction)
      ) {
        fail('invalid_ack', 'invalid_ack')
        return
      }
      this.committedThrough = throughOrdinal
      this.prefixHash = ack.prefixHash
      if (this.failure?.classification === 'admission_failed')
        this.failure.evidence = immutableData({
          ...this.failure.evidence,
          lastAcknowledged: {
            kind: 'journal_prefix',
            throughOrdinal,
            prefixHash: ack.prefixHash,
          },
        })
      this.slots.splice(0, selected.length)
      this.wakeAdmission()
      for (const slot of selected) {
        this.bytes -= slot.bytes
        slot.releaseBytes?.()
        if (
          (slot.source.kind === 'terminal' && slot.owner.phase === 'live') ||
          (slot.owner.phase === 'load_replay' &&
            slot.records!.some(
              (record) =>
                record.value.kind === 'disposition' &&
                ['replay_visible', 'replay_discarded'].includes(
                  record.value.status,
                ),
            ))
        )
          this.committedOwners.add(digest(slot.owner))
        slot.resolve()
      }
    } catch {
      fail('rejected', 'commit_failed')
    } finally {
      this.activeCommit = undefined
      releaseCommit()
      clearTimeout(timer)
    }
  }
  completionFailure(
    owner: AcpLiveOwner,
    identity: { receiptId: string; completionId: string },
  ): CompletionPersistenceFailure {
    if (!this.failure) throw Error('ACP journal has no persistence failure')
    if (!this.liveOwners.has(digest(owner)))
      throw Error('Foreign ACP completion owner')
    if (this.committedOwners.has(digest(owner)))
      throw Error('ACP terminal is already acknowledged')
    const active = this.activeCommit
    const failure =
      active && this.failure.classification === 'admission_failed'
        ? {
            evidence: active.evidence(),
            owner: active.selected[0]!.owner,
            operationId: active.selected[0]!.source.producerTicket,
            terminalOwners: active.selected
              .filter((slot) => slot.source.kind === 'terminal')
              .map((slot) => slot.owner),
            classification: 'ack_unknown' as const,
          }
        : this.failure
    const cause = failure.owner
    const authority = (value: AcpRecordOwner) => ({
      sessionId: value.sessionId,
      providerInstanceId: value.providerInstanceId,
      account: value.account,
      runtimeGeneration: value.runtimeGeneration,
      binding:
        value.phase === 'control' ? value.expectedBinding : value.binding,
    })
    if (canonical(authority(owner)) !== canonical(authority(cause)))
      throw Error('Foreign ACP completion owner')
    const entered = failure.evidence.phase === 'entered'
    const sameRoot =
      cause.phase === 'live' &&
      cause.runId === owner.runId &&
      cause.turnId === owner.turnId
    const terminalEntered = failure.terminalOwners.some(
      (candidate) =>
        candidate.phase === 'live' && digest(candidate) === digest(owner),
    )
    const projection = completionFailureProjectionSchema.parse({
      version: 1,
      ...identity,
      sessionId: owner.sessionId,
      runId: owner.runId,
      turnId: owner.turnId,
      code: entered ? 'persistence_unknown' : 'completion_not_committed',
      classification: failure.classification,
      cause: {
        relation: sameRoot ? 'own_required_write' : 'session_fence',
        owner:
          cause.phase === 'live'
            ? {
                kind: 'operation',
                sessionId: cause.sessionId,
                runtimeGeneration: cause.runtimeGeneration,
                runId: cause.runId,
                turnId: cause.turnId,
                operationId: failure.operationId,
              }
            : {
                kind: 'session',
                sessionId: cause.sessionId,
                runtimeGeneration: cause.runtimeGeneration,
              },
      },
      failure: failure.evidence,
      required: terminalEntered
        ? { state: 'unproved', terminal: failure.evidence }
        : {
            state: entered ? 'unproved' : 'not_committed',
            terminal: {
              kind: 'journal_prefix',
              journalId: this.journalId,
              phase: 'pre_admission',
              lastAcknowledged: failure.evidence.lastAcknowledged,
            },
          },
    })
    const error = new Error('ACP persistence is unproved')
    for (const [key, value] of Object.entries({
      code: projection.code,
      completionId: identity.completionId,
      runId: owner.runId,
      turnId: owner.turnId,
      persistence: immutableData(projection),
    }))
      Object.defineProperty(error, key, { value, enumerable: true })
    return error as CompletionPersistenceFailure
  }
  canRetireOwner(owner: AcpLiveOwner | AcpReplayOwner) {
    const key = digest(owner)
    return (
      !this.closed &&
      !this.failure &&
      this.committedOwners.has(key) &&
      !this.slots.some((slot) => digest(slot.owner) === key)
    )
  }
  retireOwner(owner: AcpLiveOwner | AcpReplayOwner) {
    const key = digest(owner)
    if (
      this.failure ||
      !this.committedOwners.has(key) ||
      this.slots.some((slot) => digest(slot.owner) === key)
    )
      throw Error('ACP owner still has unsettled persistence')
    this.liveOwners.delete(key)
  }
  async close() {
    this.closed = true
    this.wakeAdmission()
    for (const slot of this.slots) slot.reject(Error('ACP journal closed'))
    await this.running
    await this.writer.close()
    for (const slot of this.slots) slot.releaseBytes?.()
    this.liveOwners.clear()
    this.committedOwners.clear()
    for (const release of this.terminalProofs.values()) release()
    this.terminalProofs.clear()
    this.slots.length = 0
    this.bytes = 0
  }
}
