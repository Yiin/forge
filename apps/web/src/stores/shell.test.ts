// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useShellStore } from './shell'

beforeEach(() => useShellStore.setState({ sidebarWidth: 256 }))
afterEach(() => vi.restoreAllMocks())

describe('sidebar width updates', () => {
  it('does not write storage or notify subscribers for repeated clamped widths', () => {
    useShellStore.getState().setSidebarWidth(400)
    const write = vi.spyOn(Storage.prototype, 'setItem')
    const notified = vi.fn()
    const unsubscribe = useShellStore.subscribe(notified)
    const before = useShellStore.getState()
    for (let i = 0; i < 1000; i++) before.setSidebarWidth(401 + i)
    expect(useShellStore.getState()).toBe(before)
    expect(write).not.toHaveBeenCalled()
    expect(notified).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('keeps unchanged and repeated reset operations idle', () => {
    const write = vi.spyOn(Storage.prototype, 'setItem')
    const notified = vi.fn()
    const unsubscribe = useShellStore.subscribe(notified)
    useShellStore.getState().setSidebarWidth(256)
    useShellStore.getState().resetSidebarWidth()
    expect(write).not.toHaveBeenCalled()
    expect(notified).not.toHaveBeenCalled()
    useShellStore.getState().setSidebarWidth(300)
    useShellStore.getState().resetSidebarWidth()
    useShellStore.getState().resetSidebarWidth()
    expect(write).toHaveBeenCalledTimes(2)
    expect(notified).toHaveBeenCalledTimes(2)
    expect(useShellStore.getState().sidebarWidth).toBe(256)
    unsubscribe()
  })
})
