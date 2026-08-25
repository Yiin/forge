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
export const answerQuestion = z.object({
  sessionId: id,
  questionId: id,
  answer: z.string(),
})
export const uploadInit = z
  .object({
    sessionId: id,
    filename: z.string().min(1),
    mime: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
  })
  .refine((v) => v.sizeBytes <= 1_000_000_000, {
    message: 'sizeBytes must be at most 1GB',
  })
export const epicStart = z.object({
  projectId: id,
  epicBeadId: id,
  mode: z.enum(['pool', 'serial']).default('pool'),
  workerCount: z.number().int().positive().max(32).default(1),
  baseBranch: z.string().min(1).default('main'),
  config: z.record(z.string(), z.unknown()).default({}),
})
export const epicPause = z.object({ runId: id })
export const epicResume = z.object({ runId: id })
export const epicCancel = z.object({ runId: id })
export const search = z.object({
  query: z.string().min(1),
  projectId: id.optional(),
  ...page,
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
export type UploadInit = z.infer<typeof uploadInit>
export type EpicStart = z.infer<typeof epicStart>
export type EpicPause = z.infer<typeof epicPause>
export type EpicResume = z.infer<typeof epicResume>
export type EpicCancel = z.infer<typeof epicCancel>
export type Search = z.infer<typeof search>
