import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { basename, join } from 'node:path'

/** Real entries that a link replaces are moved here, never deleted. */
export const DISPLACED_DIR = '.forge-displaced'

/**
 * Links `homePath/name` to the shared dir `target`. A real dir there holds
 * files of live sessions, so its files move into `target` first. A name that
 * already exists there is kept under a new name. Nothing is overwritten or
 * deleted. If the dir is not empty after the merge, the link waits for the
 * next call.
 */
export function linkSharedDir(homePath: string, name: string, target: string) {
  mkdirSync(target, { recursive: true, mode: 0o700 })
  const link = join(homePath, name)
  const current = lstatSync(link, { throwIfNoEntry: false })
  if (current?.isSymbolicLink()) {
    if (readlinkSync(link) === target) return
    rmSync(link)
  } else if (current?.isDirectory()) {
    mergeInto(link, target, basename(homePath))
    if (!removeEmptyDir(link)) return
  } else if (current) {
    const displaced = join(homePath, DISPLACED_DIR)
    mkdirSync(displaced, { recursive: true })
    renameSync(link, join(displaced, `${name}.${Date.now()}`))
  }
  symlinkSync(target, link)
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
      // A collision keeps the account's copy beside the shared one, named
      // with the account id. The harness ignores it; a human can merge it.
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
