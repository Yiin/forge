// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { promoteDraftWithKey } from './draft-promotion'
import { resetDraftsStore, useDraftsStore } from '../stores/drafts'

type PromoteCall = { input: { draftId: string; workspace?: { mode: string; baseRef?: string } }; requestId: string }

function fakePromote(behavior: 'ok' | 'fail' = 'ok'): {
  calls: PromoteCall[]
  promote: (input: PromoteCall['input'], requestId: string) => Promise<unknown>
} {
  const calls: PromoteCall[] = []
  return {
    calls,
    promote: async (input, requestId) => {
      calls.push({ input, requestId })
      if (behavior === 'fail') throw new Error('network down')
      return { sessionId: `session-${calls.length}` }
    },
  }
}

describe('draft promotion keys', () => {
  beforeEach(() => {
    window.localStorage.clear()
    resetDraftsStore()
  })

  it('persists a key before the request and clears it on success', async () => {
    const draft = useDraftsStore.getState().getOrCreate('project-1', 'acp')
    const { calls, promote } = fakePromote()

    const result = await promoteDraftWithKey(
      draft,
      {
        text: 'hello',
        harness: 'acp',
        clientItemId: 'client_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        workspace: { mode: 'worktree', baseRef: 'main' },
      },
      promote as never,
    )

    expect(result).toEqual({ sessionId: 'session-1' })
    expect(calls).toHaveLength(1)
    expect(calls[0].requestId).toBeTruthy()
    expect(calls[0].input.workspace).toEqual({ mode: 'worktree', baseRef: 'main' })
    const saved = useDraftsStore.getState().drafts[draft.id]
    expect(saved.promotionState).toBe('promoted')
    expect(saved.promotionKey).toBeUndefined()
  })

  it('keeps the key on failure so a retry dedupes server-side', async () => {
    const draft = useDraftsStore.getState().getOrCreate('project-1', 'acp')
    const failing = fakePromote('fail')

    await expect(
      promoteDraftWithKey(
        draft,
        {
          text: 'hello',
          harness: 'acp',
          clientItemId: 'client_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
        failing.promote as never,
      ),
    ).rejects.toThrow('network down')

    const afterFailure = useDraftsStore.getState().drafts[draft.id]
    expect(afterFailure.promotionState).toBe('failed')
    expect(afterFailure.promotionKey).toBe(failing.calls[0].requestId)

    const retry = fakePromote()
    await promoteDraftWithKey(
      afterFailure,
      {
        text: 'hello',
        harness: 'acp',
        clientItemId: 'client_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
      retry.promote as never,
    )
    expect(retry.calls[0].requestId).toBe(failing.calls[0].requestId)
  })

  it('uses a fresh key for the next promotion after a success', async () => {
    const draft = useDraftsStore.getState().getOrCreate('project-1', 'acp')
    const first = fakePromote()
    await promoteDraftWithKey(
      draft,
      {
        text: 'one',
        harness: 'acp',
        clientItemId: 'client_cccccccccccccccccccccccccccccccc',
      },
      first.promote as never,
    )

    const second = fakePromote()
    const reusedDraft = useDraftsStore.getState().drafts[draft.id]
    await promoteDraftWithKey(
      reusedDraft,
      {
        text: 'two',
        harness: 'acp',
        clientItemId: 'client_dddddddddddddddddddddddddddddddd',
      },
      second.promote as never,
    )

    expect(second.calls[0].requestId).not.toBe(first.calls[0].requestId)
  })
})
