import { beforeEach, describe, expect, it } from 'vitest'
import { dedupeById, useSessionsStore } from './sessions'

describe('sessions store', () => {
  beforeEach(() => {
    useSessionsStore.setState({ sessions: [], projects: [] })
  })

  it('dedupes by id, keeping the last occurrence', () => {
    const result = dedupeById([
      { id: 'a', title: 'old' },
      { id: 'b', title: 'b' },
      { id: 'a', title: 'new' },
    ])
    expect(result).toEqual([
      { id: 'a', title: 'new' },
      { id: 'b', title: 'b' },
    ])
  })

  it('setSessions drops duplicate ids delivered by a mis-scoped merge', () => {
    // Mirrors a session route merging "self plus children" when an upstream
    // lookup mistakenly hands the parent session back as its own child.
    useSessionsStore.getState().setSessions([
      { id: 'ses_1', title: 'Parent' },
      { id: 'ses_1', title: 'Parent' },
    ])
    const ids = useSessionsStore.getState().sessions.map((s) => s.id)
    expect(ids).toEqual(['ses_1'])
  })
})
