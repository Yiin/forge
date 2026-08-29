import { z } from 'zod'

export const gitStatusSchema = z.object({
  isRepo: z.boolean(), branch: z.string().nullable(), defaultBranch: z.string().nullable(),
  hasRemote: z.boolean(), detached: z.boolean(), dirty: z.boolean(),
})
export const gitRefSchema = z.object({
  name: z.string(), current: z.boolean(), isDefault: z.boolean(), isRemote: z.boolean(),
  remoteName: z.string().nullable(), worktreePath: z.string().nullable(),
})
export const gitRefsPageSchema = z.object({
  isRepo: z.boolean(), hasRemote: z.boolean(), refs: z.array(gitRefSchema),
  nextCursor: z.number().int().nullable(), totalCount: z.number().int(),
})
export type GitStatus = z.infer<typeof gitStatusSchema>
export type GitRef = z.infer<typeof gitRefSchema>
export type GitRefsPage = z.infer<typeof gitRefsPageSchema>
