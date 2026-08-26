import { describe, expect, it } from 'vitest'
import { filterScope, jumpTarget, partitionSessions, settledPage, visibleSessions } from './sidebar-logic'

const sessions = [
  { id: 'a', title: 'A', projectId: 'one', status: 'running' },
  { id: 'b', title: 'B', projectId: 'two', status: 'archived' },
  { id: 'c', title: 'C', projectId: 'one', kind: 'subagent', status: 'running' },
  { id: 'd', title: 'D', projectId: 'one', kind: 'epic_worker', status: 'running' },
  ...Array.from({ length: 26 }, (_, i) => ({ id: `s${i}`, title: `S${i}`, status: 'archived' as const })),
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
    const result = settledPage(partitionSessions(visibleSessions(sessions)).settled, 1)
    expect(result.items).toHaveLength(25)
    expect(result.remaining).toBe(2)
    expect(jumpTarget([{ id: 'first', title: 'First' }], 1)).toBe('first')
    expect(jumpTarget([{ id: 'first', title: 'First' }], 10)).toBeUndefined()
  })
})
