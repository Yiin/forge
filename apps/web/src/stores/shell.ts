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
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_MAX,
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
  resetSidebarWidth: () => void
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
    const next = Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, width))
    writeSidebarWidth(next)
    set({ sidebarWidth: next })
  },
  resetSidebarWidth: () => {
    writeSidebarWidth(SIDEBAR_WIDTH_DEFAULT)
    set({ sidebarWidth: SIDEBAR_WIDTH_DEFAULT })
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
