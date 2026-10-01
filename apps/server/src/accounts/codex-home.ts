import { join } from 'node:path'
import { linkSharedDir } from './shared-dir.js'
import { accountRoot } from './store.js'

/**
 * Rollout dirs that every Forge Codex account home links to, so
 * `thread/resume` finds the thread after a session switches account. Codex
 * keeps its thread index (state_5.sqlite, thread_history_1.sqlite) per home
 * and rebuilds it from these rollouts, so the index stays private. So do
 * auth.json and other account state. The dir is Forge-owned, never
 * `~/.codex`, and sits under `.shared/`, outside the `<kind>/<id>` homes.
 */
export const CODEX_SHARED_DIRS = ['sessions', 'archived_sessions'] as const

export const codexSharedRoot = () => join(accountRoot(), '.shared', 'codex')

export function linkCodexSessions(homePath: string, root = codexSharedRoot()) {
  for (const name of CODEX_SHARED_DIRS)
    linkSharedDir(homePath, name, join(root, name))
}
