import { ArrowLeft, Menu, Search } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
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
    <TooltipProvider delay={300}>
      <header className="flex h-12 items-center gap-1 border-b border-border bg-background px-2">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className="size-11 shrink-0"
                onClick={() =>
                  showBack ? window.history.back() : setDrawerOpen(true)
                }
                aria-label={showBack ? 'Go back' : 'Open navigation'}
              />
            }
          >
            {showBack ? (
              <ArrowLeft className="size-5" />
            ) : (
              <Menu className="size-5" />
            )}
          </TooltipTrigger>
          <TooltipContent>
            {showBack ? 'Go back' : 'Open navigation'}
          </TooltipContent>
        </Tooltip>
        <strong className="min-w-0 flex-1 truncate px-1 text-sm font-semibold">
          {title}
        </strong>
        {children}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className="size-11 shrink-0"
                onClick={() =>
                  navigate({ to: '/search', search: { q: '', scope: 'all' } })
                }
                aria-label="Search"
              />
            }
          >
            <Search className="size-5" />
          </TooltipTrigger>
          <TooltipContent>Search</TooltipContent>
        </Tooltip>
      </header>
    </TooltipProvider>
  )
}
