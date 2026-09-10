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
const turnItem = { ...envelope, turnId: id, itemId: id }
export const harnessEventSchema = z.discriminatedUnion('type', [
  z.object({ ...envelope, type: z.literal('run_started') }),
  z.object({ ...envelope, type: z.literal('turn_started'), turnId: id }),
  z.object({ ...turnItem, type: z.literal('text_delta'), text: z.string() }),
  z.object({ ...turnItem, type: z.literal('thought_delta'), text: z.string() }),
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
    description: z.string(),
  }),
  z.object({
    ...turnItem,
    type: z.literal('child_finished'),
    childId: id,
    outcome: terminalOutcomeSchema,
  }),
  z.object({
    ...turnItem,
    type: z.literal('plan'),
    steps: z.array(
      z.object({
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
  z.object({
    ...turnItem,
    type: z.literal('usage'),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
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
