import { api } from './api'
import { useDraftsStore, type LocalDraft } from '../stores/drafts'

export type DraftPromotionInput = {
  text: string
  attachmentIds?: string[]
  harness: string
  accountId?: string
}

function newPromotionKey() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
}

// One idempotency key per promotion ATTEMPT, never per draft: drafts are one
// per project and reused across sessions. The key is persisted before the
// request so a reload mid-flight retries with the same key, kept on failure
// so the retry dedupes server-side, and cleared on success so the next send
// from this draft creates a new session.
export async function promoteDraftWithKey(
  draft: LocalDraft,
  input: DraftPromotionInput,
  promote: (
    ...args: Parameters<typeof api.promoteDraft>
  ) => ReturnType<typeof api.promoteDraft> = api.promoteDraft.bind(api),
): Promise<{ sessionId: string }> {
  const promotionKey = draft.promotionKey ?? newPromotionKey()
  useDraftsStore.getState().update(draft.id, {
    promotionState: 'promoting',
    promotionKey,
  })
  try {
    const result = (await promote(
      {
        draftId: draft.id,
        projectId: draft.projectId,
        harness: input.harness || draft.harness,
        accountId: input.accountId,
        text: input.text,
        attachmentIds: input.attachmentIds,
      },
      promotionKey,
    )) as { sessionId: string }
    useDraftsStore.getState().update(draft.id, {
      promotionState: 'promoted',
      promotionKey: undefined,
    })
    return result
  } catch (error) {
    useDraftsStore.getState().update(draft.id, { promotionState: 'failed' })
    throw error
  }
}
