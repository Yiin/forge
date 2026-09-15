import { open, opendir, readlink } from 'node:fs/promises'
import { statIsRunningGroupMember } from '../process-group.js'
import { KimiError } from './limits.js'

const processVanished = (error: unknown) =>
  ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')

async function readBounded(path: string, maximum: number) {
  const file = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(maximum + 1)
    let size = 0
    while (size < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        size,
        buffer.length - size,
        size,
      )
      if (!bytesRead) break
      size += bytesRead
    }
    if (size > maximum) throw new KimiError('kimi_listener_inspection_limit')
    return buffer.toString('utf8', 0, size)
  } finally {
    await file.close()
  }
}

/** Read only Linux socket inode, state, and process-group metadata. Never inspect argv or environment. */
export async function ownedListener(
  port: number,
  pgid: number,
  end: number,
): Promise<boolean> {
  const check = () => {
    if (performance.now() >= end)
      throw new KimiError('kimi_listener_inspection_timeout')
  }
  check()
  const table = await readBounded('/proc/net/tcp', 1024 * 1024)
  const wanted = `0100007F:${port.toString(16).toUpperCase().padStart(4, '0')}`
  const sockets = new Set<string>()
  for (const row of table.split('\n').slice(1)) {
    const fields = row.trim().split(/\s+/)
    if (fields[1] === wanted && fields[3] === '0A')
      sockets.add(`socket:[${fields[9]}]`)
  }
  if (!sockets.size) return false
  const directory = await opendir('/proc')
  let processes = 0
  try {
    for await (const entry of directory) {
      check()
      if (!/^\d+$/.test(entry.name)) continue
      if (++processes > 65536)
        throw new KimiError('kimi_listener_inspection_limit')
      let member = false
      try {
        member = statIsRunningGroupMember(
          await readBounded(`/proc/${entry.name}/stat`, 4096),
          pgid,
        )
      } catch (error) {
        if (processVanished(error)) continue
        throw error
      }
      if (!member) continue
      // An owned member can exit between its state read and its descriptor scan.
      // Its absence is not a foreign listener, so keep scanning the other members.
      let descriptors
      try {
        descriptors = await opendir(`/proc/${entry.name}/fd`)
      } catch (error) {
        if (processVanished(error)) continue
        throw error
      }
      let count = 0
      try {
        for await (const fd of descriptors) {
          check()
          if (++count > 4096)
            throw new KimiError('kimi_listener_inspection_limit')
          try {
            if (
              sockets.has(await readlink(`/proc/${entry.name}/fd/${fd.name}`))
            )
              return true
          } catch (error) {
            if (!processVanished(error)) throw error
          }
        }
      } catch (error) {
        if (!processVanished(error)) throw error
        // Iteration closes the descriptor when the loop body throws. Release it
        // here for the case where the iterator itself failed.
        await descriptors.close().catch((closed: NodeJS.ErrnoException) => {
          if (closed.code !== 'ERR_DIR_CLOSED') throw closed
        })
      }
    }
  } finally {
    /* Async directory iteration closes its descriptor, including early returns. */
  }
  throw new KimiError('kimi_foreign_listener')
}
