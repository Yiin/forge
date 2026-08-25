import { z } from 'zod'

export const messageTypeSchema = z.enum([
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
])
export const messageSchema = z.object({
  seq: z.number().int().positive().optional(),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  itemId: z.string().min(1),
  role: z.enum(['user', 'agent', 'system']),
  type: messageTypeSchema,
  content: z.unknown(),
  createdAt: z.number().int(),
})
export type Message = z.infer<typeof messageSchema>
