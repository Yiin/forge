import { opendir, open } from 'node:fs/promises'
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

/** Read only state and group ID. Linux can retain orphan zombies after KILL. */
export async function groupHasRunningMember(pid: number, deadline: number) {
  let expired = false
  const check = () => {
    if (expired) throw new Error('Native process cleanup timed out')
    checkDeadline(deadline)
  }
  const inspect = async () => {
    check()
    const directory = await opendir('/proc')
    try {
      check()
      const buffer = Buffer.alloc(4096)
      let reads = 0
      while (true) {
        check()
        const entry = await directory.read()
        check()
        if (!entry) return false
        if (!/^\d+$/.test(entry.name)) continue
        if (++reads > 65_536)
          throw new Error('Native process inspection limit reached')
        try {
          check()
          const file = await open(`/proc/${entry.name}/stat`, 'r')
          try {
            check()
            // One bounded read at a time. Do not read argv or the environment.
            const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
            check()
            if (bytesRead === buffer.length)
              throw new Error('Native process stat exceeds limit')
            const stat = buffer.toString('utf8', 0, bytesRead)
            if (statIsRunningGroupMember(stat, pid)) return true
          } finally {
            await file.close()
          }
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code !== 'ENOENT' && code !== 'ESRCH') throw error
        }
      }
    } finally {
      await directory.close()
    }
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
