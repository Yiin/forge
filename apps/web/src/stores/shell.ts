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

export type DockSurfaceKind =
  'files' | 'file' | 'diff' | 'history' | 'terminal' | 'browser' | 'subagent'

export type DockTab = {
  id: string
  kind: DockSurfaceKind
  title: string
  path?: string
  childSessionId?: string
  nativeChildId?: string
  commit?: string
}

export type SessionDockState = {
  open: boolean
  takeover: boolean
  activeTabId: string | null
  tabs: DockTab[]
}

export const DEFAULT_DOCK_STATE: SessionDockState = {
  open: false,
  takeover: false,
  activeTabId: null,
  tabs: [],
}

export const DOCK_CHAT_MIN_WIDTH = 300
export const DOCK_WIDTH_DEFAULT = 480
export const DOCK_WIDTH_MIN = 320
export const DOCK_WIDTH_MAX = 900

const DOCK_KEY = 'forge.shell.dock'
type DockStorage = { sessions: Record<string, SessionDockState>; width: number }

function readDock(): DockStorage {
  try {
    const value = JSON.parse(
      localStorage.getItem(DOCK_KEY) ?? '{}',
    ) as Partial<DockStorage>
    return {
      sessions: value.sessions ?? {},
      width: Math.min(
        DOCK_WIDTH_MAX,
        Math.max(DOCK_WIDTH_MIN, value.width ?? DOCK_WIDTH_DEFAULT),
      ),
    }
  } catch {
    return { sessions: {}, width: DOCK_WIDTH_DEFAULT }
  }
}

function writeDock(value: DockStorage) {
  localStorage.setItem(DOCK_KEY, JSON.stringify(value))
}

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
  dockWidth: number
  docks: Record<string, SessionDockState>
  dock: (sessionId: string) => SessionDockState
  openDock: (sessionId: string, tab?: DockTab) => void
  closeDock: (sessionId: string) => void
  setDockTakeover: (sessionId: string, takeover: boolean) => void
  setDockWidth: (width: number) => void
  openDockTab: (sessionId: string, tab: DockTab) => void
  closeDockTab: (sessionId: string, tabId: string) => void
  setActiveDockTab: (sessionId: string, tabId: string) => void
  reorderDockTabs: (sessionId: string, tabIds: string[]) => void
}
const initialDock = readDock()
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
    if (next === get().sidebarWidth) return
    writeSidebarWidth(next)
    set({ sidebarWidth: next })
  },
  resetSidebarWidth: () => get().setSidebarWidth(SIDEBAR_WIDTH_DEFAULT),
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
  dockWidth: initialDock.width,
  docks: initialDock.sessions,
  dock: (sessionId) => get().docks[sessionId] ?? DEFAULT_DOCK_STATE,
  openDock: (sessionId, tab) => {
    const current = get().dock(sessionId)
    const next = tab
      ? {
          ...current,
          open: true,
          activeTabId: tab.id,
          tabs: current.tabs.some((item) => item.id === tab.id)
            ? current.tabs
            : [...current.tabs, tab],
        }
      : { ...current, open: true }
    const docks = { ...get().docks, [sessionId]: next }
    writeDock({ sessions: docks, width: get().dockWidth })
    set({ docks })
  },
  closeDock: (sessionId) => {
    const docks = {
      ...get().docks,
      [sessionId]: { ...get().dock(sessionId), open: false, takeover: false },
    }
    writeDock({ sessions: docks, width: get().dockWidth })
    set({ docks })
  },
  setDockTakeover: (sessionId, takeover) => {
    const docks = {
      ...get().docks,
      [sessionId]: { ...get().dock(sessionId), takeover, open: true },
    }
    writeDock({ sessions: docks, width: get().dockWidth })
    set({ docks })
  },
  setDockWidth: (width) => {
    const dockWidth = Math.min(DOCK_WIDTH_MAX, Math.max(DOCK_WIDTH_MIN, width))
    writeDock({ sessions: get().docks, width: dockWidth })
    set({ dockWidth })
  },
  openDockTab: (sessionId, tab) => get().openDock(sessionId, tab),
  closeDockTab: (sessionId, tabId) => {
    const current = get().dock(sessionId)
    const index = current.tabs.findIndex((tab) => tab.id === tabId)
    const tabs = current.tabs.filter((tab) => tab.id !== tabId)
    const nextActive =
      current.activeTabId === tabId
        ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null)
        : current.activeTabId
    const docks = {
      ...get().docks,
      [sessionId]: {
        ...current,
        tabs,
        activeTabId: nextActive,
        open: tabs.length > 0 ? current.open : false,
      },
    }
    writeDock({ sessions: docks, width: get().dockWidth })
    set({ docks })
  },
  setActiveDockTab: (sessionId, tabId) => {
    const current = get().dock(sessionId)
    if (!current.tabs.some((tab) => tab.id === tabId)) return
    const docks = {
      ...get().docks,
      [sessionId]: { ...current, activeTabId: tabId, open: true },
    }
    writeDock({ sessions: docks, width: get().dockWidth })
    set({ docks })
  },
  reorderDockTabs: (sessionId, tabIds) => {
    const current = get().dock(sessionId)
    const byId = new Map(current.tabs.map((tab) => [tab.id, tab]))
    const tabs = tabIds
      .map((id) => byId.get(id))
      .filter((tab): tab is DockTab => Boolean(tab))
    if (tabs.length !== current.tabs.length) return
    const docks = { ...get().docks, [sessionId]: { ...current, tabs } }
    writeDock({ sessions: docks, width: get().dockWidth })
    set({ docks })
  },
}))
