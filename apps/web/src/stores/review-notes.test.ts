// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { useReviewNotes } from './review-notes'
import type { ReviewNote } from '@forge/protocol/review'
const note = (id = 'one'): ReviewNote => ({
  id,
  body: 'Keep exact citation',
  anchor: {
    workspaceId: 'workspace',
    workspaceRevision: 1,
    revision: { kind: 'git', scope: 'working', revision: 'original' },
    oldPath: 'old.ts',
    newPath: 'new.ts',
    side: 'old',
    line: 2,
  },
})
beforeEach(() => {
  localStorage.clear()
  useReviewNotes.setState({ sessions: {}, hydrated: false })
})
afterEach(() => vi.restoreAllMocks())
it('retains separate session notes through reload and failed sends', () => {
  useReviewNotes.getState().save('a', [note()])
  useReviewNotes.getState().save('b', [note('other')])
  useReviewNotes.setState({ sessions: {}, hydrated: false })
  useReviewNotes.getState().hydrate()
  expect(useReviewNotes.getState().sessions).toEqual({
    a: [note()],
    b: [note('other')],
  })
})
it('acknowledges only unchanged submitted notes after a held send', () => {
  const original = note()
  useReviewNotes.getState().save('a', [original])
  useReviewNotes.getState().save('a', [original, note('later')])
  useReviewNotes.getState().acknowledge('a', [original])
  expect(useReviewNotes.getState().sessions.a).toEqual([note('later')])
})
it('preserves stable ID and body on explicit reanchor and retains edits made during send', () => {
  const original = note()
  useReviewNotes.getState().save('a', [original])
  const anchor = {
    ...original.anchor,
    line: 3,
    revision: {
      kind: 'git' as const,
      scope: 'working' as const,
      revision: 'new',
    },
  }
  useReviewNotes.getState().reanchor('a', original.id, anchor)
  useReviewNotes.getState().acknowledge('a', [original])
  expect(useReviewNotes.getState().sessions.a).toEqual([
    { ...original, anchor },
  ])
})
it('keeps successful admission in memory when draft storage refuses acknowledgement', () => {
  const original = note()
  useReviewNotes.getState().save('a', [original])
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw Error('blocked')
  })
  expect(useReviewNotes.getState().acknowledge('a', [original])).toMatch(
    /^Prompt accepted/,
  )
  expect(useReviewNotes.getState().sessions.a).toBeUndefined()
  useReviewNotes.getState().hydrate()
  expect(useReviewNotes.getState().sessions.a).toBeUndefined()
})
it('refuses a 65th retained note without deleting another session', () => {
  useReviewNotes.getState().save(
    'a',
    Array.from({ length: 64 }, (_, i) => note(String(i))),
  )
  expect(() => useReviewNotes.getState().save('b', [note()])).toThrow(/Remove/)
  expect(useReviewNotes.getState().sessions.a).toHaveLength(64)
})
