import { z } from 'zod'
import { Message } from './message.js'
import { queuedPromptSchema } from './session.js'

export const nativeInteractionSchema = z.object({
  questionId: z.string().min(1),
  sessionId: z.string().min(1),
  questions: z.array(z.unknown()),
  source: z.enum(['permission', 'ext']),
  status: z.enum([
    'pending',
    'replying',
    'submitted',
    'cancelled',
    'expired',
    'uncertain',
  ]),
  runtimeGeneration: z.string().optional(),
  answer: z.unknown().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  expiresAt: z.number(),
})
export type NativeInteraction = z.infer<typeof nativeInteractionSchema>
export const SubscribeFrame = z.object({
  type: z.literal('subscribe'),
  sessions: z.union([z.array(z.string()), z.literal('all')]),
  cursor: z.number().int().nonnegative(),
})
export type SubscribeFrame = z.infer<typeof SubscribeFrame>

// A REST snapshot has a read watermark, but it must not move the global live cursor.
export const SessionSnapshot = z
  .object({
    type: z.literal('sessionSnapshot'),
    sessionId: z.string(),
    cursor: z.number().int().nonnegative(),
    messages: z.array(Message),
    queuedPrompts: z.array(queuedPromptSchema).optional(),
    commands: z.array(z.unknown()).optional(),
    requests: z.array(nativeInteractionSchema).optional(),
    usage: z.unknown().optional(),
  })
  .superRefine((snapshot, ctx) => {
    for (const [index, message] of snapshot.messages.entries())
      if (message.sessionId !== snapshot.sessionId)
        ctx.addIssue({
          code: 'custom',
          path: ['messages', index, 'sessionId'],
          message: 'Snapshot messages must belong to the snapshot session',
        })
  })
export type SessionSnapshot = z.infer<typeof SessionSnapshot>
