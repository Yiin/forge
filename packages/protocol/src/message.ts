import { z } from 'zod'

const id = z.string().min(1)
export const MessageContent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text_delta'), text: z.string() }),
  z.object({ type: z.literal('thought_delta'), text: z.string() }),
  z.object({
    type: z.literal('tool_call'),
    toolCallId: id,
    name: id,
    input: z.unknown(),
  }),
  z.object({
    type: z.literal('tool_update'),
    toolCallId: id,
    status: z.string(),
    output: z.unknown().optional(),
  }),
  z.object({
    type: z.literal('tool_result'),
    toolCallId: id,
    output: z.unknown(),
    isError: z.boolean().default(false),
  }),
  z.object({
    type: z.literal('ask_user_question'),
    questionId: id,
    question: z.string(),
    options: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal('user_answer'),
    questionId: id,
    answer: z.string(),
  }),
  z.object({
    type: z.literal('attachment_ref'),
    attachmentId: id,
    path: z.string(),
    filename: z.string(),
  }),
  z.object({ type: z.literal('turn_start') }),
  z.object({ type: z.literal('turn_end'), stopReason: z.string().optional() }),
  z.object({
    type: z.literal('turn_interrupted'),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal('error'),
    message: z.string(),
    code: z.string().optional(),
  }),
])
export type MessageContent = z.infer<typeof MessageContent>
export const messageContentTypes = [
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
