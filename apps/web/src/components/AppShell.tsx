import { Outlet, useLocation, useRouter } from '@tanstack/react-router'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { ArrowLeft, ArrowRight, PanelLeft, Plus } from 'lucide-react'
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
import { navigationSessions } from './sidebar/sidebar-logic'
import { readSidebarView } from '../lib/shell-storage'
import { ProjectCreationDialog } from './ProjectCreationDialog'
import { openNewDraft } from '../lib/draft-entry'
import { Button } from './ui/button'
import { SessionHeader } from './chat/SessionHeader'
export function AppShell() {
  const location = useLocation()
  const router = useRouter()
  const store = useShellStore()
  const mainRef = useRef<HTMLElement>(null)
  const navigate = useNavigate()
  const loadSettings = useSettingsStore((state) => state.load)
  const isSettings = location.pathname.startsWith('/settings')
  const isSearch = location.pathname === '/search'
  const isDraft = location.pathname.startsWith('/draft/')
  const title = isSettings
    ? 'Settings'
    : location.pathname.startsWith('/runs')
      ? 'Runs'
      : location.pathname.startsWith('/files')
        ? 'Files'
        : 'Chat'
  const currentSession = useSessionsStore((state) =>
    state.sessions.find((item) => item.id === location.pathname.slice(3)),
  )
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const navigationBounds = useRef<{ min: number; max: number } | null>(null)
  const navigationPending = useRef(false)
  const resizeStart = useRef<{
    pointerId: number
    x: number
    width: number
  } | null>(null)
  useEffect(
    () => () => {
      resizeStart.current = null
    },
    [store.sidebarOpen],
  )
  const navigateBack = useCallback(() => {
    if (canGoBack && !navigationPending.current) {
      navigationPending.current = true
      router.history.back()
    }
  }, [canGoBack, router.history])
  const navigateForward = useCallback(() => {
    if (canGoForward && !navigationPending.current) {
      navigationPending.current = true
      router.history.forward()
    }
  }, [canGoForward, router.history])
  useEffect(() => {
    const history = router.history
    const update: Parameters<typeof history.subscribe>[0] = ({
      location,
      action,
    }) => {
      navigationPending.current = false
      const index = location.state.__TSR_index
      if (!Number.isFinite(index)) {
        setCanGoBack(false)
        setCanGoForward(false)
        return
      }
      const bounds = navigationBounds.current ?? { min: index, max: index }
      if (action.type === 'PUSH') bounds.max = index
      navigationBounds.current = bounds
      setCanGoBack(index > bounds.min && index <= bounds.max)
      setCanGoForward(index >= bounds.min && index < bounds.max)
    }
    update({ location: history.location, action: { type: 'REPLACE' } })
    return history.subscribe(update)
  }, [router.history])
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
    const sessions = () => {
      const view = readSidebarView()
      return navigationSessions(useSessionsStore.getState().sessions, view)
    }
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
        'phone-shell flex h-dvh flex-col',
        resolveTheme(store.theme),
      )}
    >
      <a
        className="fixed top-2 left-2 z-50 -translate-y-[150%] rounded-md bg-primary px-3 py-2 text-primary-foreground focus:translate-y-0"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault()
          const href = `${router.history.location.href.split('#')[0]}#main-content`
          if (href !== router.history.location.href) router.history.push(href)
          mainRef.current?.focus()
        }}
      >
        Skip to main content
      </a>
      <CommandPalette />
      <ProjectCreationDialog />
      <div className={cn('contents md:hidden', isSearch && 'hidden')}>
        <AppBar title={isDraft ? '' : title} />
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
      <header
        className={cn(
          'h-[38px] shrink-0 items-center border-b border-border bg-app-chrome px-2.5',
          currentSession ? 'flex' : 'hidden md:flex',
        )}
      >
        <div className="hidden shrink-0 translate-y-0.5 items-center gap-2 md:flex">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={store.sidebarOpen ? 'Collapse sidebar' : 'Open sidebar'}
            aria-pressed={store.sidebarOpen}
            onClick={store.toggleSidebar}
          >
            <PanelLeft />
          </Button>
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Go back"
              disabled={!canGoBack}
              onClick={navigateBack}
            >
              <ArrowLeft />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Go forward"
              disabled={!canGoForward}
              onClick={navigateForward}
            >
              <ArrowRight />
            </Button>
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="New session"
            onClick={() => void openNewDraft(navigate)}
          >
            <Plus />
          </Button>
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2 md:ml-3 md:translate-y-0.5">
          {currentSession && !isDraft ? (
            <SessionHeader embedded sessionId={currentSession.id} />
          ) : (
            <div className="min-w-0 truncate text-xs text-muted-foreground">
              {isDraft ? '' : title}
            </div>
          )}
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside
          className={cn(
            'shell-sidebar relative hidden shrink-0 border-r border-sidebar-border bg-sidebar md:flex',
            !store.sidebarOpen && 'md:w-0 md:border-r-0',
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
          {store.sidebarOpen && (
            <div className="h-full min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-3">
              {isSettings ? <SettingsNav /> : <SessionSidebar />}
            </div>
          )}
          {store.sidebarOpen && (
            <div
              role="separator"
              aria-label="Resize sidebar"
              aria-orientation="vertical"
              aria-valuenow={store.sidebarWidth}
              aria-valuemin={208}
              aria-valuemax={400}
              tabIndex={0}
              className="absolute top-0 -right-[3px] h-full w-1.5 touch-none cursor-ew-resize select-none outline-none focus-visible:bg-ring/50"
              onKeyDown={(event) => {
                if (
                  event.key !== 'ArrowLeft' &&
                  event.key !== 'ArrowRight' &&
                  event.key !== 'Home'
                )
                  return
                event.preventDefault()
                if (event.key === 'Home') {
                  store.resetSidebarWidth()
                  return
                }
                store.setSidebarWidth(
                  store.sidebarWidth + (event.key === 'ArrowRight' ? 16 : -16),
                )
              }}
              onPointerDown={(event) => {
                if (event.button !== 0 || resizeStart.current) return
                event.preventDefault()
                resizeStart.current = {
                  pointerId: event.pointerId,
                  x: event.clientX,
                  width: store.sidebarWidth,
                }
                event.currentTarget.setPointerCapture(event.pointerId)
              }}
              onPointerMove={(event) => {
                const start = resizeStart.current
                if (!start || event.pointerId !== start.pointerId) return
                store.setSidebarWidth(start.width + event.clientX - start.x)
              }}
              onPointerUp={(event) => {
                if (resizeStart.current?.pointerId !== event.pointerId) return
                resizeStart.current = null
                event.currentTarget.releasePointerCapture(event.pointerId)
              }}
              onPointerCancel={() => {
                resizeStart.current = null
              }}
              onLostPointerCapture={() => {
                resizeStart.current = null
              }}
              onDragStart={(event) => event.preventDefault()}
            />
          )}
        </aside>
        <main
          id="main-content"
          className="min-h-0 min-w-0 flex-1 overflow-auto outline-none focus-visible:outline-none md:overflow-hidden"
          ref={mainRef}
          tabIndex={-1}
        >
          <Outlet />
        </main>
        <Toaster theme={resolveTheme(store.theme)} />
      </div>
    </div>
  )
}
