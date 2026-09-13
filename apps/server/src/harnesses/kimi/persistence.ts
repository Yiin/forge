import {
  completionFailureProjectionSchema,
  completionRecoveryProjectionSchema,
  type BatchAcknowledgedEvidence,
  type BatchPendingEvidence,
  type CompletionFailureClassification,
  type CompletionFailureIdentity,
  type CompletionFailureProjection,
  type PersistenceCauseOwner,
  type RequiredTerminalEvidence,
} from '@forge/protocol/harness'
import type { CompletionPersistenceFailure } from '../types.js'
import type { KimiRecordScope, KimiRecordSink, KimiRoot } from './types.js'
import { KimiError } from './limits.js'

export type KimiBatchEvidence = BatchPendingEvidence | BatchAcknowledgedEvidence
export function freezeEvidence<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const descriptor of Object.values(
      Object.getOwnPropertyDescriptors(value),
    ))
      if ('value' in descriptor) freezeEvidence(descriptor.value)
    Object.freeze(value)
  }
  return value
}
export class KimiCommitAttempt {
  readonly initial: KimiBatchEvidence
  latest: KimiBatchEvidence
  underlying?: Error
  failureEvidence?: KimiBatchEvidence
  classification?: CompletionFailureClassification
  cause?: KimiCommitAttempt
  input?: Parameters<KimiRecordSink>[0]
  physicalSettled = false
  sealedOrdinal?: number
  releaseInput?: () => void
  constructor(
    readonly scope: KimiRecordScope,
    readonly roots: readonly KimiRoot[],
    ordinal: number,
    readonly terminal: boolean,
    readonly release: () => void,
  ) {
    this.initial = freezeEvidence({
      kind: 'batch_ordinal',
      phase: 'pre_admission',
      lastAcknowledged: { kind: 'batch_ordinal', ordinal },
    })
    this.latest = this.initial
  }
  observe(evidence: KimiBatchEvidence) {
    this.latest = freezeEvidence(evidence)
  }
  fail(error: unknown, classification?: CompletionFailureClassification) {
    if (this.underlying) return
    this.failureEvidence = this.latest
    this.underlying =
      error instanceof Error ? error : new KimiError('kimi_sink_failed')
    this.classification =
      classification ??
      (this.latest.phase === 'acknowledged'
        ? error instanceof KimiError && error.code === 'kimi_history_deadline'
          ? 'publication_deadline'
          : 'publication_failed'
        : this.latest.phase === 'entered'
          ? this.latest.physical === 'rejected'
            ? 'commit_failed'
            : this.latest.physical === 'invalid_ack'
              ? 'invalid_ack'
              : 'logical_deadline'
          : this.latest.phase === 'scheduled'
            ? 'logical_deadline'
            : error instanceof KimiError && error.code === 'kimi_batch_conflict'
              ? 'batch_conflict'
              : error instanceof KimiError &&
                  ['kimi_history_deadline', 'kimi_deadline'].includes(
                    error.code,
                  )
                ? 'logical_deadline'
                : error instanceof KimiError &&
                    ['kimi_owner_sealed', 'kimi_generation_retired'].includes(
                      error.code,
                    )
                  ? 'writer_closed'
                  : 'admission_failed')
  }
  get owner(): PersistenceCauseOwner {
    const root = this.roots.length === 1 ? this.roots[0] : undefined
    return root
      ? {
          kind: 'operation',
          sessionId: this.scope.sessionId,
          runtimeGeneration: this.scope.runtimeGeneration,
          runId: root.runId,
          turnId: root.turnId,
          operationId: root.operationId,
          ...(root.childId ? { childId: root.childId } : {}),
        }
      : {
          kind: 'session',
          sessionId: this.scope.sessionId,
          runtimeGeneration: this.scope.runtimeGeneration,
        }
  }
  close() {
    this.input = undefined
    this.releaseInput?.()
    this.releaseInput = undefined
    this.release()
  }
}

export function validateKimiAcknowledgement(
  value: unknown,
  expectedOrdinal: number,
  replayOnly: boolean,
) {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new KimiError('kimi_sink_ack_shape')
  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== 2 ||
    !keys.includes('ordinal') ||
    !keys.includes('disposition')
  )
    throw new KimiError('kimi_sink_ack_shape')
  const ordinal = Object.getOwnPropertyDescriptor(value, 'ordinal'),
    disposition = Object.getOwnPropertyDescriptor(value, 'disposition')
  if (
    !ordinal ||
    !disposition ||
    !('value' in ordinal) ||
    !('value' in disposition) ||
    !ordinal.enumerable ||
    !disposition.enumerable
  )
    throw new KimiError('kimi_sink_ack_shape')
  if (
    !Number.isSafeInteger(ordinal.value) ||
    ordinal.value < 1 ||
    !['replayed', 'committed'].includes(disposition.value)
  )
    throw new KimiError('kimi_sink_ordinal')
  if (
    disposition.value === 'replayed'
      ? ordinal.value > expectedOrdinal
      : replayOnly ||
        expectedOrdinal >= Number.MAX_SAFE_INTEGER ||
        ordinal.value !== expectedOrdinal + 1
  )
    throw new KimiError('kimi_sink_ordinal')
  return {
    ordinal: ordinal.value as number,
    disposition: disposition.value as 'committed' | 'replayed',
  }
}

export class KimiCompletionPersistenceError
  extends Error
  implements CompletionPersistenceFailure
{
  declare readonly code: CompletionFailureProjection['code']
  declare readonly completionId: string
  declare readonly runId: string
  declare readonly turnId: string
  declare readonly persistence: CompletionFailureProjection
  readonly underlying: Error
  constructor(
    readonly identity: CompletionFailureIdentity,
    readonly completionOwner: KimiRoot,
    readonly failureAttempt: KimiCommitAttempt,
    readonly terminalAttempt: KimiCommitAttempt,
    private readonly required: (
      historical?: boolean,
    ) => RequiredTerminalEvidence,
  ) {
    super('Completion persistence failed')
    if (
      failureAttempt.scope !== terminalAttempt.scope ||
      failureAttempt.scope.sessionId !== identity.sessionId ||
      completionOwner.runId !== identity.runId ||
      completionOwner.turnId !== identity.turnId
    )
      throw new KimiError('kimi_completion_owner')
    const original = failureAttempt.cause ?? failureAttempt
    this.underlying =
      original.underlying ?? new KimiError('kimi_completion_persistence')
    const coverage = required(true)
    const owner = original.owner
    const relation =
      owner.kind === 'operation' &&
      owner.operationId === completionOwner.operationId &&
      owner.runId === completionOwner.runId &&
      owner.turnId === completionOwner.turnId
        ? 'own_required_write'
        : 'session_fence'
    const projection = completionFailureProjectionSchema.parse({
      ...identity,
      version: 1,
      code:
        coverage.state === 'committed'
          ? 'completion_publication_failed'
          : coverage.state === 'unproved'
            ? 'persistence_unknown'
            : 'completion_not_committed',
      classification: original.classification ?? 'admission_failed',
      cause: { relation, owner },
      failure: original.failureEvidence ?? original.latest,
      required: coverage,
    })
    for (const [key, value] of Object.entries({
      code: projection.code,
      completionId: identity.completionId,
      runId: identity.runId,
      turnId: identity.turnId,
      persistence: projection,
    }))
      Object.defineProperty(this, key, {
        value,
        enumerable: true,
        writable: false,
        configurable: false,
      })
  }
  recovery() {
    const original = this.failureAttempt.cause ?? this.failureAttempt
    return completionRecoveryProjectionSchema.parse({
      ...this.identity,
      version: 1,
      state: 'unresolved',
      cause: this.persistence.cause,
      failure: original.latest,
      required: this.required(),
    })
  }
}
