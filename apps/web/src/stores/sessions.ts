import { create } from 'zustand'
export type SessionSummary = { id: string; title: string; projectId?: string }
type SessionsState = {
  sessions: SessionSummary[]
  setSessions: (sessions: SessionSummary[]) => void
  upsertSession: (session: SessionSummary) => void
  removeSession: (id: string) => void
}
export const useSessionsStore = create<SessionsState>((set) => ({
  sessions: [],
  setSessions: (sessions) => set({ sessions }),
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
