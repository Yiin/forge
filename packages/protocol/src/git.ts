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

export const gitDiffScopeSchema = z.enum([
  'working',
  'branch',
  'latest-turn',
  'commit',
])
export const gitDiffLineSchema = z.object({
  type: z.enum(['context', 'addition', 'deletion', 'meta']),
  text: z.string(),
  oldLine: z.number().int().nullable(),
  newLine: z.number().int().nullable(),
})
export const gitDiffHunkSchema = z.object({
  oldStart: z.number().int(),
  oldCount: z.number().int(),
  newStart: z.number().int(),
  newCount: z.number().int(),
  lines: z.array(gitDiffLineSchema),
})
export const gitDiffFileSchema = z.object({
  oldPath: z.string().nullable(),
  newPath: z.string().nullable(),
  status: z.enum([
    'added',
    'modified',
    'deleted',
    'renamed',
    'copied',
    'binary',
    'submodule',
  ]),
  hunks: z.array(gitDiffHunkSchema),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  oldMode: z.string().nullable(),
  newMode: z.string().nullable(),
  contentTruncated: z.boolean(),
})
export const gitDiffSchema = z.object({
  scope: gitDiffScopeSchema,
  files: z.array(gitDiffFileSchema),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  truncated: z.boolean(),
  revision: z.string(),
  unavailable: z.boolean().optional(),
  unavailableReason: z.string().optional(),
})
export const gitContentSchema = z.object({
  path: z.string(),
  side: z.enum(['old', 'new']),
  text: z.string().nullable(),
  binary: z.boolean(),
  truncated: z.boolean(),
  revision: z.string(),
})
export const gitHistoryCommitSchema = z.object({
  sha: z.string(),
  parents: z.array(z.string()),
  refs: z.array(z.string()),
  author: z.string(),
  date: z.string(),
  subject: z.string(),
})
export const gitHistoryPageSchema = z.object({
  commits: z.array(gitHistoryCommitSchema),
  nextCursor: z.string().nullable(),
  revision: z.string(),
})
export type GitDiff = z.infer<typeof gitDiffSchema>
export type GitDiffFile = z.infer<typeof gitDiffFileSchema>
export type GitContent = z.infer<typeof gitContentSchema>
export type GitHistoryPage = z.infer<typeof gitHistoryPageSchema>
