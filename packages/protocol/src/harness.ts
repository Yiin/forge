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
    z.object({ id, label: z.string(), description: z.string().optional() }),
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
// Public wire ceilings. Providers can impose smaller retained-state limits.
const contentSnapshotFields = {
  ...turnItem,
  type: z.literal('content_snapshot'),
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
    text: z.string(),
    // Omitted means assistant. Keep role and owner stable across one item's deltas.
    role: z.enum(['user', 'assistant']).optional(),
  }),
  z.object({ ...turnItem, type: z.literal('thought_delta'), text: z.string() }),
  contentSnapshotSchema,
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
    toolCallId: id,
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({
    ...turnItem,
    type: z.literal('tool_update'),
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
