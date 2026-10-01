import { mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

/** Links `homePath/name` to the shared dir `target`, creating `target`. */
export function linkSharedDir(homePath: string, name: string, target: string) {
  mkdirSync(target, { recursive: true, mode: 0o700 })
  replaceWithLink(join(homePath, name), target)
}

/** Points `link` at `target`. Whatever is at `link` already is deleted. */
export function replaceWithLink(link: string, target: string) {
  try {
    if (readlinkSync(link) === target) return
  } catch {}
  rmSync(link, { recursive: true, force: true })
  symlinkSync(target, link)
}
