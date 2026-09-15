import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  stopForge,
  stopProxiedForge,
  withoutAmbientPaths,
} from '../helpers/forgeServer.js'

describe('isolated Forge launch environment', () => {
  it('does not let caller paths select a different server or data directory', () => {
    expect(
      withoutAmbientPaths({
        FORGE_CONFIG: '/home/user/.forge/forge.toml',
        FORGE_DATA_DIR: '/home/user/.forge',
        FORGE_DB: '/home/user/.forge/forge.db',
        FORGE_E2E: '1',
        FORGE_MOCK_PROMPT_DELAY_MS: '25',
      }),
    ).toEqual({
      FORGE_E2E: '1',
      FORGE_MOCK_PROMPT_DELAY_MS: '25',
    })
  })
})

describe('proxied Forge server cleanup', () => {
  // Waiting for handlers would hang on the harness-discovery requests the
  // settings route leaves in flight, so cleanup abandons them instead.
  it('abandons route handlers before stopping Forge', async () => {
    const calls: string[] = []
    const unrouteAll = vi.fn(async (_options: { behavior: 'ignoreErrors' }) => {
      calls.push('unrouteAll')
    })
    const stop = vi.fn(async () => {
      calls.push('stop')
    })

    await stopProxiedForge({ unrouteAll }, { stop })

    expect(unrouteAll).toHaveBeenCalledExactlyOnceWith({
      behavior: 'ignoreErrors',
    })
    expect(stop).toHaveBeenCalledOnce()
    expect(calls).toEqual(['unrouteAll', 'stop'])
  })

  it('stops Forge when route cleanup fails', async () => {
    const routeError = new Error('route cleanup failed')
    const calls: string[] = []
    const unrouteAll = vi.fn(async (_options: { behavior: 'ignoreErrors' }) => {
      calls.push('unrouteAll')
      throw routeError
    })
    const stop = vi.fn(async () => {
      calls.push('stop')
    })

    await expect(stopProxiedForge({ unrouteAll }, { stop })).rejects.toBe(
      routeError,
    )
    expect(stop).toHaveBeenCalledOnce()
    expect(calls).toEqual(['unrouteAll', 'stop'])
  })

  it('preserves a Forge stop failure', async () => {
    const stopError = new Error('Forge stop failed')
    const unrouteAll = vi.fn(
      async (_options: { behavior: 'ignoreErrors' }) => {},
    )
    const stop = vi.fn(async () => {
      throw stopError
    })

    await expect(stopProxiedForge({ unrouteAll }, { stop })).rejects.toBe(
      stopError,
    )
  })

  it('preserves route and Forge stop failures', async () => {
    const routeError = new Error('route cleanup failed')
    const stopError = new Error('Forge stop failed')
    const unrouteAll = vi.fn(async (_options: { behavior: 'ignoreErrors' }) => {
      throw routeError
    })
    const stop = vi.fn(async () => {
      throw stopError
    })

    await expect(
      stopProxiedForge({ unrouteAll }, { stop }),
    ).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [routeError, stopError],
    })
  })

  it('waits for the original close event and coalesces repeated cleanup', async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: 0,
      signalCode: null,
      pid: 123,
      kill: vi.fn(),
    })
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      const first = stopForge(child as never)
      const second = stopForge(child as never)
      let settled = false
      void first.then(() => {
        settled = true
      })
      await new Promise((resolve) => setImmediate(resolve))
      expect(settled).toBe(false)

      child.emit('close', 0, null)
      await expect(first).resolves.toBeUndefined()
      await expect(second).resolves.toBeUndefined()
      expect(kill).toHaveBeenCalledExactlyOnceWith(-123, 'SIGTERM')
    } finally {
      kill.mockRestore()
    }
  })
})
