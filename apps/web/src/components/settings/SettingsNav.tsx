import { Link } from '@tanstack/react-router'
import { Settings, Cpu, Folder, Workflow, Info } from 'lucide-react'

const items = [
  ['/settings', 'General', Settings],
  ['/settings/harnesses', 'Harnesses', Cpu],
  ['/settings/projects', 'Projects', Folder],
  ['/settings/epics', 'Epics', Workflow],
  ['/settings/about', 'About', Info],
] as const

export function SettingsNav() {
  return (
    <nav className="settings-nav">
      <p className="eyebrow">Workspace</p>
      {items.map(([to, label, Icon]) => (
        <Link
          key={to}
          to={to}
          activeProps={{ className: 'active', 'aria-current': 'page' }}
        >
          <Icon size={16} />
          {label}
        </Link>
      ))}
    </nav>
  )
}
