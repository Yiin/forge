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
    type: z.literal('availableCommands'),
    seq: z.null(),
    sessionId: z.string(),
    commands: z.array(z.unknown()),
  }),
  z.object({
    type: z.literal('uploadProgress'),
    seq: z.null(),
    attachmentId: z.string(),
    sessionId: z.string(),
    bytesReceived: z.number().int().nonnegative(),
    sizeBytes: z.number().int().nonnegative(),
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
  z.object({
    type: z.literal('beadsChanged'),
    seq: z.null(),
    repoPath: z.string(),
  }),
])
export type Ephemeral = z.infer<typeof Ephemeral>
