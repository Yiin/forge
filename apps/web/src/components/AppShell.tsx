import { Outlet, useLocation } from '@tanstack/react-router'
import { useEffect, useRef, type CSSProperties } from 'react'
import { Drawer } from 'vaul'
import { AppBar } from './AppBar'
import { cn } from '@/lib/utils'
import { Toaster } from '@/components/ui/sonner'
import { useShellStore } from '../stores/shell'
import { CommandPalette } from './palette/CommandPalette'
import { SessionSidebar } from './sidebar/SessionSidebar'
import { SettingsNav } from './settings/SettingsNav'
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
      className={cn(
        // phone-shell is a bare hook for the e2e specs, not a styled class.
        'phone-shell flex h-dvh flex-col md:flex-row',
        resolveTheme(store.theme),
      )}
    >
      <a
        className="fixed top-2 left-2 z-50 -translate-y-[150%] rounded-md bg-primary px-3 py-2 text-primary-foreground focus:translate-y-0"
        href="#main-content"
      >
        Skip to main content
      </a>
      <CommandPalette />
      <ProjectCreationDialog />
      <aside
        className={cn(
          'relative hidden shrink-0 border-r border-sidebar-border bg-sidebar md:flex',
          !store.sidebarOpen && 'md:w-14',
        )}
        style={
          store.sidebarOpen
            ? ({
                '--sidebar-width': `${store.sidebarWidth}px`,
                width: 'var(--sidebar-width)',
              } as CSSProperties)
            : undefined
        }
      >
        <div className="h-full min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-3">
          {isSettings ? <SettingsNav /> : <SessionSidebar />}
        </div>
        <div
          role="separator"
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          aria-valuenow={store.sidebarWidth}
          aria-valuemin={216}
          aria-valuemax={360}
          tabIndex={0}
          className="absolute top-0 -right-[3px] h-full w-1.5 cursor-ew-resize outline-none focus-visible:bg-ring/50"
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            event.preventDefault()
            store.setSidebarWidth(
              store.sidebarWidth + (event.key === 'ArrowRight' ? 16 : -16),
            )
          }}
          onPointerDown={(event) => {
            const start = event.clientX
            const initial = store.sidebarWidth
            const move = (e: PointerEvent) =>
              store.setSidebarWidth(initial + e.clientX - start)
            const stop = () => {
              window.removeEventListener('pointermove', move)
              window.removeEventListener('pointerup', stop)
            }
            window.addEventListener('pointermove', move)
            window.addEventListener('pointerup', stop)
          }}
        />
      </aside>
      <div className={cn('contents md:hidden', isSearch && 'hidden')}>
        <AppBar title={title} />
        <Drawer.Root
          direction="left"
          open={store.drawerOpen}
          onOpenChange={store.setDrawerOpen}
        >
          <Drawer.Portal>
            <Drawer.Overlay className="fixed inset-0 z-40 bg-black/50" />
            <Drawer.Content className="drawer fixed inset-y-0 left-0 z-50 w-[min(86vw,320px)] bg-sidebar p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] outline-none">
              {isSettings ? <SettingsNav /> : <SessionSidebar />}
            </Drawer.Content>
          </Drawer.Portal>
        </Drawer.Root>
      </div>
      <main
        id="main-content"
        className="min-w-0 flex-1 overflow-auto md:overflow-hidden"
        ref={mainRef}
        tabIndex={-1}
      >
        <Outlet />
      </main>
      <Toaster theme={resolveTheme(store.theme)} />
    </div>
  )
}
