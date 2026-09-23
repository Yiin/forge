import { Link } from '@tanstack/react-router'
import {
  Bell,
  ChevronLeft,
  Folder,
  FolderGit2,
  KeyRound,
  Keyboard,
  LayoutGrid,
  Settings2,
  SlidersHorizontal,
  Workflow,
} from 'lucide-react'
import { useShellStore } from '../../stores/shell'

const items = [
  ['/settings/general', 'General', Settings2],
  ['/settings/agents', 'Agents', LayoutGrid],
  ['/settings/accounts', 'Accounts', KeyRound],
  ['/settings/appearance', 'Appearance', SlidersHorizontal],
  ['/settings/files', 'Files', Folder],
  ['/settings/notifications', 'Notifications', Bell],
  ['/settings/shortcuts', 'Shortcuts', Keyboard],
  ['/settings/projects', 'Projects', FolderGit2],
  ['/settings/epics', 'Epics', Workflow],
] as const

const rowClass =
  'flex items-center rounded-lg px-2 py-1.5 text-[13px] outline-none pointer-coarse:min-h-11 hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-safe:transition-colors motion-safe:duration-150'

export function SettingsNav() {
  const setDrawerOpen = useShellStore((state) => state.setDrawerOpen)
  return (
    <nav aria-label="Settings" className="flex min-h-full flex-col">
      <p className="px-2 pt-3 pb-1 text-[11px] font-medium text-muted-foreground/60">
        Settings
      </p>
      <ul className="flex flex-col gap-0.5">
        {items.map(([to, label, Icon]) => (
          <li key={to}>
            <Link
              to={to}
              activeOptions={{ exact: true }}
              activeProps={{
                className: 'bg-sidebar-accent font-medium text-foreground',
                'aria-current': 'page',
              }}
              inactiveProps={{ className: 'text-muted-foreground' }}
              onClick={() => setDrawerOpen(false)}
              className={`${rowClass} gap-2`}
            >
              <Icon size={16} className="shrink-0 text-muted-foreground" />
              {label}
            </Link>
          </li>
        ))}
      </ul>
      <div className="mt-auto pt-3">
        <button
          type="button"
          onClick={() => {
            setDrawerOpen(false)
            window.history.back()
          }}
          className={`${rowClass} w-full gap-1.5 text-muted-foreground`}
        >
          <ChevronLeft size={16} className="shrink-0 text-muted-foreground" />
          Back
        </button>
      </div>
    </nav>
  )
}
