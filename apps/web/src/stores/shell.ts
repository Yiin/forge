import { create } from 'zustand'
import {
  readLastSession,
  clearLastSession,
  readSidebarWidth,
  readTheme,
  writeLastSession,
  writeSidebarWidth,
  writeTheme,
  resolveTheme,
  type Theme,
} from '../lib/shell-storage'

type ShellState = {
  sidebarOpen: boolean
  drawerOpen: boolean
  sidebarWidth: number
  theme: Theme
  lastSessionId: string | null
  toggleSidebar: () => void
  setDrawerOpen: (open: boolean) => void
  setSidebarWidth: (width: number) => void
  toggleTheme: () => void
  setTheme: (theme: Theme) => void
  setLastSession: (id: string) => void
  clearLastSession: () => void
}
export const useShellStore = create<ShellState>((set, get) => ({
  sidebarOpen: true,
  drawerOpen: false,
  sidebarWidth: readSidebarWidth(),
  theme: readTheme(),
  lastSessionId: readLastSession(),
  toggleSidebar: () =>
    set(({ sidebarOpen }) => ({ sidebarOpen: !sidebarOpen })),
  setDrawerOpen: (drawerOpen) => set({ drawerOpen }),
  setSidebarWidth: (width) => {
    writeSidebarWidth(width)
    set({ sidebarWidth: width })
  },
  toggleTheme: () => {
    const theme = get().theme === 'dark' ? 'light' : 'dark'
    get().setTheme(theme)
  },
  setTheme: (theme) => {
    writeTheme(theme)
    set({ theme })
    document.documentElement.dataset.theme = resolveTheme(theme)
  },
  setLastSession: (id) => {
    writeLastSession(id)
    set({ lastSessionId: id })
  },
  clearLastSession: () => {
    clearLastSession()
    set({ lastSessionId: null })
  },
}))
