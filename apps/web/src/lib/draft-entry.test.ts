// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { openNewDraft, selectDraftProject } from './draft-entry'
import { api } from './api'
import { resetDraftsStore, useDraftsStore } from '../stores/drafts'

let listed: string[] = []

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

describe('draft entry filesystem fallback', () => {
  beforeEach(() => {
    window.localStorage.clear()
    resetDraftsStore()
    listed = []
    api.listProjects = async () => []
    api.listSessions = async () => []
    api.listDirectories = async () => {
      listed.push('call')
      return { path: '/home/agent' }
    }
  })

  // The home route opens a draft by itself. Falling back to a filesystem target
  // there would replace the "add a project" screen the app starts on.
  it('reports empty without a project unless the caller opts in', async () => {
    const navigations: unknown[] = []
    const result = await openNewDraft((async (options: unknown) => {
      navigations.push(options)
    }) as never)
    expect(result).toEqual({ kind: 'empty' })
    expect(navigations).toEqual([])
    expect(listed).toEqual([])
  })

  it('opens a projectless draft on the filesystem target when asked', async () => {
    const navigations: Array<{ params: { draftId: string } }> = []
    const result = await openNewDraft(
      (async (options: { params: { draftId: string } }) => {
        navigations.push(options)
      }) as never,
      { allowFilesystemTarget: true },
    )
    expect(result.kind).toBe('draft')
    const draftId = (result as { draftId: string }).draftId
    expect(navigations[0]?.params).toEqual({ draftId })
    const draft = useDraftsStore.getState().drafts[draftId]
    expect(draft?.projectId).toBeUndefined()
    expect(draft?.targetPath).toBe('/home/agent')
  })

  it('stays empty when no filesystem target is reachable', async () => {
    api.listDirectories = async () => {
      throw new Error('offline')
    }
    expect(
      await openNewDraft((async () => {}) as never, {
        allowFilesystemTarget: true,
      }),
    ).toEqual({ kind: 'empty' })
  })
})
