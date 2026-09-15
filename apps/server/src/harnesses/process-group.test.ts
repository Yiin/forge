import { afterEach, describe, expect, it, vi } from 'vitest'
import { open, opendir } from 'node:fs/promises'
import {
  groupHasRunningMember,
  waitForProcessGroupExit,
} from './process-group.js'

vi.mock('node:fs/promises', () => ({ open: vi.fn(), opendir: vi.fn() }))

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
  it.each([
    'opendir',
    'directory read',
    'open',
    'file read',
    'file close',
    'directory close',
  ])(
    'bounds a pending %s and only releases resources after expiry',
    async (stage) => {
      vi.useFakeTimers({
        toFake: ['performance', 'setTimeout', 'clearTimeout'],
      })
      const blocked = gate()
      let listed = false
      const directory = {
        read: vi.fn(async () => {
          if (stage === 'directory read') await blocked.wait()
          if (listed) return null
          listed = true
          return { name: '42' }
        }),
        close: vi.fn(async () => {
          if (stage === 'directory close') await blocked.wait()
        }),
      }
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
      vi.mocked(opendir).mockImplementation(async () => {
        if (stage === 'opendir') await blocked.wait()
        return directory as never
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
          vi.mocked(opendir).mock.calls.length,
          directory.read.mock.calls.length,
          vi.mocked(open).mock.calls.length,
          file.read.mock.calls.length,
        ]
        blocked.release()
        await vi.advanceTimersByTimeAsync(0)
        expect([
          vi.mocked(opendir).mock.calls.length,
          directory.read.mock.calls.length,
          vi.mocked(open).mock.calls.length,
          file.read.mock.calls.length,
        ]).toEqual(scans)
        expect(directory.close).toHaveBeenCalledTimes(1)
        expect(file.close).toHaveBeenCalledTimes(
          ['opendir', 'directory read', 'directory close'].includes(stage)
            ? 0
            : 1,
        )
        if (stage === 'directory close') expect(open).not.toHaveBeenCalled()
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        blocked.release()
      }
    },
  )

  it('does not start inspection when its deadline has passed', async () => {
    await expect(
      groupHasRunningMember(42, performance.now() - 1),
    ).rejects.toThrow('cleanup timed out')
    expect(opendir).not.toHaveBeenCalled()
  })

  it('does not probe or signal the group after a late inspection completes', async () => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] })
    const blocked = gate()
    const directory = { close: vi.fn(async () => {}), read: vi.fn() }
    vi.mocked(opendir).mockImplementation(async () => {
      await blocked.wait()
      return directory as never
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
      expect(directory.read).not.toHaveBeenCalled()
      expect(directory.close).toHaveBeenCalledOnce()
    } finally {
      blocked.release()
    }
  })
})
