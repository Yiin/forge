import { z } from 'zod'

const nullableId = z.string().nullable()

export const sessionResponseSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  harness: z.string(),
  title: z.string(),
  cwd: z.string(),
  worktreePath: z.string().nullable(),
  branch: z.string().nullable(),
  providerSessionId: z.string().nullable(),
  model: z.string().nullable(),
  configOptions: z
    .record(z.string(), z.union([z.string(), z.boolean()]))
    .nullable(),
  kind: z.string(),
  retention: z.enum(['permanent', 'discardable']),
  parentSessionId: nullableId,
  forkedAtSeq: z.number().int().nullable(),
  spawnedBySeq: z.number().int().nullable(),
  epicRunId: nullableId,
  accountId: nullableId,
  status: z.string(),
  autoResume: z.number().int(),
  createdAt: z.number().int(),
  lastActivityAt: z.number().int(),
  deletedAt: z.number().int().nullable(),
})

export type SessionResponse = z.infer<typeof sessionResponseSchema>

export const queuedPromptSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  text: z.string(),
  createdAt: z.number().int(),
})

export type QueuedPrompt = z.infer<typeof queuedPromptSchema>
