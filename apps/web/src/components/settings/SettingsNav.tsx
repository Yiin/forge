import { Link } from '@tanstack/react-router'
import { Settings, Cpu, Folder, Workflow, Keyboard } from 'lucide-react'
import { useShellStore } from '../../stores/shell'

const items = [
  ['/settings/general', 'General', Settings],
  ['/settings/keybindings', 'Keybindings', Keyboard],
  ['/settings/harnesses', 'Harnesses', Cpu],
  ['/settings/projects', 'Projects', Folder],
  ['/settings/epics', 'Epics', Workflow],
] as const

export function SettingsNav() {
  const setDrawerOpen = useShellStore((state) => state.setDrawerOpen)
  return (
    <nav className="flex flex-col gap-1 p-2">
      <p className="px-2.5 py-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Workspace
      </p>
      {items.map(([to, label, Icon]) => (
        <Link
          key={to}
          to={to}
          activeOptions={{ exact: true }}
          activeProps={{
            className: 'bg-sidebar-accent font-medium',
            'aria-current': 'page',
          }}
          onClick={() => setDrawerOpen(false)}
          className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-foreground hover:bg-sidebar-accent"
        >
          <Icon size={16} className="shrink-0 text-muted-foreground" />
          {label}
        </Link>
      ))}
    </nav>
  )
}
