import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
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

/** Real entries that a link replaces are moved here, never deleted. */
const DISPLACED_DIR = '.forge-displaced'

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
  linkClaudeProjects(homePath, projectsRoot)
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

/**
 * Links the account's `projects/` to `projectsRoot`. A real `projects/` dir
 * holds transcripts of live sessions, so its files move into `projectsRoot`
 * first. A name that already exists there is kept under a new name. Nothing is
 * overwritten or deleted. If the dir is not empty after the merge, the link
 * waits for the next call.
 */
function linkClaudeProjects(homePath: string, projectsRoot: string) {
  mkdirSync(projectsRoot, { recursive: true, mode: 0o700 })
  const link = join(homePath, 'projects')
  const current = lstatSync(link, { throwIfNoEntry: false })
  if (current?.isSymbolicLink()) {
    if (readlinkSync(link) === projectsRoot) return
    rmSync(link)
  } else if (current?.isDirectory()) {
    mergeInto(link, projectsRoot, basename(homePath))
    if (!removeEmptyDir(link)) return
  } else if (current) {
    const displaced = join(homePath, DISPLACED_DIR)
    mkdirSync(displaced, { recursive: true })
    renameSync(link, join(displaced, `projects.${Date.now()}`))
  }
  symlinkSync(projectsRoot, link)
}

function mergeInto(source: string, target: string, owner: string) {
  for (const name of readdirSync(source)) {
    const from = join(source, name)
    const to = join(target, name)
    const existing = lstatSync(to, { throwIfNoEntry: false })
    if (!existing) renameSync(from, to)
    else if (existing.isDirectory() && lstatSync(from).isDirectory()) {
      mergeInto(from, to, owner)
      removeEmptyDir(from)
    } else {
      // A collision keeps the account's copy beside the shared one,
      // named with the account id. Claude ignores it; a human can merge it.
      let kept = `${to}.${owner}`
      while (lstatSync(kept, { throwIfNoEntry: false }))
        kept = `${to}.${owner}.${Date.now()}`
      renameSync(from, kept)
    }
  }
}

/** rmdir only removes an empty dir, so a file written mid-merge survives. */
function removeEmptyDir(path: string) {
  try {
    rmdirSync(path)
    return true
  } catch {
    return false
  }
}
