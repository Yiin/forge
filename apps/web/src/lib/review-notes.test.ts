import { expect, it } from 'vitest'
import { captureGitReviewNote } from './review-notes'
import { reviewCitation, reviewNotesSchema } from '@forge/protocol/review'
import type { GitDiff } from '@forge/protocol/git'
const diff: GitDiff = {
  scope: 'working',
  revision: 'immutable-1',
  additions: 1,
  deletions: 1,
  truncated: false,
  files: [
    {
      oldPath: 'old.ts',
      newPath: 'renamed.ts',
      status: 'renamed',
      hunks: [
        {
          oldStart: 2,
          oldCount: 1,
          newStart: 4,
          newCount: 1,
          lines: [
            { type: 'deletion', text: 'old', oldLine: 2, newLine: null },
            { type: 'addition', text: 'new', oldLine: null, newLine: 4 },
          ],
        },
      ],
      additions: 1,
      deletions: 1,
      oldMode: null,
      newMode: null,
      contentTruncated: false,
    },
  ],
}
it('captures the exact old path and immutable revision across diff refresh', () => {
  const original = structuredClone(diff)
  const note = captureGitReviewNote(
    { workspaceId: 'w', workspaceRevision: 1 },
    original,
    original.files[0]!,
    'old',
    2,
    'Check rename',
  )
  original.revision = 'changed'
  original.files[0]!.oldPath = 'elsewhere'
  expect(reviewCitation(note)).toContain(
    'old.ts:2 (old; workspace w@1; working:immutable-1)',
  )
  expect(note.anchor.revision).toEqual({
    kind: 'git',
    scope: 'working',
    revision: 'immutable-1',
  })
})
it('rejects absent lines, foreign files, duplicate IDs and escaping paths', () => {
  const w = { workspaceId: 'w', workspaceRevision: 1 }
  expect(() =>
    captureGitReviewNote(w, diff, diff.files[0]!, 'old', 4, 'bad'),
  ).toThrow()
  expect(() =>
    captureGitReviewNote(
      w,
      diff,
      structuredClone(diff.files[0]!),
      'old',
      2,
      'bad',
    ),
  ).toThrow()
  const note = captureGitReviewNote(w, diff, diff.files[0]!, 'old', 2, 'ok')
  expect(reviewNotesSchema.safeParse([note, note]).success).toBe(false)
  expect(
    reviewNotesSchema.safeParse([
      { ...note, anchor: { ...note.anchor, oldPath: '../secret' } },
    ]).success,
  ).toBe(false)
})
