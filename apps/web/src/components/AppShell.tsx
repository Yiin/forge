import { Outlet, useLocation } from '@tanstack/react-router'
import { Drawer } from 'vaul'
import { Sidebar } from './ui/sidebar'
import { AppBar } from './AppBar'
import { useShellStore } from '../stores/shell'
import { CommandPalette } from './palette/CommandPalette'
import { SessionSidebar } from './sidebar/SessionSidebar'
import { SettingsNav } from './settings/SettingsNav'
export function AppShell() {
  const location = useLocation()
  const store = useShellStore()
  const isSettings = location.pathname.startsWith('/settings')
  return (
    <div className={`app-shell desktop-shell phone-shell ${store.theme}`}>
      <CommandPalette />
      <div className="desktop-chrome">
        <Sidebar width={store.sidebarWidth} onResize={store.setSidebarWidth}>
          {isSettings ? <SettingsNav /> : <SessionSidebar />}
        </Sidebar>
      </div>
      <div className="phone-chrome">
        <AppBar
          title={isSettings ? 'Settings' : 'Forge'}
          showBack={location.pathname === '/search'}
        />
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
      <main className="main">
        <Outlet />
      </main>
    </div>
  )
}
