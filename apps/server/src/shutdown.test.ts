import { describe, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
import { ServerShutdown } from './shutdown.js'

function fixture(markStopped = vi.fn()) {
  const closeHttp = vi.fn((callback: (error?: Error) => void) => callback())
  const server = { close: closeHttp } as unknown as Server
  const stoppedAdmission = vi.fn()
  const shutdown = new ServerShutdown(
    server,
    stoppedAdmission,
    markStopped,
    2,
    20,
  )
  const close = () =>
    new Promise<Error | undefined>((resolve) => server.close(resolve))
  return { server, shutdown, closeHttp, stoppedAdmission, close }
}

describe('shared server shutdown ownership', () => {
  it('retries failed bookkeeping without repeating physical HTTP close or completed hooks', async () => {
    const markStopped = vi.fn().mockImplementationOnce(() => {
      throw new Error('database busy')
    })
    const { shutdown, close, closeHttp, stoppedAdmission } =
      fixture(markStopped)
    const hook = vi.fn()
    shutdown.addCleanupHook(hook)
    expect((await close())?.message).toBe('Server cleanup is unknown')
    expect(await close()).toBeUndefined()
    expect(closeHttp).toHaveBeenCalledTimes(1)
    expect(stoppedAdmission).toHaveBeenCalledTimes(1)
    expect(hook).toHaveBeenCalledTimes(1)
    expect(markStopped).toHaveBeenCalledTimes(2)
  })

  it('joins one pending physical hook through deadline and refuses overlapping retries', async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const { shutdown, close, closeHttp } = fixture()
    const hook = vi.fn(() => pending)
    shutdown.addCleanupHook(hook)
    expect((await close())?.message).toBe('Server cleanup is unknown')
    expect((await close())?.message).toBe('Server cleanup is unknown')
    expect(closeHttp).not.toHaveBeenCalled()
    expect(hook).toHaveBeenCalledTimes(1)
    release()
    await vi.waitFor(() => expect(closeHttp).toHaveBeenCalledTimes(1))
    expect(await close()).toBeUndefined()
  })

  it('shares concurrent callers and bounds retained callbacks', async () => {
    let release!: () => void
    const { shutdown, close, closeHttp } = fixture()
    shutdown.addCleanupHook(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    const first = close(),
      second = close(),
      refused = close()
    expect((await refused)?.message).toBe('Shutdown callback capacity reached')
    release()
    expect(await first).toBeUndefined()
    expect(await second).toBeUndefined()
    expect(closeHttp).toHaveBeenCalledTimes(1)
  })
})
