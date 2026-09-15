// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_DOCK_STATE, useShellStore } from './shell'

describe('session workspace dock state', () => {
  beforeEach(() => {
    localStorage.clear()
    useShellStore.setState({ docks: {}, dockWidth: 480 })
  })

  it('keeps tabs and selection separate for each session', () => {
    const store = useShellStore.getState()
    store.openDockTab('one', { id: 'files-one', kind: 'files', title: 'Files' })
    store.openDockTab('two', {
      id: 'term-two',
      kind: 'terminal',
      title: 'Terminal',
    })
    expect(useShellStore.getState().dock('one').activeTabId).toBe('files-one')
    expect(useShellStore.getState().dock('two').activeTabId).toBe('term-two')
    expect(useShellStore.getState().dock('one').tabs).toHaveLength(1)
  })

  it('selects the adjacent tab and closes the dock after the last tab', () => {
    const store = useShellStore.getState()
    store.openDockTab('one', { id: 'a', kind: 'files', title: 'Files' })
    store.openDockTab('one', { id: 'b', kind: 'diff', title: 'Diff' })
    store.setActiveDockTab('one', 'a')
    store.closeDockTab('one', 'a')
    expect(useShellStore.getState().dock('one').activeTabId).toBe('b')
    store.closeDockTab('one', 'b')
    expect(useShellStore.getState().dock('one')).toEqual(DEFAULT_DOCK_STATE)
  })

  it('clamps global width and preserves it when a session closes', () => {
    const store = useShellStore.getState()
    store.setDockWidth(1)
    expect(useShellStore.getState().dockWidth).toBe(320)
    store.openDock('one')
    store.closeDock('one')
    expect(useShellStore.getState().dockWidth).toBe(320)
  })
})
