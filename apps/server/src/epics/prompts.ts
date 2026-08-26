import type { Bead } from '@forge/protocol/beads'
export function workerPrompt(bead: Bead, repoPath: string, baseBranch: string) {
  return `You are implementing one Forge child task.\n\nChild: ${bead.id}\nDescription:\n${bead.description}\n\nWork in ${repoPath} on branch ${baseBranch}. Implement only this child. Run focused tests. Commit your changes locally. Then run bd close ${bead.id} --reason "Completed". Never change another child's files. The runner checks the commit and bead state.`
}
