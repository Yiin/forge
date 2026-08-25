import { Menu, Search } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { useShellStore } from '../stores/shell'
export function AppBar({
  title = 'Forge',
  children,
}: {
  title?: string
  children?: React.ReactNode
}) {
  const navigate = useNavigate()
  const setDrawerOpen = useShellStore((s) => s.setDrawerOpen)
  return (
    <header className="app-bar">
      <button
        className="icon-button"
        onClick={() => setDrawerOpen(true)}
        aria-label="Open navigation"
      >
        <Menu size={20} />
      </button>
      <strong>{title}</strong>
      <span className="app-bar-spacer" />
      {children}
      <button
        className="icon-button"
        onClick={() => navigate({ to: '/search' })}
        aria-label="Search"
      >
        <Search size={19} />
      </button>
    </header>
  )
}
