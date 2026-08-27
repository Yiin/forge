import { create } from 'zustand'

export type DraftAttachment = {
  id: string
  name: string
  size: number
  mime: string
  attachmentId?: string
}
export type LocalDraft = {
  id: string
  projectId: string
  harness: string
  accountId?: string
  prompt: string
  createdAt: number
  updatedAt: number
  attachments: DraftAttachment[]
  promotionState: 'unpromoted' | 'promoting' | 'promoted' | 'failed'
}
type DraftPatch = Partial<
  Pick<
    LocalDraft,
    'harness' | 'accountId' | 'prompt' | 'attachments' | 'promotionState'
  >
>
type DraftState = {
  drafts: Record<string, LocalDraft>
  hydrated: boolean
  hydrate: () => void
  getOrCreate: (
    projectId: string,
    harness?: string,
    accountId?: string,
  ) => LocalDraft
  update: (id: string, patch: DraftPatch) => void
  remove: (id: string) => void
  removeInvalid: (projectIds: Iterable<string>) => void
  flush: () => void
}

const STORAGE_KEY = 'forge.local-drafts.v1'
let writeTimer: ReturnType<typeof setTimeout> | undefined
const canUseStorage = () =>
  typeof window !== 'undefined' && !!window.localStorage
const draftIdFor = (projectId: string) => `draft:${projectId}`

function readStorage(): Record<string, LocalDraft> {
  if (!canUseStorage()) return {}
  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? '{}',
    )
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(
      Object.entries(value).filter(([, draft]) => {
        if (!draft || typeof draft !== 'object') return false
        const item = draft as Partial<LocalDraft>
        return (
          typeof item.id === 'string' &&
          typeof item.projectId === 'string' &&
          typeof item.createdAt === 'number' &&
          typeof item.updatedAt === 'number' &&
          Array.isArray(item.attachments)
        )
      }),
    ) as Record<string, LocalDraft>
  } catch {
    return {}
  }
}

function scheduleWrite(drafts: Record<string, LocalDraft>) {
  if (!canUseStorage()) return
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = setTimeout(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts))
    writeTimer = undefined
  }, 150)
}

export const useDraftsStore = create<DraftState>((set, get) => ({
  drafts: {},
  hydrated: false,
  hydrate: () => {
    if (!get().hydrated) set({ drafts: readStorage(), hydrated: true })
  },
  getOrCreate: (projectId, harness = '', accountId) => {
    const stored = readStorage()
    const id = draftIdFor(projectId)
    const existing = get().drafts[id] ?? stored[id]
    if (existing) {
      set((state) => ({
        drafts: { ...state.drafts, [id]: existing },
        hydrated: true,
      }))
      return existing
    }
    const now = Date.now()
    const draft: LocalDraft = {
      id,
      projectId,
      harness,
      accountId,
      prompt: '',
      createdAt: now,
      updatedAt: now,
      attachments: [],
      promotionState: 'unpromoted',
    }
    const drafts = { ...stored, [id]: draft }
    set({ drafts, hydrated: true })
    scheduleWrite(drafts)
    return draft
  },
  update: (id, patch) =>
    set((state) => {
      const current = state.drafts[id]
      if (!current) return state
      const drafts = {
        ...state.drafts,
        [id]: { ...current, ...patch, updatedAt: Date.now() },
      }
      scheduleWrite(drafts)
      return { drafts }
    }),
  remove: (id) =>
    set((state) => {
      if (!state.drafts[id]) return state
      const drafts = { ...state.drafts }
      delete drafts[id]
      scheduleWrite(drafts)
      return { drafts }
    }),
  removeInvalid: (projectIds) =>
    set((state) => {
      const valid = new Set(projectIds)
      const drafts = Object.fromEntries(
        Object.entries(state.drafts).filter(([, draft]) =>
          valid.has(draft.projectId),
        ),
      )
      if (Object.keys(drafts).length !== Object.keys(state.drafts).length)
        scheduleWrite(drafts)
      return { drafts }
    }),
  flush: () => {
    if (!canUseStorage()) return
    if (writeTimer) clearTimeout(writeTimer)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(get().drafts))
    writeTimer = undefined
  },
}))

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY)
      useDraftsStore.setState({ drafts: readStorage(), hydrated: true })
  })
  window.addEventListener('beforeunload', () =>
    useDraftsStore.getState().flush(),
  )
}

export const resetDraftsStore = () => {
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = undefined
  useDraftsStore.setState({ drafts: {}, hydrated: false })
  if (canUseStorage()) window.localStorage.removeItem(STORAGE_KEY)
}
export const draftStorageKey = STORAGE_KEY
