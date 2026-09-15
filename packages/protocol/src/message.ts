import { z } from 'zod'
import { contentSnapshotTextSchema } from './harness.js'

const id = z.string().min(1)
const subagent = z.object({
  id,
  type: id,
  description: z.string(),
  status: z.enum(['running', 'completed', 'failed', 'unknown']),
})
export const MessageContent = z.discriminatedUnion('type', [
  // Native passthrough rows retain provider-neutral event fields. Their
  // detailed validation happens at the harness boundary.
  z
    .object({
      type: z.literal('content_snapshot'),
      contentType: z.enum(['text', 'thought', 'plan']),
      text: contentSnapshotTextSchema,
      childId: id.optional(),
    })
    .catchall(z.unknown()),
  z.object({ type: z.literal('content_block') }).catchall(z.unknown()),
  z.object({ type: z.literal('source_reference') }).catchall(z.unknown()),
  z.object({ type: z.literal('usage') }).catchall(z.unknown()),
  z.object({ type: z.literal('usage_snapshot') }).catchall(z.unknown()),
  z.object({ type: z.literal('file_change') }).catchall(z.unknown()),
  z.object({ type: z.literal('child_updated') }).catchall(z.unknown()),
  z.object({
    type: z.literal('text_delta'),
    text: z.string(),
    childId: id.optional(),
  }),
  z.object({
    type: z.literal('thought_delta'),
    text: z.string(),
    childId: id.optional(),
  }),
  z.object({
    type: z.literal('tool_call'),
    toolCallId: id,
    childId: id.optional(),
    nativeChildId: id.optional(),
    name: id,
    input: z.unknown(),
    subagent: subagent.optional(),
  }),
  z.object({
    type: z.literal('tool_update'),
    toolCallId: id,
    childId: id.optional(),
    nativeChildId: id.optional(),
    status: z.string(),
    output: z.unknown().optional(),
    subagent: subagent.optional(),
  }),
  z.object({
    type: z.literal('tool_result'),
    toolCallId: id,
    childId: id.optional(),
    nativeChildId: id.optional(),
    output: z.unknown(),
    isError: z.boolean().default(false),
    subagent: subagent.optional(),
  }),
  z.object({
    type: z.literal('ask_user_question'),
    questionId: id,
    question: z.string().optional(),
    options: z.array(z.string()).optional(),
    questions: z
      .array(
        z.object({
          id: id.optional(),
          header: z.string().optional(),
          question: z.string(),
          options: z.array(
            z.object({
              id: id.optional(),
              label: z.string(),
              description: z.string().optional(),
            }),
          ),
          multiSelect: z.boolean().optional(),
          allowFreeInput: z.boolean().optional(),
          isSecret: z.boolean().optional(),
        }),
      )
      .optional(),
    source: z.enum(['permission', 'ext']).optional(),
    requestStatus: z
      .enum(['pending', 'replying', 'submitted', 'expired', 'uncertain'])
      .optional(),
    toolName: z.string().optional(),
    toolContext: z.string().optional(),
    permissionScope: z.enum(['once', 'session']).optional(),
  }),
  z.object({
    type: z.literal('user_answer'),
    questionId: id,
    answer: z.string().optional(),
    answers: z.unknown().optional(),
    cancelled: z.boolean().optional(),
    // A request the user never answered ran out of time. That is not the same
    // as a cancellation, and the transcript has to say which one happened.
    expired: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('attachment_ref'),
    attachmentId: id,
    path: z.string(),
    filename: z.string(),
    mime: z.string().optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
  }),
  z.object({ type: z.literal('turn_start') }),
  z.object({ type: z.literal('turn_end'), stopReason: z.string().optional() }),
  z.object({
    type: z.literal('turn_interrupted'),
    reason: z.string().optional(),
    version: z.string().optional(),
  }),
  z.object({
    type: z.literal('error'),
    message: z.string(),
    code: z.string().optional(),
  }),
  z.object({
    type: z.literal('epic_triage'),
    runId: id,
    beadId: id,
    attempts: z.number().int().nonnegative(),
    classification: z.enum(['code', 'infra', 'unknown']),
    failureChain: z.array(
      z.object({
        attempt: z.number().int().positive(),
        signature: id,
        excerpt: z.string(),
      }),
    ),
  }),
  z.object({
    type: z.literal('plan'),
    explanation: z.string().optional(),
    steps: z.array(
      z.object({
        id,
        title: z.string(),
        status: z.enum(['pending', 'running', 'completed', 'failed']),
      }),
    ),
  }),
])
export type MessageContent = z.infer<typeof MessageContent>
export const messageContentTypes = [
  'content_snapshot',
  'content_block',
  'source_reference',
  'usage',
  'usage_snapshot',
  'file_change',
  'child_updated',
  'text_delta',
  'thought_delta',
  'tool_call',
  'tool_update',
  'tool_result',
  'ask_user_question',
  'user_answer',
  'attachment_ref',
  'turn_start',
  'turn_end',
  'turn_interrupted',
  'error',
  'epic_triage',
  'plan',
] as const
export const Message = z.object({
  seq: z.number().int().nonnegative(),
  sessionId: id,
  turnId: id,
  itemId: id,
  role: z.enum(['user', 'agent', 'system']),
  type: z.enum(messageContentTypes),
  content: MessageContent,
  createdAt: z.string(),
})
export type Message = z.infer<typeof Message>

export const NativeChildPage = z.object({
  messages: z.array(Message).max(200),
  cursor: z.number().int().nonnegative(),
  hasMore: z.boolean(),
})
