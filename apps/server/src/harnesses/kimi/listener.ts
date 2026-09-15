import { open, readlink } from 'node:fs/promises'
import { readProcNames } from '../proc-names.js'
import { statIsRunningGroupMember } from '../process-group.js'
import { KimiError } from './limits.js'

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
  const inspection = {
    maximum: 65536,
    check,
    limitError: () => new KimiError('kimi_listener_inspection_limit'),
  }
  for (const name of await readProcNames('/proc', inspection)) {
    check()
    let member = false
    try {
      member = statIsRunningGroupMember(
        await readBounded(`/proc/${name}/stat`, 4096),
        pgid,
      )
    } catch (error) {
      if (
        ['ENOENT', 'ESRCH'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        continue
      throw error
    }
    if (!member) continue
    let descriptors: string[]
    try {
      descriptors = await readProcNames(`/proc/${name}/fd`, {
        ...inspection,
        maximum: 4096,
      })
    } catch (error) {
      if (
        ['ENOENT', 'ESRCH'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        continue
      throw error
    }
    for (const fd of descriptors) {
      check()
      try {
        if (sockets.has(await readlink(`/proc/${name}/fd/${fd}`))) return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
  throw new KimiError('kimi_foreign_listener')
}
