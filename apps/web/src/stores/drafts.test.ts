// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { draftStorageKey, resetDraftsStore, useDraftsStore } from './drafts'

describe('local draft store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    window.localStorage.clear()
    resetDraftsStore()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('creates one reusable draft per project and hydrates it', () => {
    const first = useDraftsStore.getState().getOrCreate('project-1', 'acp')
    const second = useDraftsStore.getState().getOrCreate('project-1', 'pty')
    expect(second).toEqual(first)
    useDraftsStore.getState().update(first.id, { prompt: 'keep me' })
    useDraftsStore.getState().flush()
    const saved = window.localStorage.getItem(draftStorageKey)

    resetDraftsStore()
    window.localStorage.setItem(draftStorageKey, saved!)
    useDraftsStore.getState().hydrate()
    expect(useDraftsStore.getState().drafts[first.id].prompt).toBe('keep me')
    expect(
      JSON.parse(window.localStorage.getItem(draftStorageKey)!),
    ).toHaveProperty(first.id)
  })

  it('debounces writes and flushes pending data', () => {
    const draft = useDraftsStore.getState().getOrCreate('project-1')
    useDraftsStore.getState().update(draft.id, { prompt: 'saved later' })
    expect(window.localStorage.getItem(draftStorageKey)).toBeNull()
    vi.advanceTimersByTime(149)
    expect(window.localStorage.getItem(draftStorageKey)).toBeNull()
    vi.advanceTimersByTime(1)
    expect(window.localStorage.getItem(draftStorageKey)).toContain(
      'saved later',
    )
  })

  it('persists a changed account selection across hydration', () => {
    const draft = useDraftsStore.getState().getOrCreate('project-1')
    useDraftsStore.getState().update(draft.id, {
      harness: 'claude',
      accountId: 'work',
    })
    useDraftsStore.getState().flush()
    const saved = window.localStorage.getItem(draftStorageKey)

    resetDraftsStore()
    window.localStorage.setItem(draftStorageKey, saved!)
    useDraftsStore.getState().hydrate()

    expect(useDraftsStore.getState().drafts[draft.id]).toMatchObject({
      harness: 'claude',
      accountId: 'work',
    })
  })

  it('removes drafts for missing projects and ignores corrupt storage', () => {
    window.localStorage.setItem(draftStorageKey, '{bad json')
    useDraftsStore.getState().hydrate()
    expect(useDraftsStore.getState().drafts).toEqual({})
    const draft = useDraftsStore.getState().getOrCreate('missing')
    useDraftsStore.getState().removeInvalid(['other'])
    expect(useDraftsStore.getState().drafts[draft.id]).toBeUndefined()
  })

  it('accepts storage updates from another tab', () => {
    const draft = useDraftsStore.getState().getOrCreate('project-1')
    useDraftsStore.getState().flush()
    const changed = { ...draft, prompt: 'from another tab' }
    window.localStorage.setItem(
      draftStorageKey,
      JSON.stringify({ [draft.id]: changed }),
    )
    window.dispatchEvent(new StorageEvent('storage', { key: draftStorageKey }))
    expect(useDraftsStore.getState().drafts[draft.id].prompt).toBe(
      'from another tab',
    )
  })
})
