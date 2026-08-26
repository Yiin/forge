import { Link, Outlet, useLocation } from '@tanstack/react-router'
import { Drawer } from 'vaul'
import { Moon, Plus, Search, Settings, Sun } from 'lucide-react'
import { Sidebar } from './ui/sidebar'
import { AppBar } from './AppBar'
import { useShellStore } from '../stores/shell'
import { CommandPalette } from './palette/CommandPalette'
import { SessionSidebar } from './sidebar/SessionSidebar'
function Navigation({ settings = false }: { settings?: boolean }) {
  const theme = useShellStore((state) => state.theme)
  return (
    <nav className="nav">
      <div className="brand">forge</div>
      {!settings && (
        <button
          className="nav-search"
          onClick={() =>
            window.dispatchEvent(
              new KeyboardEvent('keydown', { key: 'k', metaKey: true }),
            )
          }
        >
          <Search size={16} /> Search
        </button>
      )}
      {settings ? (
        <>
          <Link to="/settings">General</Link>
          <Link to="/settings/harnesses">Harnesses</Link>
          <Link to="/settings/projects">Projects</Link>
          <Link to="/settings/about">About</Link>
        </>
      ) : (
        <>
          <Link to="/" className="new-session">
            <Plus size={16} /> New session
          </Link>
          <Link to="/runs">Epic runs</Link>
          <Link to="/search" search={{ q: '', scope: 'all' }}>
            Search
          </Link>
          <Link to="/settings">
            <Settings size={16} /> Settings
          </Link>
        </>
      )}
      <div className="nav-footer">
        <button
          className="text-button"
          onClick={() => useShellStore.getState().toggleTheme()}
        >
          {theme === 'dark' ? (
            <Sun size={16} />
          ) : (
            <Moon size={16} />
          )}{' '}
          Theme
        </button>
      </div>
    </nav>
  )
}
export function AppShell() {
  const location = useLocation()
  const store = useShellStore()
  const isSettings = location.pathname.startsWith('/settings')
  return (
    <div className={`app-shell ${store.theme}`}>
      <CommandPalette />
      <div className="desktop-shell">
        <Sidebar width={store.sidebarWidth} onResize={store.setSidebarWidth}>
          {isSettings ? <Navigation settings /> : <SessionSidebar />}
        </Sidebar>
        <main className="main">
          <Outlet />
        </main>
      </div>
      <div className="phone-shell">
        <AppBar
          title={isSettings ? 'Settings' : 'Forge'}
          showBack={location.pathname === '/search'}
        />
        <main className="main">
          <Outlet />
        </main>
        <Drawer.Root open={store.drawerOpen} onOpenChange={store.setDrawerOpen}>
          <Drawer.Portal>
            <Drawer.Overlay className="drawer-overlay" />
            <Drawer.Content className="drawer">
              {isSettings ? <Navigation settings /> : <SessionSidebar />}
            </Drawer.Content>
          </Drawer.Portal>
        </Drawer.Root>
      </div>
    </div>
  )
}
