import { z } from 'zod'

const id = z.string().min(1)
export const adapterKindSchema = z.enum(['native', 'acp', 'pty', 'custom'])
export type AdapterKind = z.infer<typeof adapterKindSchema>
export const harnessCapabilitySchema = z.object({
  loadSession: z.boolean(),
  steer: z.boolean(),
  queue: z.boolean(),
  cancel: z.boolean(),
  permissions: z.boolean(),
  questions: z.boolean(),
  models: z.boolean(),
})
export type HarnessCapabilities = z.infer<typeof harnessCapabilitySchema>
export const nativeBindingSchema = z.object({
  provider: id,
  accountId: id.nullable(),
  cwd: z.string(),
  providerSessionId: id.nullable(),
})
export type NativeBinding = z.infer<typeof nativeBindingSchema>
// Adapters confirm the native session identity and canonical cwd before publication.
export const confirmedNativeBindingSchema = nativeBindingSchema
  .extend({ cwd: id, providerSessionId: id })
  .readonly()
export type ConfirmedNativeBinding = z.infer<
  typeof confirmedNativeBindingSchema
>
export const modelOptionsSchema = z.object({
  model: z.string().nullable().optional(),
  reasoning: z.string().nullable().optional(),
  nativeModelParams: z
    .array(
      z.strictObject({
        id: z
          .string()
          .min(1)
          .max(128)
          .refine((value) => new TextEncoder().encode(value).byteLength <= 128),
        value: z
          .string()
          .max(256)
          .refine((value) => new TextEncoder().encode(value).byteLength <= 256),
      }),
    )
    .max(32)
    .refine(
      (values) =>
        new Set(values.map((value) => value.id)).size === values.length,
    )
    .optional(),
  permissionMode: z.enum(['manual', 'auto', 'yolo']).optional(),
})
export type ModelOptions = z.infer<typeof modelOptionsSchema>
// Codex AskForApproval and SandboxPolicy variants retain explicit restrictions.
export const approvalPolicySchema = z.union([
  z.enum(['untrusted', 'on-request', 'always', 'never']),
  z.strictObject({
    granular: z.strictObject({
      sandbox_approval: z.boolean(),
      rules: z.boolean(),
      mcp_elicitations: z.boolean(),
      request_permissions: z.boolean().optional(),
      skill_approval: z.boolean().optional(),
    }),
  }),
])
export const sandboxPolicySchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('dangerFullAccess') }),
  z.strictObject({
    type: z.literal('readOnly'),
    networkAccess: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal('workspaceWrite'),
    writableRoots: z.array(z.string()).optional(),
    networkAccess: z.boolean().optional(),
    excludeSlashTmp: z.boolean().optional(),
    excludeTmpdirEnvVar: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal('externalSandbox'),
    networkAccess: z.enum(['restricted', 'enabled']).optional(),
  }),
])
export const dispatchOptionsSchema = modelOptionsSchema.extend({
  permissionMode: z.enum(['manual', 'auto', 'yolo']).default('manual'),
  approvalPolicy: approvalPolicySchema.nullish(),
  sandboxPolicy: sandboxPolicySchema.nullish(),
  serviceTier: z.string().nullish(),
})
export type DispatchOptions = z.infer<typeof dispatchOptionsSchema>
export const promptInputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('attachment'),
    attachmentId: id,
    mime: z.string(),
  }),
  z.object({
    type: z.literal('review_reference'),
    url: z.string().url(),
    title: z.string().optional(),
  }),
])
export type PromptInput = z.infer<typeof promptInputSchema>
const fileSystemSpecialPathSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.enum(['root', 'minimal', 'tmpdir', 'slash_tmp']) }),
  z.strictObject({
    kind: z.literal('project_roots'),
    subpath: z.string().nullish(),
  }),
  z.strictObject({
    kind: z.literal('unknown'),
    path: z.string(),
    subpath: z.string().nullish(),
  }),
])
export const fileSystemPathSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('path'), path: z.string() }),
  z.strictObject({ type: z.literal('glob_pattern'), pattern: z.string() }),
  z.strictObject({
    type: z.literal('special'),
    value: fileSystemSpecialPathSchema,
  }),
])
// Unknown grant fields must fail instead of silently losing a restriction.
export const permissionProfileSchema = z.strictObject({
  network: z.strictObject({ enabled: z.boolean().nullish() }).nullish(),
  fileSystem: z
    .strictObject({
      entries: z
        .array(
          z.strictObject({
            path: fileSystemPathSchema,
            access: z.enum(['read', 'write', 'deny']),
          }),
        )
        .nullish(),
      globScanMaxDepth: z.number().int().positive().nullish(),
      read: z.array(z.string()).nullish(),
      write: z.array(z.string()).nullish(),
    })
    .nullish(),
})
export type PermissionProfile = z.infer<typeof permissionProfileSchema>
export const permissionGrantScopeSchema = z.enum(['turn', 'session'])
export const permissionRequestSchema = z.object({
  requestId: id,
  toolCallId: id.nullable(),
  title: z.string(),
  detail: z.string().optional(),
  options: z.array(z.object({ id, label: z.string() })),
  permissions: permissionProfileSchema.optional(),
  scope: permissionGrantScopeSchema.optional(),
  approvalId: id.optional(),
  kind: z.string().optional(),
})
export type PermissionRequest = z.infer<typeof permissionRequestSchema>
export const permissionReplySchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('selected'),
    requestId: id,
    optionId: id,
    grant: permissionProfileSchema.optional(),
    scope: permissionGrantScopeSchema.optional(),
  }),
  z.object({
    type: z.literal('granted'),
    requestId: id,
    permissions: permissionProfileSchema,
    scope: permissionGrantScopeSchema,
    strictAutoReview: z.boolean().nullish(),
  }),
  z.object({
    type: z.literal('denied'),
    requestId: id,
    reason: z.string().optional(),
  }),
])
export type PermissionReply = z.infer<typeof permissionReplySchema>
export const questionAnswerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('selected'), optionIds: z.array(id) }),
  z.object({ type: z.literal('free_text'), text: z.string() }),
  z.object({
    type: z.literal('selected_with_text'),
    optionIds: z.array(id),
    text: z.string(),
  }),
  z.object({ type: z.literal('skipped') }),
])
export type QuestionAnswer = z.infer<typeof questionAnswerSchema>
const question = z.object({
  id,
  header: z.string().optional(),
  question: z.string(),
  options: z.array(
    z.object({
      id,
      label: z.string(),
      description: z.string().optional(),
      preview: z
        .string()
        .max(65536)
        .refine((value) => boundedUtf8Length(value, 65536) <= 65536)
        .optional(),
    }),
  ),
  multiSelect: z.boolean().default(false),
  allowFreeInput: z.boolean().default(false),
  isSecret: z.boolean().optional(),
})
export const questionRequestSchema = z.object({
  requestId: id,
  isBlocking: z.boolean().optional(),
  questions: z.array(question),
})
export type QuestionRequest = z.infer<typeof questionRequestSchema>
const failedOutcomeSchema = z.object({
  status: z.literal('failed'),
  code: z.string(),
  message: z.string(),
})
export const terminalOutcomeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('completed') }),
  z.object({ status: z.literal('interrupted'), reason: z.string().optional() }),
  failedOutcomeSchema,
])
export type TerminalOutcome = z.infer<typeof terminalOutcomeSchema>
export const completionResultSchema = terminalOutcomeSchema.and(
  z.object({ runId: id, turnId: id }),
)
export type CompletionResult = z.infer<typeof completionResultSchema>

// Completion persistence has a separate failure channel. Ordinary terminal results stay unchanged.
export function completionProjectionPreflight(
  value: unknown,
  maximum = 16384,
  nodeLimit = 256,
  depthLimit = 12,
) {
  let bytes = 0,
    nodes = 0
  const ancestors = new Set<object>()
  const string = (text: string) => {
    bytes += 2
    for (const character of text) {
      const code = character.codePointAt(0)!
      if (code >= 0xd800 && code <= 0xdfff)
        throw new Error('Invalid completion text')
      bytes +=
        code < 32
          ? [8, 9, 10, 12, 13].includes(code)
            ? 2
            : 6
          : character === '"' || character === '\\'
            ? 2
            : code < 128
              ? 1
              : code < 2048
                ? 2
                : code < 65536
                  ? 3
                  : 4
      if (bytes > maximum) throw new Error('Completion projection byte limit')
    }
  }
  const visit = (entry: unknown, depth: number) => {
    if (++nodes > nodeLimit || depth > depthLimit)
      throw new Error('Completion projection tree limit')
    if (typeof entry === 'string') string(entry)
    else if (typeof entry === 'boolean') bytes += entry ? 4 : 5
    else if (
      typeof entry === 'number' &&
      Number.isSafeInteger(entry) &&
      entry >= 0
    )
      bytes += String(entry).length
    else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const prototype = Object.getPrototypeOf(entry)
      if (
        (prototype !== Object.prototype && prototype !== null) ||
        ancestors.has(entry)
      )
        throw new Error('Invalid completion projection record')
      ancestors.add(entry)
      const keys = Reflect.ownKeys(entry)
      if (keys.length > nodeLimit - nodes)
        throw new Error('Completion projection node limit')
      bytes += 2
      for (const [index, key] of keys.entries()) {
        if (typeof key !== 'string')
          throw new Error('Completion projection symbol')
        const descriptor = Object.getOwnPropertyDescriptor(entry, key)!
        if (!('value' in descriptor) || !descriptor.enumerable)
          throw new Error('Completion projection accessor')
        if (++nodes > nodeLimit)
          throw new Error('Completion projection node limit')
        if (index) bytes++
        string(key)
        bytes++
        visit(descriptor.value, depth + 1)
      }
      ancestors.delete(entry)
    } else throw new Error('Invalid completion projection value')
    if (bytes > maximum) throw new Error('Completion projection byte limit')
  }
  visit(value, 0)
  return bytes
}
export const completionIdentityIdSchema = z.string().refine((value) => {
  let bytes = 0
  for (const character of value) {
    const code = character.codePointAt(0)!
    if (
      code < 32 ||
      (code >= 127 && code <= 159) ||
      (code >= 0xd800 && code <= 0xdfff)
    )
      return false
    bytes += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4
    if (bytes > 512) return false
  }
  return bytes > 0
}, 'Invalid completion identity')
const persistenceHash = z.string().regex(/^[0-9a-f]{64}$/)
const persistenceCount = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
const persistenceOrdinal = persistenceCount.refine((value) => value > 0)
const completionIdentityFields = {
  sessionId: completionIdentityIdSchema,
  receiptId: completionIdentityIdSchema,
  completionId: completionIdentityIdSchema,
  runId: completionIdentityIdSchema,
  turnId: completionIdentityIdSchema,
}
export const completionFailureIdentitySchema = z
  .strictObject(completionIdentityFields)
  .readonly()
export type CompletionFailureIdentity = z.infer<
  typeof completionFailureIdentitySchema
>
export const completionFailureCodeSchema = z.enum([
  'persistence_unknown',
  'completion_not_committed',
  'completion_publication_failed',
])
export type CompletionFailureCode = z.infer<typeof completionFailureCodeSchema>
export const completionFailureClassificationSchema = z.enum([
  'admission_failed',
  'writer_closed',
  'logical_deadline',
  'ack_unknown',
  'commit_failed',
  'invalid_ack',
  'batch_conflict',
  'prefix_conflict',
  'publication_deadline',
  'publication_failed',
])
export type CompletionFailureClassification = z.infer<
  typeof completionFailureClassificationSchema
>
export const persistenceCauseOwnerSchema = z.union([
  z
    .strictObject({
      kind: z.literal('operation'),
      sessionId: completionIdentityIdSchema,
      runtimeGeneration: completionIdentityIdSchema,
      runId: completionIdentityIdSchema,
      turnId: completionIdentityIdSchema,
      operationId: completionIdentityIdSchema.optional(),
      childId: completionIdentityIdSchema.optional(),
    })
    .readonly(),
  z
    .strictObject({
      kind: z.literal('session'),
      sessionId: completionIdentityIdSchema,
      runtimeGeneration: completionIdentityIdSchema,
    })
    .readonly(),
])
export type PersistenceCauseOwner = z.infer<typeof persistenceCauseOwnerSchema>
const persistenceCauseSchema = z
  .strictObject({
    relation: z.enum(['own_required_write', 'session_fence']),
    owner: persistenceCauseOwnerSchema,
  })
  .readonly()
export const batchPositionSchema = z
  .strictObject({ kind: z.literal('batch_ordinal'), ordinal: persistenceCount })
  .readonly()
export type BatchPosition = z.infer<typeof batchPositionSchema>
export const journalPositionSchema = z
  .strictObject({
    kind: z.literal('journal_prefix'),
    throughOrdinal: persistenceCount,
    prefixHash: persistenceHash,
  })
  .readonly()
export type JournalPosition = z.infer<typeof journalPositionSchema>
const batchKeySchema = z
  .strictObject({ batchId: persistenceHash, contentHash: persistenceHash })
  .readonly()
const batchInputSchema = z
  .strictObject({ expectedOrdinal: persistenceCount, replayOnly: z.boolean() })
  .readonly()
export const publicationFactsSchema = z
  .strictObject({
    state: z.enum(['not_started', 'stopped', 'complete', 'not_republished']),
    totalEvents: persistenceCount.max(65536),
    attemptedEvents: persistenceCount.max(65536),
    returnedEvents: persistenceCount.max(65536),
  })
  .refine(
    (value) =>
      value.returnedEvents <= value.attemptedEvents &&
      value.attemptedEvents <= value.totalEvents &&
      value.attemptedEvents - value.returnedEvents <= 1 &&
      (!(value.state === 'not_started' || value.state === 'not_republished') ||
        value.attemptedEvents === 0) &&
      (value.state !== 'complete' ||
        value.returnedEvents === value.totalEvents),
  )
  .readonly()
export type PublicationFacts = z.infer<typeof publicationFactsSchema>
const batchBase = {
  kind: z.literal('batch_ordinal'),
  lastAcknowledged: batchPositionSchema,
}
const journalBase = {
  kind: z.literal('journal_prefix'),
  journalId: completionIdentityIdSchema,
  lastAcknowledged: journalPositionSchema,
}
const physicalResult = z.enum(['pending', 'rejected', 'invalid_ack'])
const journalTransactionSchema = z
  .strictObject({
    transactionId: persistenceHash,
    contentHash: persistenceHash,
    fromOrdinal: persistenceOrdinal,
    throughOrdinal: persistenceOrdinal,
  })
  .readonly()
const invocationSchema = z.union([z.literal(1), z.literal(2)])
const batchPendingSchema = z.union([
  z
    .strictObject({ ...batchBase, phase: z.literal('pre_admission') })
    .readonly(),
  z
    .strictObject({
      ...batchBase,
      phase: z.literal('constructed'),
      batch: batchKeySchema,
    })
    .readonly(),
  z
    .strictObject({
      ...batchBase,
      phase: z.literal('prepared'),
      batch: batchKeySchema,
      input: batchInputSchema,
    })
    .readonly(),
  z
    .strictObject({
      ...batchBase,
      phase: z.literal('scheduled'),
      batch: batchKeySchema,
      input: batchInputSchema,
      physical: z.literal('pending'),
    })
    .readonly(),
  z
    .strictObject({
      ...batchBase,
      phase: z.literal('entered'),
      batch: batchKeySchema,
      input: batchInputSchema,
      physical: physicalResult,
    })
    .readonly(),
])
const batchAcknowledgedSchema = z.union([
  z
    .strictObject({
      ...batchBase,
      phase: z.literal('acknowledged'),
      batch: batchKeySchema,
      input: batchInputSchema,
      acknowledgement: z
        .strictObject({
          via: z.literal('sink'),
          disposition: z.enum(['committed', 'replayed']),
          ordinal: persistenceOrdinal,
        })
        .readonly(),
      publication: publicationFactsSchema,
    })
    .readonly(),
  z
    .strictObject({
      ...batchBase,
      phase: z.literal('acknowledged'),
      batch: batchKeySchema,
      acknowledgement: z
        .strictObject({
          via: z.literal('local_cache'),
          ordinal: persistenceOrdinal,
        })
        .readonly(),
      publication: publicationFactsSchema,
    })
    .readonly(),
])
const journalPendingSchema = z.union([
  z
    .strictObject({ ...journalBase, phase: z.literal('pre_admission') })
    .readonly(),
  z
    .strictObject({
      ...journalBase,
      phase: z.literal('constructed'),
      transaction: journalTransactionSchema,
    })
    .readonly(),
  z
    .strictObject({
      ...journalBase,
      phase: z.literal('prepared'),
      transaction: journalTransactionSchema,
      invocation: invocationSchema,
    })
    .readonly(),
  z
    .strictObject({
      ...journalBase,
      phase: z.literal('scheduled'),
      transaction: journalTransactionSchema,
      invocation: invocationSchema,
      physical: z.literal('pending'),
    })
    .readonly(),
  z
    .strictObject({
      ...journalBase,
      phase: z.literal('entered'),
      transaction: journalTransactionSchema,
      invocation: invocationSchema,
      physical: physicalResult,
    })
    .readonly(),
])
const journalAcknowledgedSchema = z
  .strictObject({
    ...journalBase,
    phase: z.literal('acknowledged'),
    transaction: journalTransactionSchema,
    invocation: invocationSchema,
    acknowledgement: z
      .strictObject({
        transactionId: persistenceHash,
        throughOrdinal: persistenceOrdinal,
        prefixHash: persistenceHash,
      })
      .readonly(),
    publication: publicationFactsSchema,
  })
  .readonly()
const evidenceSchema = z
  .union([
    batchPendingSchema,
    batchAcknowledgedSchema,
    journalPendingSchema,
    journalAcknowledgedSchema,
  ])
  .refine((value) => {
    if (value.kind === 'batch_ordinal') {
      if (
        'input' in value &&
        value.input.expectedOrdinal !== value.lastAcknowledged.ordinal
      )
        return false
      if (value.phase !== 'acknowledged') return true
      const ack = value.acknowledgement
      if (ack.via === 'local_cache')
        return (
          ack.ordinal <= value.lastAcknowledged.ordinal &&
          value.publication.state === 'not_republished'
        )
      if (!('input' in value)) return false
      if (ack.disposition === 'replayed')
        return (
          ack.ordinal <= value.input.expectedOrdinal &&
          value.publication.state === 'not_republished'
        )
      return (
        !value.input.replayOnly &&
        value.input.expectedOrdinal < Number.MAX_SAFE_INTEGER &&
        ack.ordinal === value.input.expectedOrdinal + 1
      )
    }
    if (
      'transaction' in value &&
      (value.lastAcknowledged.throughOrdinal === Number.MAX_SAFE_INTEGER ||
        value.transaction.fromOrdinal !==
          value.lastAcknowledged.throughOrdinal + 1 ||
        value.transaction.throughOrdinal < value.transaction.fromOrdinal)
    )
      return false
    return (
      value.phase !== 'acknowledged' ||
      (value.acknowledgement.transactionId ===
        value.transaction.transactionId &&
        value.acknowledgement.throughOrdinal ===
          value.transaction.throughOrdinal)
    )
  })
export type CommitEvidence = z.infer<typeof evidenceSchema>
export type BatchPendingEvidence = z.infer<typeof batchPendingSchema>
export type BatchAcknowledgedEvidence = z.infer<typeof batchAcknowledgedSchema>
export type JournalPendingEvidence = z.infer<typeof journalPendingSchema>
export type JournalAcknowledgedEvidence = z.infer<
  typeof journalAcknowledgedSchema
>
export type AcknowledgedEvidence =
  BatchAcknowledgedEvidence | JournalAcknowledgedEvidence
const requiredTerminalSchema = z.union([
  z
    .strictObject({
      state: z.enum(['not_committed', 'unproved']),
      terminal: evidenceSchema,
    })
    .readonly(),
  z
    .strictObject({
      state: z.literal('committed'),
      terminal: evidenceSchema.refine(
        (value) => value.phase === 'acknowledged',
      ),
      sealedThrough: z.union([batchPositionSchema, journalPositionSchema]),
    })
    .readonly(),
])
export type RequiredTerminalEvidence = z.infer<typeof requiredTerminalSchema>
const completionEvidenceFields = {
  ...completionIdentityFields,
  version: z.literal(1),
  cause: persistenceCauseSchema,
  failure: evidenceSchema,
  required: requiredTerminalSchema,
}
function validCompletionEvidence(value: {
  sessionId: string
  runId: string
  turnId: string
  cause: z.infer<typeof persistenceCauseSchema>
  failure: CommitEvidence
  required: RequiredTerminalEvidence
}) {
  const { failure, required, cause } = value,
    terminal = required.terminal
  if (
    cause.owner.sessionId !== value.sessionId ||
    (cause.relation === 'own_required_write' &&
      cause.owner.kind === 'operation' &&
      (cause.owner.runId !== value.runId ||
        cause.owner.turnId !== value.turnId))
  )
    return false
  if (failure.kind !== terminal.kind) return false
  if (
    failure.kind === 'batch_ordinal' &&
    terminal.kind === 'batch_ordinal' &&
    'batch' in failure &&
    'batch' in terminal &&
    failure.batch.batchId === terminal.batch.batchId &&
    failure.batch.contentHash !== terminal.batch.contentHash
  )
    return false
  if (failure.kind === 'journal_prefix' && terminal.kind === 'journal_prefix') {
    if (failure.journalId !== terminal.journalId) return false
    if (
      'transaction' in failure &&
      'transaction' in terminal &&
      failure.transaction.transactionId ===
        terminal.transaction.transactionId &&
      (failure.transaction.contentHash !== terminal.transaction.contentHash ||
        failure.transaction.fromOrdinal !== terminal.transaction.fromOrdinal ||
        failure.transaction.throughOrdinal !==
          terminal.transaction.throughOrdinal)
    )
      return false
  }
  const pending = [failure, terminal].some(
    (entry) => entry.phase === 'scheduled' || entry.phase === 'entered',
  )
  if (required.state === 'unproved') return pending
  if (pending) return false
  // The causal write and terminal can both be acknowledged while a separately
  // retained admitted prerequisite did not commit. These slots are not a log
  // of every required write. The private owner validates aggregate coverage.
  if (required.state === 'not_committed') return true
  if (required.state !== 'committed') return false
  if (
    terminal.phase !== 'acknowledged' ||
    terminal.kind !== required.sealedThrough.kind
  )
    return false
  if (
    terminal.kind === 'batch_ordinal' &&
    required.sealedThrough.kind === 'batch_ordinal'
  )
    return required.sealedThrough.ordinal >= terminal.acknowledgement.ordinal
  if (
    terminal.kind === 'journal_prefix' &&
    required.sealedThrough.kind === 'journal_prefix'
  )
    return (
      required.sealedThrough.throughOrdinal >=
        terminal.acknowledgement.throughOrdinal &&
      (required.sealedThrough.throughOrdinal !==
        terminal.acknowledgement.throughOrdinal ||
        required.sealedThrough.prefixHash ===
          terminal.acknowledgement.prefixHash)
    )
  return false
}
function boundedCompletion<T extends z.ZodType>(schema: T, maximum = 16384) {
  return z.preprocess((value, context) => {
    try {
      completionProjectionPreflight(
        value,
        maximum,
        maximum > 16384 ? 512 : 256,
        maximum > 16384 ? 13 : 12,
      )
      return value
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'Invalid bounded completion projection',
      })
      return z.NEVER
    }
  }, schema)
}
export const completionFailureProjectionSchema = boundedCompletion(
  z
    .strictObject({
      ...completionEvidenceFields,
      code: completionFailureCodeSchema,
      classification: completionFailureClassificationSchema,
      requestId: completionIdentityIdSchema.optional(),
    })
    .refine((value) => {
      if (!validCompletionEvidence(value)) return false
      if (
        value.code !==
        (
          {
            unproved: 'persistence_unknown',
            not_committed: 'completion_not_committed',
            committed: 'completion_publication_failed',
          } as const
        )[value.required.state]
      )
        return false
      const evidence = value.failure,
        phase = evidence.phase
      if (
        value.code === 'completion_publication_failed' &&
        !['publication_deadline', 'publication_failed'].includes(
          value.classification,
        )
      )
        return false
      switch (value.classification) {
        case 'admission_failed':
        case 'writer_closed':
          return ['pre_admission', 'constructed', 'prepared'].includes(phase)
        case 'logical_deadline':
          return phase !== 'acknowledged'
        case 'ack_unknown':
          return (
            (phase === 'scheduled' || phase === 'entered') &&
            evidence.physical === 'pending'
          )
        case 'commit_failed':
          return phase === 'entered' && evidence.physical === 'rejected'
        case 'invalid_ack':
          return phase === 'entered' && evidence.physical === 'invalid_ack'
        case 'batch_conflict':
        case 'prefix_conflict':
          return (
            evidence.kind ===
              (value.classification === 'batch_conflict'
                ? 'batch_ordinal'
                : 'journal_prefix') &&
            (phase === 'constructed' ||
              phase === 'prepared' ||
              (phase === 'entered' && evidence.physical !== 'pending'))
          )
        case 'publication_deadline':
        case 'publication_failed':
          return (
            phase === 'acknowledged' && evidence.publication.state === 'stopped'
          )
      }
    })
    .readonly(),
)
export type CompletionFailureProjection = z.infer<
  typeof completionFailureProjectionSchema
>
export const completionRecoveryProjectionSchema = boundedCompletion(
  z
    .strictObject({
      ...completionEvidenceFields,
      state: z.enum(['unresolved', 'evidence_verified', 'reconciled']),
    })
    .refine(
      (value) =>
        validCompletionEvidence(value) &&
        (value.state === 'unresolved' || value.required.state === 'committed'),
    )
    .readonly(),
)
export type CompletionRecoveryProjection = z.infer<
  typeof completionRecoveryProjectionSchema
>
export const completionFailureEnvelopeSchema = boundedCompletion(
  z
    .strictObject({
      error: completionFailureProjectionSchema,
      recovery: completionRecoveryProjectionSchema.optional(),
    })
    .refine(
      ({ error, recovery }) =>
        !recovery ||
        ((
          ['sessionId', 'receiptId', 'completionId', 'runId', 'turnId'] as const
        ).every((field) => error[field] === recovery[field]) &&
          error.failure.kind === recovery.failure.kind),
    )
    .readonly(),
  33792,
)
const envelope = {
  runId: id,
  runtimeGeneration: id,
  deliveryId: id,
  providerRunId: id.optional(),
  providerTurnId: id.optional(),
  providerItemId: id.optional(),
}
// Child-owned items retain their spawning root run and turn. The child is the owner.
const turnItem = { ...envelope, turnId: id, itemId: id, childId: id.optional() }
const utf8Encoder = new TextEncoder()
// Limit UTF-16 length before encoding to bound the temporary allocation.
const boundedUtf8Length = (value: string, limit: number): number =>
  value.length > limit ? limit + 1 : utf8Encoder.encode(value).byteLength
const utf8String = (limit: number) =>
  z.string().refine((value) => boundedUtf8Length(value, limit) <= limit, {
    message: `Text must contain at most ${limit} UTF-8 bytes`,
  })
export const sourceReferenceSchema = z.strictObject({
  artifactId: utf8String(512).min(1),
  mime: utf8String(256).min(1),
  bytes: z
    .number()
    .int()
    .nonnegative()
    .max(1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
})
export type SourceReference = z.infer<typeof sourceReferenceSchema>
// Public wire ceilings. Providers can impose smaller retained-state limits.
const contentSnapshotFields = {
  ...turnItem,
  type: z.literal('content_snapshot'),
  sourceRef: sourceReferenceSchema.optional(),
  text: utf8String(4 * 1024 * 1024),
}
const textMetadataBytes = 1024 * 1024
const inlineQuestionsSchema = z.preprocess(
  (value, ctx) => {
    if (!Array.isArray(value)) return value
    const fail = (message: string) => {
      ctx.addIssue({ code: 'custom', message })
      return z.NEVER
    }
    if (value.length > 64)
      return fail('Text metadata accepts at most 64 questions')
    for (const question of value) {
      if (
        question &&
        typeof question === 'object' &&
        Array.isArray(question.options) &&
        question.options.length > 128
      )
        return fail('Text metadata accepts at most 128 options per question')
    }
    let bytes = 0
    const add = (text: unknown) => {
      if (typeof text !== 'string') return true
      const limit = Math.min(64 * 1024, textMetadataBytes - bytes)
      const size = boundedUtf8Length(text, limit)
      bytes += size
      return size <= limit
    }
    for (const question of value) {
      if (!question || typeof question !== 'object') continue
      if (!add(question.title)) return fail('Text metadata byte limit exceeded')
      if (Array.isArray(question.options))
        for (const option of question.options)
          if (!add(option)) return fail('Text metadata byte limit exceeded')
    }
    return value
  },
  z
    .array(
      z.strictObject({
        title: utf8String(64 * 1024),
        options: z
          .array(utf8String(64 * 1024))
          .max(128)
          .nullish(),
      }),
    )
    .max(64)
    .nullish(),
)
// Snapshots replace the same scoped item and content type, including empty text.
// Omitted metadata preserves prior values; explicit null clears them.
// Adapters and the display projection must keep item roles and child owners stable.
// Snapshots do not settle turns or children. Completion needs a terminal event.
const contentSnapshotSchema = z.discriminatedUnion('contentType', [
  z
    .strictObject({
      ...contentSnapshotFields,
      contentType: z.literal('text'),
      // Omitted means assistant, without adding a serialized default.
      role: z.enum(['user', 'assistant']).optional(),
      phase: z.enum(['commentary', 'final_answer']).nullish(),
      delivery: z.literal('async').nullish(),
      // Inline metadata has no request identity, blocking state, or reply callback.
      questions: inlineQuestionsSchema,
    })
    .superRefine((snapshot, ctx) => {
      let bytes = 0
      const add = (value: string | null | undefined) => {
        if (value != null && bytes <= textMetadataBytes)
          bytes += boundedUtf8Length(value, textMetadataBytes - bytes)
      }
      add(snapshot.role)
      add(snapshot.phase)
      add(snapshot.delivery)
      for (const question of snapshot.questions ?? []) {
        add(question.title)
        for (const option of question.options ?? []) add(option)
        if (bytes > textMetadataBytes) break
      }
      if (bytes > textMetadataBytes)
        ctx.addIssue({
          code: 'custom',
          message: `Text metadata must contain at most ${textMetadataBytes} UTF-8 bytes`,
        })
    }),
  z.strictObject({
    ...contentSnapshotFields,
    contentType: z.enum(['thought', 'plan']),
  }),
])
// Zod integers are safe integers. Missing counters must remain absent.
const tokenCount = z.number().int().nonnegative()
const usageCounts = {
  inputTokens: tokenCount,
  outputTokens: tokenCount,
  totalTokens: tokenCount,
  cachedInputTokens: tokenCount.optional(),
  cacheWriteInputTokens: tokenCount.optional(),
  reasoningOutputTokens: tokenCount.optional(),
}
const artifactFields = {
  artifactId: utf8String(512).min(1),
  mime: utf8String(256).min(1),
  bytes: tokenCount.max(10 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}
const neutralContentBlockSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.enum(['image', 'audio']), ...artifactFields }),
  z.strictObject({
    kind: z.literal('artifact_resource'),
    uri: utf8String(4096),
    ...artifactFields,
  }),
  z.strictObject({
    kind: z.literal('text_resource'),
    uri: utf8String(4096),
    mime: utf8String(256).optional(),
    text: utf8String(1024 * 1024),
  }),
  z.strictObject({
    kind: z.literal('resource_link'),
    uri: utf8String(4096),
    name: utf8String(65536),
    title: utf8String(65536).optional(),
    description: utf8String(65536).optional(),
    mime: utf8String(256).optional(),
    size: tokenCount.optional(),
  }),
])
const measurementScopeSchema = z.enum([
  'call',
  'prompt',
  'session',
  'unspecified',
])
const tokenPatchSchema = z
  .strictObject({
    inputTokens: tokenCount.nullish(),
    outputTokens: tokenCount.nullish(),
    totalTokens: tokenCount.nullish(),
    cachedInputTokens: tokenCount.nullish(),
    cacheWriteInputTokens: tokenCount.nullish(),
    reasoningOutputTokens: tokenCount.nullish(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined))
const usageSnapshotSchema = z
  .strictObject({
    ...turnItem,
    type: z.literal('usage_snapshot'),
    measurementId: utf8String(512).min(1),
    responseId: utf8String(512).min(1).optional(),
    inputTokenBasis: z
      .enum(['includes_cache_reads', 'excludes_cache_reads', 'unspecified'])
      .optional(),
    tokenScope: measurementScopeSchema.optional(),
    costScope: measurementScopeSchema.optional(),
    context: z
      .strictObject({
        used: tokenCount.nullish(),
        capacity: tokenCount.nullish(),
      })
      .refine(
        (value) => value.used !== undefined || value.capacity !== undefined,
      )
      .nullish(),
    tokens: tokenPatchSchema.nullish(),
    cost: z
      .strictObject({
        amount: z.number().finite().nonnegative().nullable(),
        currency: utf8String(16).min(1),
      })
      .nullish(),
    sourceRef: sourceReferenceSchema.optional(),
  })
  .refine(
    (value) =>
      (value.context !== undefined ||
        value.tokens !== undefined ||
        value.cost !== undefined) &&
      (value.tokens === undefined || value.tokenScope !== undefined) &&
      (value.cost === undefined || value.costScope !== undefined) &&
      (!value.responseId ||
        value.tokens === undefined ||
        value.inputTokenBasis !== undefined),
  )
const childIdentity = {
  // The Forge tool call that spawned this child, possibly owned by parentChildId.
  parentToolCallId: id.optional(),
  // The provider's agent ID, distinct from its session ID and tool call IDs.
  providerChildId: id.optional(),
  parentChildId: id.optional(),
}
export const harnessEventSchema = z.discriminatedUnion('type', [
  z.object({ ...envelope, type: z.literal('run_started') }),
  z.object({ ...envelope, type: z.literal('turn_started'), turnId: id }),
  z.object({
    ...turnItem,
    type: z.literal('text_delta'),
    sourceRef: sourceReferenceSchema.optional(),
    text: z.string(),
    // Omitted means assistant. Keep role and owner stable across one item's deltas.
    role: z.enum(['user', 'assistant']).optional(),
  }),
  z.object({
    ...turnItem,
    type: z.literal('thought_delta'),
    text: z.string(),
    sourceRef: sourceReferenceSchema.optional(),
  }),
  contentSnapshotSchema,
  z.strictObject({
    ...turnItem,
    type: z.literal('content_block'),
    blockIndex: tokenCount,
    role: z.enum(['user', 'assistant']),
    block: neutralContentBlockSchema,
    sourceRef: sourceReferenceSchema.optional(),
  }),
  z.strictObject({
    ...envelope,
    turnId: id,
    childId: id.optional(),
    type: z.literal('source_reference'),
    subject: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('item'),
        itemId: id,
        responseId: id.optional(),
      }),
      z.strictObject({ kind: z.literal('response'), responseId: id }),
      z.strictObject({
        kind: z.literal('usage'),
        measurementId: id,
        responseId: id.optional(),
      }),
      z.strictObject({
        kind: z.literal('child_interval'),
        childId: id,
        intervalId: id,
      }),
    ]),
    boundary: z.enum(['opened', 'reasoning_closed', 'closed']).optional(),
    sourceRef: sourceReferenceSchema,
  }),
  usageSnapshotSchema,
  // Diagnostics never settle turns or children, regardless of severity or retryability.
  // Producers must redact known secrets before bounding and emitting plain text.
  // Keep startup diagnostics outside the timeline until a real root turn exists.
  z.strictObject({
    ...turnItem,
    type: z.literal('diagnostic'),
    code: utf8String(256).min(1),
    message: utf8String(4096),
    severity: z.enum(['info', 'warning', 'error']),
    retryable: z.boolean().optional(),
    // Retain native uint16 values. Zero does not imply an HTTP meaning.
    httpStatus: tokenCount.max(65535).nullish(),
    // Continuation instructions stay inert text unless the user selects continuation.
    details: utf8String(16 * 1024).nullish(),
  }),
  z.object({
    ...turnItem,
    type: z.literal('tool_started'),
    sourceRef: sourceReferenceSchema.optional(),
    toolCallId: id,
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({
    ...turnItem,
    type: z.literal('tool_update'),
    sourceRef: sourceReferenceSchema.optional(),
    toolCallId: id,
    status: z.string(),
    output: z.unknown().optional(),
  }),
  z.object({
    ...turnItem,
    type: z.literal('child_started'),
    childId: id,
    ...childIdentity,
    description: z.string(),
  }),
  // Metadata can arrive after child_finished. Omitted fields leave prior values intact.
  z.strictObject({
    ...turnItem,
    type: z.literal('child_updated'),
    childId: id,
    ...childIdentity,
  }),
  z.object({
    ...turnItem,
    type: z.literal('child_finished'),
    childId: id,
    outcome: terminalOutcomeSchema,
  }),
  z.strictObject({
    ...turnItem,
    type: z.literal('plan'),
    // Progress steps stay separate from plan prose. Omission preserves explanation; null clears it.
    explanation: utf8String(1024 * 1024).nullish(),
    steps: z.array(
      z.strictObject({
        id,
        title: z.string(),
        status: z.enum(['pending', 'running', 'completed', 'failed']),
      }),
    ),
  }),
  z.object({
    ...turnItem,
    type: z.literal('file_change'),
    path: z.string(),
    kind: z.enum(['created', 'modified', 'deleted']),
  }),
  z.strictObject({
    ...turnItem,
    type: z.literal('usage'),
    // Primary counts describe the latest call. Child usage keeps its own owner.
    ...usageCounts,
    // Cumulative snapshots replace prior totals. Never sum these snapshots.
    cumulative: z.strictObject(usageCounts).optional(),
    modelContextWindow: tokenCount.nullish(),
  }),
  z.object({
    ...turnItem,
    type: z.literal('permission_requested'),
    request: permissionRequestSchema,
  }),
  z.object({
    ...turnItem,
    type: z.literal('question_requested'),
    request: questionRequestSchema,
  }),
  z.object({
    ...turnItem,
    type: z.literal('request_cancelled'),
    requestId: id,
    reason: z.string().optional(),
  }),
  z.object({
    ...envelope,
    type: z.literal('prompt_accepted'),
    turnId: id,
    receiptId: id,
  }),
  z.object({
    ...envelope,
    type: z.literal('steer_accepted'),
    turnId: id,
    receiptId: id,
  }),
  z.object({
    ...envelope,
    type: z.literal('turn_completed'),
    turnId: id,
    outcome: terminalOutcomeSchema,
  }),
  failedOutcomeSchema.omit({ status: true }).extend({
    ...envelope,
    type: z.literal('run_failed'),
  }),
])
export type HarnessEvent = z.infer<typeof harnessEventSchema>
