import type { GitRef } from '@forge/protocol/git'

export type WorkspaceMode = 'local' | 'worktree'

export function workspaceModeLabel(mode: WorkspaceMode) {
  return mode === 'worktree' ? 'New worktree' : 'Current checkout'
}
export function currentWorkspaceLabel(worktreePath: string | null) {
  return worktreePath ? 'Current worktree' : 'Current checkout'
}
/** The read-only checkout label under a session's composer. */
export function sessionCheckoutLabel(worktreePath: string | null) {
  return worktreePath ? 'Worktree' : 'Local checkout'
}
export function effectiveWorkspaceMode(input: {
  worktreePath: string | null
  hasSession: boolean
  draftMode: WorkspaceMode | undefined
}): WorkspaceMode {
  return input.hasSession
    ? input.worktreePath
      ? 'worktree'
      : 'local'
    : (input.draftMode ?? 'local')
}
export function isModeLocked(input: {
  hasSession: boolean
  worktreePath: string | null
}) {
  return input.hasSession && Boolean(input.worktreePath)
}
export function branchTriggerLabel(input: {
  mode: WorkspaceMode
  worktreePath: string | null
  branch: string | null
}) {
  if (!input.branch) return 'Select ref'
  if (input.mode === 'worktree' && !input.worktreePath)
    return `From ${input.branch}`
  return input.branch
}
export function defaultBaseRef(refs: GitRef[], currentBranch: string | null) {
  return refs.find((ref) => ref.isDefault)?.name ?? currentBranch ?? null
}
