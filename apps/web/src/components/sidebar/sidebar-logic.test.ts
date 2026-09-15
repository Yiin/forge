import { describe, expect, it } from 'vitest'
import {
  filterScope,
  jumpTarget,
  navigationSessions,
  partitionSessions,
  searchSessions,
  sortSessions,
  settledPage,
  visibleSessions,
} from './sidebar-logic'

const sessions = [
  { id: 'a', title: 'A', projectId: 'one', status: 'running' },
  { id: 'b', title: 'B', projectId: 'two', status: 'archived' },
  {
    id: 'c',
    title: 'C',
    projectId: 'one',
    kind: 'subagent',
    status: 'running',
  },
  {
    id: 'd',
    title: 'D',
    projectId: 'one',
    kind: 'epic_worker',
    status: 'running',
  },
  ...Array.from({ length: 26 }, (_, i) => ({
    id: `s${i}`,
    title: `S${i}`,
    status: 'archived' as const,
  })),
]

describe('sidebar logic', () => {
  it('removes worker sessions and filters by project scope', () => {
    expect(visibleSessions(sessions).map((s) => s.id)).not.toContain('c')
    expect(filterScope(sessions, 'one').map((s) => s.id)).toEqual(['a'])
  })
  it('partitions active and settled sessions', () => {
    const result = partitionSessions(visibleSessions(sessions))
    expect(result.active.map((s) => s.id)).toEqual(['a'])
    expect(result.settled).toHaveLength(27)
  })
  it('pages the settled tail and selects the first nine jump targets', () => {
    const result = settledPage(
      partitionSessions(visibleSessions(sessions)).settled,
      1,
    )
    expect(result.items).toHaveLength(25)
    expect(result.remaining).toBe(2)
    expect(jumpTarget([{ id: 'first', title: 'First' }], 1)).toBe('first')
    expect(jumpTarget([{ id: 'first', title: 'First' }], 10)).toBeUndefined()
  })
  it('searches metadata and sorts by the selected stable timestamp', () => {
    const values = [
      {
        id: 'new',
        title: 'Deploy',
        harness: 'Claude',
        createdAt: 2,
        lastActivityAt: 1,
      },
      {
        id: 'old',
        title: 'Review',
        branch: 'feature/search',
        createdAt: 1,
        lastActivityAt: 2,
      },
    ]
    expect(searchSessions(values, 'feature')).toEqual([values[1]])
    expect(sortSessions(values, 'created').map((item) => item.id)).toEqual([
      'new',
      'old',
    ])
    expect(sortSessions(values).map((item) => item.id)).toEqual(['old', 'new'])
  })
  it('uses the same active order for session navigation as the sidebar', () => {
    expect(
      navigationSessions(
        [
          { id: 'archived', title: 'A', status: 'archived', lastActivityAt: 4 },
          { id: 'second', title: 'B', status: 'idle', lastActivityAt: 2 },
          { id: 'first', title: 'C', status: 'running', lastActivityAt: 3 },
        ],
        { scope: 'all', query: '', sort: 'updated' },
      ).map((session) => session.id),
    ).toEqual(['first', 'second'])
  })
})
