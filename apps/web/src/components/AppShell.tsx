import { Outlet, useLocation } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'
import { Drawer } from 'vaul'
import { Sidebar } from './ui/sidebar'
import { AppBar } from './AppBar'
import { useShellStore } from '../stores/shell'
import { CommandPalette } from './palette/CommandPalette'
import { SessionSidebar } from './sidebar/SessionSidebar'
import { SettingsNav } from './settings/SettingsNav'
import { Toaster } from 'sonner'
import { resolveTheme } from '../lib/shell-storage'
import {
  handleShortcut,
  registerShortcuts,
  setShortcutOverrides,
} from '../lib/shortcuts'
import { useSettingsStore } from '../stores/settings'
import { useNavigate } from '@tanstack/react-router'
import { useSessionsStore } from '../stores/sessions'
import { ProjectCreationDialog } from './ProjectCreationDialog'
import { openNewDraft } from '../lib/draft-entry'
export function AppShell() {
  const location = useLocation()
  const store = useShellStore()
  const mainRef = useRef<HTMLElement>(null)
  const navigate = useNavigate()
  const loadSettings = useSettingsStore((state) => state.load)
  const isSettings = location.pathname.startsWith('/settings')
  const isSearch = location.pathname === '/search'
  const title = isSettings
    ? 'Settings'
    : location.pathname.startsWith('/runs')
      ? 'Runs'
      : location.pathname.startsWith('/files')
        ? 'Files'
        : 'Chat'
  useEffect(() => {
    void loadSettings()
      .then(() => {
        setShortcutOverrides(useSettingsStore.getState().settings.keybindings)
      })
      .catch(() => undefined)
  }, [loadSettings])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => handleShortcut(event)
    window.addEventListener('keydown', onKeyDown)
    const sessions = () => useSessionsStore.getState().sessions
    const go = (to: string) => void navigate({ to: to as never })
    const newDraft = () => void openNewDraft(navigate).catch(() => undefined)
    const unregister = registerShortcuts({
      'sidebar.toggle': store.toggleSidebar,
      'navigate.chat': () => go('/'),
      'navigate.runs': () => go('/runs'),
      'navigate.files': () => go('/files'),
      'navigate.settings': () => go('/settings'),
      'session.new': newDraft,
      'session.previous': () => {
        const list = sessions()
        const index = list.findIndex(
          (item) => item.id === location.pathname.slice(3),
        )
        const target = list[index > 0 ? index - 1 : list.length - 1]
        if (target)
          void navigate({
            to: '/s/$sessionId',
            params: { sessionId: target.id },
          })
      },
      'session.next': () => {
        const list = sessions()
        const index = list.findIndex(
          (item) => item.id === location.pathname.slice(3),
        )
        const target =
          list[index >= 0 && index < list.length - 1 ? index + 1 : 0]
        if (target)
          void navigate({
            to: '/s/$sessionId',
            params: { sessionId: target.id },
          })
      },
    })
    return () => {
      unregister()
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [location.pathname, navigate, store.toggleSidebar])
  useEffect(() => {
    if (isSettings) return
    const frame = window.requestAnimationFrame(() => mainRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [isSettings, location.pathname])
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      if (useShellStore.getState().theme === 'system') {
        document.documentElement.dataset.theme = media.matches
          ? 'dark'
          : 'light'
      }
    }
    media.addEventListener('change', apply)
    apply()
    return () => media.removeEventListener('change', apply)
  }, [])
  return (
    <div
      className={`app-shell desktop-shell phone-shell ${resolveTheme(store.theme)}`}
    >
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <CommandPalette />
      <ProjectCreationDialog />
      <div className="desktop-chrome">
        <Sidebar
          width={store.sidebarWidth}
          open={store.sidebarOpen}
          onResize={store.setSidebarWidth}
        >
          {isSettings ? <SettingsNav /> : <SessionSidebar />}
        </Sidebar>
      </div>
      <div className={`phone-chrome ${isSearch ? 'phone-chrome-hidden' : ''}`}>
        <AppBar title={title} />
        <Drawer.Root
          direction="left"
          open={store.drawerOpen}
          onOpenChange={store.setDrawerOpen}
        >
          <Drawer.Portal>
            <Drawer.Overlay className="drawer-overlay" />
            <Drawer.Content className="drawer">
              {isSettings ? <SettingsNav /> : <SessionSidebar />}
            </Drawer.Content>
          </Drawer.Portal>
        </Drawer.Root>
      </div>
      <main id="main-content" className="main" ref={mainRef} tabIndex={-1}>
        <Outlet />
      </main>
      <Toaster theme={resolveTheme(store.theme)} />
    </div>
  )
}
