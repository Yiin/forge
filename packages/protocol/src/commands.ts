import { z } from 'zod'
const id = z.string().min(1)
const page = {
  limit: z.number().int().positive().max(100).optional(),
  cursor: z.string().optional(),
}
export const createProject = z.object({
  name: z.string().trim().min(1),
  path: z.string().min(1),
})
export const archiveProject = z.object({ projectId: id })
export const createSession = z.object({
  projectId: id,
  harness: z.string().min(1),
  cwd: z.string().min(1),
  title: z.string().optional(),
  kind: z.enum(['chat', 'subagent', 'epic_worker']).default('chat'),
  parentSessionId: id.nullable().optional(),
})
export const prompt = z.object({
  sessionId: id,
  text: z.string().min(1),
  attachmentIds: z.array(id).optional(),
})
export const interrupt = z.object({ sessionId: id })
export const fork = z.object({
  sessionId: id,
  messageSeq: z.number().int().nonnegative(),
  text: z.string().min(1),
})
export const btw = z.object({
  sessionId: id,
  sourceSeq: z.number().int().nonnegative().optional(),
  text: z.string().min(1),
})
export const answerQuestion = z
  .object({
    sessionId: id,
    questionId: id,
    answer: z.string().optional(),
    answers: z
      .union([
        z.string(),
        z.array(z.string()),
        z.record(z.string(), z.unknown()),
      ])
      .optional(),
  })
  .refine(
    (value) => value.answer !== undefined || value.answers !== undefined,
    {
      message: 'answer or answers is required',
    },
  )
// HTTP body for POST /api/sessions/:id/uploads. The 1 GiB ceiling is enforced
// by the upload store so an oversize init answers 413, not a validation error.
export const uploadInitSchema = z.object({
  filename: z.string().min(1).max(1024),
  mime: z.string().min(1).max(255),
  sizeBytes: z.number().int().nonnegative(),
})
export const uploadInitResponseSchema = z.object({
  attachmentId: z.string(),
  putUrl: z.string(),
})
export const uploadInit = uploadInitSchema.extend({ sessionId: id })
export const epicStart = z.object({
  projectId: id,
  epicBeadId: id,
  mode: z.enum(['pool', 'serial', 'auto']).default('pool'),
  workerCount: z.number().int().positive().max(32).default(1),
  baseBranch: z.string().min(1).default('main'),
  config: z.record(z.string(), z.unknown()).default({}),
})
export const epicPause = z.object({ runId: id })
export const epicResume = z.object({ runId: id, skipBead: id.optional() })
export const epicCancel = z.object({ runId: id })
const epicStatus = z.enum([
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
])
export const epicRunResponse = z.object({
  id: id,
  projectId: id,
  epicBeadId: id,
  title: z.string(),
  status: epicStatus,
  mode: z.enum(['pool', 'serial']),
  workerCount: z.number().int().nonnegative(),
  baseBranch: z.string(),
  config: z.record(z.string(), z.unknown()),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  error: z.string().nullable(),
  iterationCount: z.number().int().nonnegative(),
})
export const epicIterationResponse = z.object({
  id,
  beadId: id,
  title: z.string(),
  sessionId: id,
  attempt: z.number().int().positive(),
  status: z.enum(['running', 'merged', 'failed', 'interrupted']),
  failureReason: z.string().nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
})
export const epicRunDetailResponse = epicRunResponse.extend({
  iterations: z.array(epicIterationResponse),
  frontier: z.object({
    ready: z.array(z.object({ id, title: z.string(), priority: z.number() })),
    blocked: z.array(z.object({ id, title: z.string(), priority: z.number() })),
  }),
})
export const search = z.object({
  query: z.string().min(1),
  projectId: id.optional(),
  ...page,
})

const searchSnippet = z.string()
// Message hits use /s/:sessionId?m=:seq. The chat route owns scroll and flash.
export const searchResponse = z.object({
  sessions: z.array(
    z.object({ sessionId: id, title: z.string(), snippet: searchSnippet }),
  ),
  messages: z.array(
    z.object({
      sessionId: id,
      seq: z.number().int().nonnegative(),
      itemId: id,
      snippet: searchSnippet,
      sessionTitle: z.string(),
    }),
  ),
  runs: z.array(
    z.object({
      runId: id,
      title: z.string(),
      snippet: searchSnippet,
      status: z.string(),
    }),
  ),
})
export const commandSchemas = {
  createProject,
  archiveProject,
  createSession,
  prompt,
  interrupt,
  fork,
  btw,
  answerQuestion,
  uploadInit,
  epicStart,
  epicPause,
  epicResume,
  epicCancel,
  search,
} as const

export type CreateProject = z.infer<typeof createProject>
export type ArchiveProject = z.infer<typeof archiveProject>
export type CreateSession = z.infer<typeof createSession>
export type Prompt = z.infer<typeof prompt>
export type Interrupt = z.infer<typeof interrupt>
export type Fork = z.infer<typeof fork>
export type Btw = z.infer<typeof btw>
export type AnswerQuestion = z.infer<typeof answerQuestion>
export type UploadInit = z.infer<typeof uploadInitSchema>
export type UploadInitResponse = z.infer<typeof uploadInitResponseSchema>
export type UploadInitCommand = z.infer<typeof uploadInit>
export type EpicStart = z.infer<typeof epicStart>
export type EpicPause = z.infer<typeof epicPause>
export type EpicResume = z.infer<typeof epicResume>
export type EpicCancel = z.infer<typeof epicCancel>
export type EpicRunResponse = z.infer<typeof epicRunResponse>
export type EpicIterationResponse = z.infer<typeof epicIterationResponse>
export type EpicRunDetailResponse = z.infer<typeof epicRunDetailResponse>
export type Search = z.infer<typeof search>
export type SearchResponse = z.infer<typeof searchResponse>
