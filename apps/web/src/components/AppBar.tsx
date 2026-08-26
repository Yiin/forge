import { ArrowLeft, Menu, Search } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { useShellStore } from '../stores/shell'
export function AppBar({
  title = 'Forge',
  children,
  showBack = false,
}: {
  title?: string
  children?: React.ReactNode
  showBack?: boolean
}) {
  const navigate = useNavigate()
  const setDrawerOpen = useShellStore((s) => s.setDrawerOpen)
  return (
    <header className="app-bar">
      <button
        className="icon-button"
        onClick={() => (showBack ? window.history.back() : setDrawerOpen(true))}
        aria-label={showBack ? 'Go back' : 'Open navigation'}
      >
        {showBack ? <ArrowLeft size={20} /> : <Menu size={20} />}
      </button>
      <strong>{title}</strong>
      <span className="app-bar-spacer" />
      {children}
      <button
        className="icon-button"
        onClick={() => navigate({ to: '/search', search: { q: '' } })}
        aria-label="Search"
      >
        <Search size={19} />
      </button>
    </header>
  )
}
