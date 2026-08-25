import { Link, Outlet, useLocation } from '@tanstack/react-router'
import { Drawer } from 'vaul'
import { Moon, Plus, Settings, Sun } from 'lucide-react'
import { Sidebar } from './ui/sidebar'
import { AppBar } from './AppBar'
import { useShellStore } from '../stores/shell'
function Navigation({ settings = false }: { settings?: boolean }) {
  return (
    <nav className="nav">
      <div className="brand">forge</div>
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
          <Link to="/search">Search</Link>
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
          {useShellStore.getState().theme === 'dark' ? (
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
      <div className="desktop-shell">
        <Sidebar width={store.sidebarWidth} onResize={store.setSidebarWidth}>
          <Navigation settings={isSettings} />
        </Sidebar>
        <main className="main">
          <Outlet />
        </main>
      </div>
      <div className="phone-shell">
        <AppBar title={isSettings ? 'Settings' : 'Forge'} />
        <main className="main">
          <Outlet />
        </main>
        <Drawer.Root open={store.drawerOpen} onOpenChange={store.setDrawerOpen}>
          <Drawer.Portal>
            <Drawer.Overlay className="drawer-overlay" />
            <Drawer.Content className="drawer">
              <Navigation settings={isSettings} />
            </Drawer.Content>
          </Drawer.Portal>
        </Drawer.Root>
      </div>
    </div>
  )
}
