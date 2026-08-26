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
  setSessions: (sessions) => set({ sessions }),
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
