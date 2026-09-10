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

export const promptInputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('attachment'), attachmentId: id, mime: z.string() }),
  z.object({ type: z.literal('review_reference'), url: z.string().url(), title: z.string().optional() }),
])
export type PromptInput = z.infer<typeof promptInputSchema>

export const permissionRequestSchema = z.object({
  requestId: id,
  toolCallId: id.nullable(),
  title: z.string(),
  detail: z.string().optional(),
  options: z.array(z.object({ id, label: z.string() })),
})
export type PermissionRequest = z.infer<typeof permissionRequestSchema>

export const questionRequestSchema = z.object({
  requestId: id,
  questions: z.array(z.object({
    id,
    header: z.string().optional(),
    question: z.string(),
    options: z.array(z.object({ id, label: z.string(), description: z.string().optional() })),
    multiSelect: z.boolean().default(false),
  })),
})
export type QuestionRequest = z.infer<typeof questionRequestSchema>

export const harnessEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run_started'), runId: id }),
  z.object({ type: z.literal('turn_started'), turnId: id }),
  z.object({ type: z.literal('text_delta'), turnId: id, itemId: id, text: z.string() }),
  z.object({ type: z.literal('thought_delta'), turnId: id, itemId: id, text: z.string() }),
  z.object({ type: z.literal('tool_started'), turnId: id, itemId: id, toolCallId: id, name: z.string(), input: z.unknown() }),
  z.object({ type: z.literal('tool_update'), turnId: id, itemId: id, toolCallId: id, status: z.string(), output: z.unknown().optional() }),
  z.object({ type: z.literal('child_started'), turnId: id, itemId: id, childId: id, description: z.string() }),
  z.object({ type: z.literal('child_finished'), turnId: id, itemId: id, childId: id, status: z.enum(['completed', 'failed']) }),
  z.object({ type: z.literal('plan'), turnId: id, itemId: id, steps: z.array(z.object({ id, title: z.string(), status: z.enum(['pending', 'running', 'completed', 'failed']) })) }),
  z.object({ type: z.literal('file_change'), turnId: id, itemId: id, path: z.string(), kind: z.enum(['created', 'modified', 'deleted']) }),
  z.object({ type: z.literal('usage'), turnId: id, itemId: id, inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), totalTokens: z.number().int().nonnegative() }),
  z.object({ type: z.literal('permission_requested'), turnId: id, itemId: id, request: permissionRequestSchema }),
  z.object({ type: z.literal('question_requested'), turnId: id, itemId: id, request: questionRequestSchema }),
  z.object({ type: z.literal('prompt_accepted'), runId: id, turnId: id, receiptId: id }),
  z.object({ type: z.literal('steer_accepted'), runId: id, turnId: id, receiptId: id }),
  z.object({ type: z.literal('turn_completed'), turnId: id, stopReason: z.string().optional() }),
  z.object({ type: z.literal('run_failed'), runId: id, code: z.string(), message: z.string() }),
])
export type HarnessEvent = z.infer<typeof harnessEventSchema>

