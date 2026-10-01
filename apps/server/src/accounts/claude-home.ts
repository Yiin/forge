import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DISPLACED_DIR, linkSharedDir } from './shared-dir.js'
import { accountRoot } from './store.js'

/**
 * User config that Claude Code reads from CLAUDE_CONFIG_DIR. Forge gives each
 * account its own CLAUDE_CONFIG_DIR, so without these links an account session
 * loses the user's skills, settings, hooks, and plugins. Credentials and other
 * runtime state stay private to the account. Session transcripts are shared
 * between Forge accounts only, see `claudeSharedProjects`.
 */
export const CLAUDE_SHARED_ENTRIES = [
  'CLAUDE.md',
  'settings.json',
  'skills',
  'agents',
  'commands',
  'output-styles',
  'hooks',
  'plugins',
] as const

/**
 * The one `projects/` dir (session transcripts) that every Forge Claude
 * account home links to, so `claude --resume` finds the conversation after a
 * session switches account. It is Forge-owned, never `~/.claude/projects`. It
 * sits under `.shared/`, outside the `<kind>/<id>` account homes, so nothing
 * that lists account dirs mistakes it for an account.
 */
export const claudeSharedProjects = () =>
  join(accountRoot(), '.shared', 'claude', 'projects')

/**
 * Links each shared entry of `sharedRoot` into the account home. An entry
 * missing from `sharedRoot` is left alone. A real file or directory in the
 * account home is moved to `.forge-displaced/` before it is linked.
 */
export function linkClaudeSharedConfig(
  homePath: string,
  sharedRoot = join(homedir(), '.claude'),
  projectsRoot = claudeSharedProjects(),
) {
  linkSharedDir(homePath, 'projects', projectsRoot)
  for (const name of CLAUDE_SHARED_ENTRIES) {
    const target = join(sharedRoot, name)
    if (!existsSync(target)) continue
    const link = join(homePath, name)
    const current = lstatSync(link, { throwIfNoEntry: false })
    if (current?.isSymbolicLink()) {
      if (readlinkSync(link) === target) continue
      rmSync(link)
    } else if (current) {
      const displaced = join(homePath, DISPLACED_DIR)
      mkdirSync(displaced, { recursive: true })
      renameSync(link, join(displaced, `${name}.${Date.now()}`))
    }
    symlinkSync(target, link)
  }
}
