import { z } from 'zod'
import { Message } from './message.js'

export const ServerEvent = z.object({
  seq: z.number().int().nonnegative(),
  sessionId: z.string(),
  msg: Message,
})
export type ServerEvent = z.infer<typeof ServerEvent>
// Ephemeral events are never replayed. Durable UI state must reconstruct from message rows alone.
export const Ephemeral = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('uploadProgress'),
    seq: z.null(),
    attachmentId: z.string(),
    receivedBytes: z.number().int().nonnegative(),
    totalBytes: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal('sessionStatus'),
    seq: z.null(),
    sessionId: z.string(),
    status: z.enum(['idle', 'running', 'errored', 'archived']),
  }),
  z.object({
    type: z.literal('epicRunStatus'),
    seq: z.null(),
    runId: z.string(),
    status: z.enum(['running', 'paused', 'completed', 'failed', 'cancelled']),
  }),
  z.object({
    type: z.literal('presence'),
    seq: z.null(),
    sessionId: z.string(),
    connected: z.boolean(),
  }),
])
export type Ephemeral = z.infer<typeof Ephemeral>
