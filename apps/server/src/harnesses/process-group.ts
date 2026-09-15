import { open, readdir } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

export function signalProcessGroup(pid: number, signal: NodeJS.Signals | 0) {
  try {
    process.kill(-pid, signal)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    return false
  }
}

export function statIsRunningGroupMember(stat: string, pid: number) {
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  return Number(fields[2]) === pid && fields[0] !== 'Z' && fields[0] !== 'X'
}

function checkDeadline(deadline: number) {
  if (performance.now() >= deadline)
    throw new Error('Native process cleanup timed out')
}

/**
 * Each entry costs an open, a read and a close on the shared filesystem pool, so a
 * sequential scan of a busy host spends most of its budget waiting. Read a bounded
 * batch at a time instead. The pool still bounds real work, so a saturated pool
 * still expires the deadline.
 */
export const INSPECTION_BATCH = 8

/** Read only state and group ID. Linux can retain orphan zombies after KILL. */
export async function groupHasRunningMember(pid: number, deadline: number) {
  let expired = false
  const check = () => {
    if (expired) throw new Error('Native process cleanup timed out')
    checkDeadline(deadline)
  }
  const isRunningMember = async (name: string, buffer: Buffer) => {
    try {
      check()
      const file = await open(`/proc/${name}/stat`, 'r')
      try {
        check()
        // One bounded read at a time. Do not read argv or the environment.
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
        check()
        if (bytesRead === buffer.length)
          throw new Error('Native process stat exceeds limit')
        const stat = buffer.toString('utf8', 0, bytesRead)
        return statIsRunningGroupMember(stat, pid)
      } finally {
        await file.close()
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ESRCH') throw error
      return false
    }
  }
  const inspect = async () => {
    check()
    /**
     * Read names, never Dirents. /proc reports a task that is exiting as
     * DT_UNKNOWN, and Node resolves that type with a second lstat which fails
     * once the task is gone. One such entry aborts the whole readdir batch it
     * arrived in, so the listing would silently lose its remaining members.
     */
    const names = await readdir('/proc')
    check()
    const members = names.filter((name) => /^\d+$/.test(name))
    if (members.length > 65_536)
      throw new Error('Native process inspection limit reached')
    const buffers = Array.from({ length: INSPECTION_BATCH }, () =>
      Buffer.alloc(4096),
    )
    for (let start = 0; start < members.length; start += INSPECTION_BATCH) {
      check()
      const batch = await Promise.all(
        members
          .slice(start, start + INSPECTION_BATCH)
          .map((name, slot) => isRunningMember(name, buffers[slot]!)),
      )
      check()
      if (batch.includes(true)) return true
    }
    return false
  }
  check()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => {
          expired = true
          reject(new Error('Native process cleanup timed out'))
        },
        Math.max(0, Math.ceil(deadline - performance.now())),
      )
    })
    // Filesystem operations cannot be cancelled. Late completions only close handles.
    const running = await Promise.race([inspect(), timeout])
    check()
    return running
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function waitForProcessGroupExit(pid: number, deadline: number) {
  while (true) {
    checkDeadline(deadline)
    if (!signalProcessGroup(pid, 0)) return
    if (!(await groupHasRunningMember(pid, deadline))) return
    checkDeadline(deadline)
    await delay(Math.min(10, Math.max(1, deadline - performance.now())))
  }
}
