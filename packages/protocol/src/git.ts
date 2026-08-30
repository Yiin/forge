import { z } from 'zod'

export const gitStatusSchema = z.object({
  isRepo: z.boolean(),
  branch: z.string().nullable(),
  defaultBranch: z.string().nullable(),
  hasRemote: z.boolean(),
  detached: z.boolean(),
  dirty: z.boolean(),
})
export const gitRefSchema = z.object({
  name: z.string(),
  current: z.boolean(),
  isDefault: z.boolean(),
  isRemote: z.boolean(),
  remoteName: z.string().nullable(),
  worktreePath: z.string().nullable(),
})
export const gitRefsPageSchema = z.object({
  isRepo: z.boolean(),
  hasRemote: z.boolean(),
  refs: z.array(gitRefSchema),
  nextCursor: z.number().int().nullable(),
  totalCount: z.number().int(),
})
export type GitStatus = z.infer<typeof gitStatusSchema>
export type GitRef = z.infer<typeof gitRefSchema>
export type GitRefsPage = z.infer<typeof gitRefsPageSchema>

export const worktreeSchema = z.object({
  path: z.string(),
  branch: z.string().nullable(),
  detached: z.boolean(),
  dirty: z.boolean(),
  activeSession: z.boolean(),
})
export const createWorktreeRequestSchema = z.object({
  baseRef: z.string().min(1),
  branch: z.string().min(1).optional(),
})
export const createWorktreeResponseSchema = z.object({
  path: z.string(),
  branch: z.string(),
})
export const worktreeListResponseSchema = z.object({
  worktrees: z.array(worktreeSchema),
})
export const removeWorktreeRequestSchema = z.object({
  path: z.string().min(1),
  force: z.boolean().optional(),
})
export type Worktree = z.infer<typeof worktreeSchema>
