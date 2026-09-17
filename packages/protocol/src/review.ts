import { z } from 'zod'

const path = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.split('/').includes('..') &&
      // eslint-disable-next-line no-control-regex -- Citation paths cannot contain control bytes.
      !/[\x00-\x1f]/.test(value),
    'Review paths must stay inside the workspace',
  )
export const reviewAnchorSchema = z
  .strictObject({
    workspaceId: z.string().min(1).max(128),
    workspaceRevision: z.number().int().positive(),
    revision: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('git'),
        scope: z.enum(['working', 'branch', 'latest-turn', 'commit']),
        revision: z.string().min(1).max(512),
      }),
      z.strictObject({
        kind: z.literal('file'),
        contentHash: z.string().regex(/^[a-f0-9]{64}$/),
        fileRevision: z.string().min(1).max(256),
      }),
    ]),
    oldPath: path.nullable(),
    newPath: path.nullable(),
    side: z.enum(['old', 'new']),
    line: z.number().int().positive(),
  })
  .refine(
    (value) =>
      value.side === 'old' ? value.oldPath !== null : value.newPath !== null,
    'The cited side needs a path',
  )
export const reviewNoteSchema = z.strictObject({
  id: z.string().min(1).max(128),
  body: z.string().trim().min(1).max(8192),
  anchor: reviewAnchorSchema,
})
export const reviewNotesSchema = z
  .array(reviewNoteSchema)
  .max(64)
  .refine(
    (notes) => new Set(notes.map((note) => note.id)).size === notes.length,
    'Review note IDs must be unique',
  )
export type ReviewAnchor = z.infer<typeof reviewAnchorSchema>
export type ReviewNote = z.infer<typeof reviewNoteSchema>

export function reviewCitation(note: ReviewNote): string {
  const a = note.anchor
  const revision =
    a.revision.kind === 'git'
      ? `${a.revision.scope}:${a.revision.revision}`
      : `${a.revision.contentHash}:${a.revision.fileRevision}`
  return `${a.side === 'old' ? a.oldPath : a.newPath}:${a.line} (${a.side}; workspace ${a.workspaceId}@${a.workspaceRevision}; ${revision})`
}
export function serializeReviewNotes(notes: ReviewNote[]): string {
  return notes.length
    ? `\n\nReview notes:\n${notes.map((note) => `- [${note.id}] ${reviewCitation(note)}: ${note.body}`).join('\n')}`
    : ''
}
