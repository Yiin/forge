import { afterEach, describe, expect, it, vi } from 'vitest'
import { open, readdir } from 'node:fs/promises'
import {
  INSPECTION_BATCH,
  groupHasRunningMember,
  waitForProcessGroupExit,
} from './process-group.js'

vi.mock('node:fs/promises', () => ({ open: vi.fn(), readdir: vi.fn() }))

function gate() {
  let release!: () => void
  let entered!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  return {
    release,
    started,
    wait: () => {
      entered()
      return waiting
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.resetAllMocks()
})

describe('process inspection deadlines', () => {
  it.each(['readdir', 'open', 'file read', 'file close'])(
    'bounds a pending %s and only releases resources after expiry',
    async (stage) => {
      vi.useFakeTimers({
        toFake: ['performance', 'setTimeout', 'clearTimeout'],
      })
      const blocked = gate()
      const file = {
        read: vi.fn(async (buffer: Buffer) => {
          if (stage === 'file read') await blocked.wait()
          const bytesRead = buffer.write('42 (owned) S 1 42 0')
          return { bytesRead }
        }),
        close: vi.fn(async () => {
          if (stage === 'file close') await blocked.wait()
        }),
      }
      vi.mocked(readdir).mockImplementation(async () => {
        if (stage === 'readdir') await blocked.wait()
        return Array.from({ length: INSPECTION_BATCH * 2 }, (_, slot) =>
          String(42 + slot),
        ) as never
      })
      vi.mocked(open).mockImplementation(async () => {
        if (stage === 'open') await blocked.wait()
        return file as never
      })
      const result = groupHasRunningMember(42, performance.now() + 20).catch(
        (error: Error) => error.message,
      )
      await blocked.started
      await vi.advanceTimersByTimeAsync(20)
      try {
        expect(await result).toBe('Native process cleanup timed out')
        const scans = [
          vi.mocked(readdir).mock.calls.length,
          vi.mocked(open).mock.calls.length,
          file.read.mock.calls.length,
        ]
        blocked.release()
        await vi.advanceTimersByTimeAsync(0)
        expect([
          vi.mocked(readdir).mock.calls.length,
          vi.mocked(open).mock.calls.length,
          file.read.mock.calls.length,
        ]).toEqual(scans)
        // One bounded batch opens INSPECTION_BATCH handles and releases every
        // one of them. Expiry never leaves a handle behind, and it never starts
        // the second batch.
        const opened = stage === 'readdir' ? 0 : INSPECTION_BATCH
        expect(vi.mocked(open).mock.calls.length).toBe(opened)
        expect(file.close).toHaveBeenCalledTimes(opened)
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        blocked.release()
      }
    },
  )

  // A member can exit between the listing and its own state read.
  it.each(['ENOENT', 'ESRCH'])(
    'keeps scanning after a member reports %s for its own state',
    async (code) => {
      const file = {
        read: vi.fn(async (buffer: Buffer) => ({
          bytesRead: buffer.write('42 (owned) S 1 42 0'),
        })),
        close: vi.fn(async () => {}),
      }
      vi.mocked(readdir).mockResolvedValue(['41', '42', 'net'] as never)
      vi.mocked(open).mockImplementation(async (path) => {
        if (path === '/proc/41/stat')
          throw Object.assign(new Error(`${code}: open '${String(path)}'`), {
            code,
          })
        return file as never
      })
      await expect(
        groupHasRunningMember(42, performance.now() + 1000),
      ).resolves.toBe(true)
      // The vanished member never stops the scan, and /proc/net is not a member.
      expect(vi.mocked(open).mock.calls.map(([path]) => path)).toEqual([
        '/proc/41/stat',
        '/proc/42/stat',
      ])
      // Names only. Asking for Dirents makes Node lstat every exiting task,
      // and one such failure drops the rest of that readdir batch.
      expect(vi.mocked(readdir).mock.calls).toEqual([['/proc']])
    },
  )

  it('does not start inspection when its deadline has passed', async () => {
    await expect(
      groupHasRunningMember(42, performance.now() - 1),
    ).rejects.toThrow('cleanup timed out')
    expect(readdir).not.toHaveBeenCalled()
  })

  it('does not probe or signal the group after a late inspection completes', async () => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] })
    const blocked = gate()
    vi.mocked(readdir).mockImplementation(async () => {
      await blocked.wait()
      return ['42'] as never
    })
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    const result = waitForProcessGroupExit(42, performance.now() + 20).catch(
      (error: Error) => error.message,
    )
    await blocked.started
    await vi.advanceTimersByTimeAsync(20)
    try {
      expect(await result).toContain('cleanup timed out')
      expect(kill.mock.calls).toEqual([[-42, 0]])
      blocked.release()
      await vi.advanceTimersByTimeAsync(0)
      expect(kill.mock.calls).toEqual([[-42, 0]])
      expect(open).not.toHaveBeenCalled()
    } finally {
      blocked.release()
    }
  })
})
