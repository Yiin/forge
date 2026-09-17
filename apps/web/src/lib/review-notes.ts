import type { GitDiff, GitDiffFile } from '@forge/protocol/git'
import type {
  ResolvedWorkspace,
  WorkspaceSnapshot,
} from '@forge/protocol/workspace'
import {
  reviewNoteSchema,
  type ReviewAnchor,
  type ReviewNote,
} from '@forge/protocol/review'

export function captureGitReviewNote(
  workspace: Pick<ResolvedWorkspace, 'workspaceId' | 'workspaceRevision'>,
  diff: GitDiff,
  file: GitDiffFile,
  side: 'old' | 'new',
  line: number,
  body: string,
): ReviewNote {
  if (
    diff.unavailable ||
    !diff.files.includes(file) ||
    !file.hunks.some((hunk) =>
      hunk.lines.some(
        (entry) => (side === 'old' ? entry.oldLine : entry.newLine) === line,
      ),
    )
  )
    throw new Error('Select an available diff line')
  return reviewNoteSchema.parse({
    id: crypto.randomUUID(),
    body,
    anchor: {
      workspaceId: workspace.workspaceId,
      workspaceRevision: workspace.workspaceRevision,
      revision: { kind: 'git', scope: diff.scope, revision: diff.revision },
      oldPath: file.oldPath,
      newPath: file.newPath,
      side,
      line,
    },
  })
}
export function captureFileReviewNote(
  snapshot: WorkspaceSnapshot,
  line: number,
  body: string,
): ReviewNote {
  if (
    snapshot.file.text === null ||
    line > snapshot.file.text.split('\n').length
  )
    throw new Error('Select an available file line')
  return reviewNoteSchema.parse({
    id: crypto.randomUUID(),
    body,
    anchor: {
      workspaceId: snapshot.workspace.workspaceId,
      workspaceRevision: snapshot.workspace.workspaceRevision,
      revision: {
        kind: 'file',
        contentHash: snapshot.file.contentHash,
        fileRevision: snapshot.file.fileRevision,
      },
      oldPath: snapshot.file.path,
      newPath: snapshot.file.path,
      side: 'new',
      line,
    },
  })
}
export type ReviewWorkspace = Pick<
  ResolvedWorkspace,
  'workspaceId' | 'workspaceRevision'
>
export type ReviewRevision = ReviewAnchor['revision']
export type ReviewRevisionListener = (
  workspace: ReviewWorkspace,
  revision: ReviewRevision | null,
  path?: string,
) => void
export function revisionKey(
  revision: ReviewRevision | null,
  path?: string,
): string {
  return revision?.kind === 'git' ? `git:${revision.scope}` : `file:${path}`
}
