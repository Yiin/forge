import { create } from 'zustand'
import {
  reviewNotesSchema,
  type ReviewAnchor,
  type ReviewNote,
} from '@forge/protocol/review'

const key = 'forge.review-notes.v1'
const maxStorage = 1_048_576
function read(): Record<string, ReviewNote[]> {
  try {
    const raw = localStorage.getItem(key)
    if (!raw || raw.length > maxStorage) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return {}
    const entries = Object.entries(parsed)
    if (entries.length > 32) return {}
    const result: Record<string, ReviewNote[]> = {}
    let count = 0
    for (const [id, value] of entries) {
      if (!id || id.length > 256) return {}
      const notes = reviewNotesSchema.parse(value)
      count += notes.length
      if (count > 64) return {}
      result[id] = notes
    }
    return result
  } catch {
    return {}
  }
}
type State = {
  sessions: Record<string, ReviewNote[]>
  hydrated: boolean
  hydrate: () => void
  save: (sessionId: string, notes: ReviewNote[]) => void
  acknowledge: (
    sessionId: string,
    submitted: ReviewNote[],
  ) => string | undefined
  reanchor: (sessionId: string, id: string, anchor: ReviewAnchor) => void
}
export const useReviewNotes = create<State>((set, get) => ({
  sessions: {},
  hydrated: false,
  hydrate: () => {
    if (!get().hydrated) set({ sessions: read(), hydrated: true })
  },
  save: (sessionId, notes) => {
    const captured = reviewNotesSchema.parse(notes)
    const sessions = { ...get().sessions }
    if (captured.length) sessions[sessionId] = captured
    else delete sessions[sessionId]
    if (
      Object.keys(sessions).length > 32 ||
      Object.values(sessions).reduce(
        (count, entries) => count + entries.length,
        0,
      ) > 64
    )
      throw new Error('Remove a review note before adding another')
    const encoded = JSON.stringify(sessions)
    if (encoded.length > maxStorage)
      throw new Error('Review notes exceed the draft storage limit')
    localStorage.setItem(key, encoded)
    set({ sessions, hydrated: true })
  },
  acknowledge: (sessionId, submitted) => {
    const sent = new Map(
      submitted.map((note) => [note.id, JSON.stringify(note)]),
    )
    const remaining = (get().sessions[sessionId] ?? []).filter(
      (note) => sent.get(note.id) !== JSON.stringify(note),
    )
    const sessions = { ...get().sessions }
    if (remaining.length) sessions[sessionId] = remaining
    else delete sessions[sessionId]
    set({ sessions, hydrated: true })
    try {
      localStorage.setItem(key, JSON.stringify(sessions))
    } catch {
      return 'Prompt accepted. Review draft cleanup could not be saved. Old notes may return after reload.'
    }
    return undefined
  },
  reanchor: (sessionId, id, anchor) =>
    get().save(
      sessionId,
      (get().sessions[sessionId] ?? []).map((note) =>
        note.id === id ? { ...note, anchor } : note,
      ),
    ),
}))
export const emptyReviewNotes: ReviewNote[] = []
