import { z } from 'zod'
import { Message } from './message.js'

export const contextWindowUsageSchema = z.object({
  usedTokens: z.number().int().nonnegative(),
  totalProcessedTokens: z.number().int().nonnegative().optional(),
  maxTokens: z.number().int().positive().optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  reasoningOutputTokens: z.number().int().nonnegative().optional(),
  lastUsedTokens: z.number().int().nonnegative().optional(),
  compactsAutomatically: z.boolean().optional(),
  source: z.string(),
  observedAt: z.number().int(),
})
export type ContextWindowUsage = z.infer<typeof contextWindowUsageSchema>

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
    type: z.literal('sessionTitle'),
    seq: z.null(),
    sessionId: z.string(),
    title: z.string(),
  }),
  z.object({
    type: z.literal('contextWindow'),
    seq: z.null(),
    sessionId: z.string(),
    usage: contextWindowUsageSchema,
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
  z.object({
    type: z.literal('harnessLoginUpdate'),
    seq: z.null(),
    loginId: z.string(),
    state: z.object({
      status: z.enum(['idle', 'running', 'succeeded', 'failed', 'cancelled']),
      startedAt: z.string().nullable(),
      finishedAt: z.string().nullable(),
      message: z.string().nullable(),
      output: z.string(),
      verificationUrl: z.string().nullable(),
      userCode: z.string().nullable(),
    }),
  }),
])
export type Ephemeral = z.infer<typeof Ephemeral>
