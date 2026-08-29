import { create } from 'zustand'
export type SessionSummary = {
  id: string
  title: string
  projectId?: string | null
  kind?: string
  parentSessionId?: string | null
  spawnedBySeq?: number | null
  status?: string
  harness?: string
  accountId?: string | null
  createdAt?: string
  created_at?: number
  project_id?: string | null
  lastActivityAt?: number | string
  deletedAt?: number | null
  snippet?: string
  unread?: boolean
  forkedAtSeq?: number | null
  contextMethod?: string | null
  contextConfidence?: string | null
  retention?: 'permanent' | 'discardable'
}
export type ProjectSummary = {
  id: string
  name: string
  path?: string
  createdAt?: number
  archivedAt?: number | null
}
// Callers merge session lists from multiple sources (REST fetch, child-session
// lookups, websocket replay); a mis-scoped filter upstream can hand back the
// same id twice. Dedupe here so the store's invariant (unique ids) always
// holds, keeping the last occurrence since it reflects the newest data.
export function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const byId = new Map(items.map((item) => [item.id, item]))
  return [...byId.values()]
}

type SessionsState = {
  sessions: SessionSummary[]
  projects: ProjectSummary[]
  setSessions: (sessions: SessionSummary[]) => void
  setProjects: (projects: ProjectSummary[]) => void
  upsertSession: (session: SessionSummary) => void
  removeSession: (id: string) => void
}
export const useSessionsStore = create<SessionsState>((set) => ({
  sessions: [],
  projects: [],
  setSessions: (sessions) => set({ sessions: dedupeById(sessions) }),
  setProjects: (projects) => set({ projects }),
  upsertSession: (session) =>
    set((state) => ({
      sessions: state.sessions.some((item) => item.id === session.id)
        ? state.sessions.map((item) =>
            item.id === session.id ? { ...item, ...session } : item,
          )
        : [...state.sessions, session],
    })),
  removeSession: (id) =>
    set((state) => ({
      sessions: state.sessions.filter((session) => session.id !== id),
    })),
}))
