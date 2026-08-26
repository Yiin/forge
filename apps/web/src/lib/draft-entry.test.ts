import { describe, expect, it } from 'vitest'
import { selectDraftProject } from './draft-entry'

describe('draft entry project selection', () => {
  const projects = [
    { id: 'old', name: 'Old', createdAt: 10 },
    { id: 'new', name: 'New', createdAt: 20 },
  ]

  it('uses the newest visible chat activity', () => {
    expect(
      selectDraftProject(projects, [
        {
          id: 'worker',
          title: '',
          projectId: 'new',
          kind: 'epic_worker',
          lastActivityAt: 100,
        },
        {
          id: 'chat',
          title: '',
          projectId: 'old',
          kind: 'chat',
          lastActivityAt: 50,
        },
      ])?.id,
    ).toBe('old')
  })

  it('falls back to the newest active project', () => {
    expect(
      selectDraftProject([{ ...projects[0], archivedAt: 1 }, projects[1]], [])
        ?.id,
    ).toBe('new')
  })
})
