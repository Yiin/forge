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
    <nav className="settings-nav">
      <p className="eyebrow">Workspace</p>
      {items.map(([to, label, Icon]) => (
        <Link
          key={to}
          to={to}
          activeOptions={{ exact: true }}
          activeProps={{ className: 'active', 'aria-current': 'page' }}
          onClick={() => setDrawerOpen(false)}
        >
          <Icon size={16} />
          {label}
        </Link>
      ))}
    </nav>
  )
}
