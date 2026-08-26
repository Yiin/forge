import { describe, expect, it, vi } from 'vitest'
import { stopProxiedForge } from '../helpers/forgeServer.js'

describe('proxied Forge server cleanup', () => {
  it('waits for route handlers before stopping Forge', async () => {
    const calls: string[] = []
    const unrouteAll = vi.fn(async (_options: { behavior: 'wait' }) => {
      calls.push('unrouteAll')
    })
    const stop = vi.fn(async () => {
      calls.push('stop')
    })

    await stopProxiedForge({ unrouteAll }, { stop })

    expect(unrouteAll).toHaveBeenCalledExactlyOnceWith({ behavior: 'wait' })
    expect(stop).toHaveBeenCalledOnce()
    expect(calls).toEqual(['unrouteAll', 'stop'])
  })

  it('stops Forge when route cleanup fails', async () => {
    const routeError = new Error('route cleanup failed')
    const calls: string[] = []
    const unrouteAll = vi.fn(async (_options: { behavior: 'wait' }) => {
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
    const unrouteAll = vi.fn(async (_options: { behavior: 'wait' }) => {})
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
    const unrouteAll = vi.fn(async (_options: { behavior: 'wait' }) => {
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
})
