import { create } from 'zustand'
export type SessionSummary = { id: string; title: string; projectId?: string }
type SessionsState = {
  sessions: SessionSummary[]
  setSessions: (sessions: SessionSummary[]) => void
}
export const useSessionsStore = create<SessionsState>((set) => ({
  sessions: [],
  setSessions: (sessions) => set({ sessions }),
}))
