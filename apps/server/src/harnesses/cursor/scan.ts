import { lstat, opendir, realpath } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import {
  invariant,
  CursorError,
  type CursorLimits,
  type CursorResources,
} from './limits.js'

export async function boundedEntries(path: string, maximum: number) {
  const folder = await opendir(path),
    entries = []
  try {
    for await (const entry of folder) {
      invariant(entries.length < maximum, 'cursor_directory_limit')
      entries.push(entry)
    }
  } finally {
    await folder.close().catch((error) => {
      if (error.code !== 'ERR_DIR_CLOSED') throw error
    })
  }
  return entries
}

export async function scanNativeData(root: string, limits: CursorLimits) {
  invariant((await realpath(root)) === root, 'cursor_native_path')
  const pending = [{ path: root, depth: 0 }]
  let entries = 0,
    pathBytes = 0,
    bytes = 0
  while (pending.length) {
    const current = pending.pop()!
    invariant(current.depth <= limits.scanDepth, 'cursor_native_scan_depth')
    const folder = await opendir(current.path)
    try {
      for await (const entry of folder) {
        const path = join(current.path, entry.name)
        pathBytes += Buffer.byteLength(path)
        invariant(
          ++entries <= limits.scanEntries && pathBytes <= limits.scanPathBytes,
          'cursor_native_scan_limit',
        )
        const info = await lstat(path)
        if (info.isSymbolicLink()) {
          const target = await realpath(path)
          invariant(
            !relative(root, target).startsWith('..') &&
              target.startsWith(`${root}/`),
            'cursor_native_external_link',
          )
          bytes += info.size
        } else if (info.isDirectory()) {
          invariant(
            pending.length < limits.scanPending,
            'cursor_native_scan_pending',
          )
          pending.push({ path, depth: current.depth + 1 })
        } else {
          invariant(info.isFile(), 'cursor_native_file')
          bytes += info.size
        }
        invariant(
          Number.isSafeInteger(bytes) && bytes <= limits.nativeBytes,
          'cursor_native_size_limit',
        )
      }
    } finally {
      await folder.close().catch((error) => {
        if (error.code !== 'ERR_DIR_CLOSED') throw error
      })
    }
  }
  return { entries, pathBytes, bytes }
}

/** A request during a physical scan adds one subsequent scan. */
export class CursorScanner {
  private running?: Promise<void>
  private requested = false
  private failure?: Error
  private failed?: Promise<void>
  private stopped = false
  constructor(
    readonly root: string,
    private readonly resources: CursorResources,
    private readonly limits: CursorLimits,
  ) {}
  request(): Promise<void> {
    if (this.failure) return this.failed!
    if (this.stopped) return this.running ?? Promise.resolve()
    this.requested = true
    if (this.running) return this.running
    this.running = (async () => {
      while (this.requested) {
        this.requested = false
        await this.resources.scan(dirname(this.root), this.limits, () =>
          scanNativeData(this.root, this.limits),
        )
      }
    })()
      .catch((error) => {
        this.failure =
          error instanceof Error
            ? error
            : new CursorError('cursor_native_scan_failed')
        this.failed = this.running
        throw this.failure
      })
      .finally(() => {
        this.running = undefined
      })
    return this.running
  }
  async stop() {
    this.stopped = true
    await this.running
    if (this.failure) throw this.failure
  }
}
