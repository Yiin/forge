import { opendir } from 'node:fs/promises'

/**
 * A /proc entry can vanish, or belong to a process this user cannot inspect,
 * between one read and the next. Neither case ends the scan: skip that entry
 * and keep going.
 */
export function isUninspectableProcEntry(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return (
    code === 'ENOENT' ||
    code === 'ESRCH' ||
    code === 'EACCES' ||
    code === 'EPERM'
  )
}

/** Node can lose the rest of a Dirent batch when its fallback lstat races exit. */
export async function readProcNames(
  path: string,
  options: {
    maximum: number
    check: () => void
    limitError: () => Error
  },
): Promise<string[]> {
  let work = 0
  while (true) {
    options.check()
    const directory = await opendir(path)
    const names: string[] = []
    try {
      while (true) {
        options.check()
        let entry
        try {
          entry = await directory.read()
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code !== 'ENOENT' && code !== 'ESRCH') throw error
          if (++work > options.maximum) throw options.limitError()
          // The lost suffix can contain a live member. Discard this whole listing.
          break
        }
        options.check()
        if (!entry) return names
        if (!/^\d+$/.test(entry.name)) continue
        if (++work > options.maximum) throw options.limitError()
        names.push(entry.name)
      }
    } finally {
      await directory.close()
    }
  }
}
