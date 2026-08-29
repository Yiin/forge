import { Copy, MoreHorizontal, Pencil, Terminal } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api } from '../../lib/api'
import { useSessionsStore } from '../../stores/sessions'
import { registerShortcuts } from '../../lib/shortcuts'
import { cn } from '../../lib/utils'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../ui/tooltip'

export function SessionHeader({ sessionId }: { sessionId: string }) {
  const session = useSessionsStore((state) =>
    state.sessions.find((item) => item.id === sessionId),
  )
  const projects = useSessionsStore((state) => state.projects)
  const upsertSession = useSessionsStore((state) => state.upsertSession)
  const [editing, setEditing] = useState(false)
  const [infoSource, setInfoSource] = useState<'title' | 'menu' | null>(null)
  const [title, setTitle] = useState(session?.title ?? 'New session')
  useEffect(() => setTitle(session?.title ?? 'New session'), [session?.title])
  useEffect(
    () =>
      registerShortcuts({
        'session.rename': () => {
          setInfoSource(null)
          setEditing(true)
        },
      }),
    [],
  )
  if (!session) return null
  const current = session
  async function rename() {
    const clean = title.trim()
    setEditing(false)
    if (!clean || clean === current.title) return
    upsertSession({ ...current, title: clean })
    try {
      await api.renameSession(current.id, clean)
    } catch {
      upsertSession(current)
    }
  }
  async function copyId() {
    if (!navigator.clipboard) {
      toast.error('Copy is not available')
      return
    }
    await navigator.clipboard.writeText(current.id)
    toast.success('Session ID copied')
  }
  const createdAt = current.createdAt
    ? new Date(current.createdAt)
    : current.created_at
      ? new Date(current.created_at)
      : undefined
  const projectId = current.projectId ?? current.project_id
  const projectName = projects.find((project) => project.id === projectId)?.name
  const infoPanel = (
    <>
      <strong className="block truncate text-foreground">
        {current.title}
      </strong>
      <dl className="space-y-1 text-xs text-muted-foreground">
        <div className="flex justify-between gap-2">
          <dt>Harness</dt>
          <dd className="text-foreground">{current.harness ?? 'default'}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>Project</dt>
          <dd className="truncate text-foreground">
            {projectName ?? (projectId ? 'Untitled project' : 'none')}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>Model</dt>
          <dd className="truncate text-foreground">
            {current.model ?? 'default'}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>Created</dt>
          <dd className="text-foreground">
            {createdAt && !Number.isNaN(createdAt.getTime())
              ? createdAt.toLocaleString()
              : 'unknown'}
          </dd>
        </div>
      </dl>
      <div className="flex flex-col gap-1 border-t border-border pt-2">
        <Button
          variant="ghost"
          size="sm"
          className="justify-start text-muted-foreground"
          onClick={() => {
            setInfoSource(null)
            setEditing(true)
          }}
        >
          <Pencil className="size-3.5" /> Rename session
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="justify-start text-muted-foreground"
          onClick={() => void copyId()}
        >
          <Copy className="size-3.5" /> Copy session ID
        </Button>
      </div>
    </>
  )
  return (
    <TooltipProvider delay={300}>
      <header className="session-header flex h-[52px] items-center gap-2 border-b border-border px-3 sm:px-5">
        <span
          className={cn(
            'size-2 shrink-0 rounded-full',
            current.status === 'running'
              ? 'animate-pulse bg-primary'
              : current.status === 'errored'
                ? 'bg-destructive'
                : 'bg-muted-foreground/50',
          )}
          aria-label={current.status ?? 'idle'}
        />
        {editing ? (
          <Input
            className="h-8 max-w-72"
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => void rename()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void rename()
              if (event.key === 'Escape') {
                setTitle(current.title)
                setEditing(false)
              }
            }}
          />
        ) : (
          <Popover
            open={infoSource === 'title'}
            onOpenChange={(open) => setInfoSource(open ? 'title' : null)}
          >
            <PopoverTrigger
              render={
                <button
                  className="min-w-0 truncate text-left text-sm font-medium text-foreground hover:text-primary"
                  title="Toggle session information"
                  type="button"
                />
              }
            >
              {current.title}
            </PopoverTrigger>
            <PopoverContent
              align="start"
              className="w-80 max-w-[calc(100vw-2rem)] space-y-2 text-sm"
            >
              {infoPanel}
            </PopoverContent>
          </Popover>
        )}
        {current.contextMethod && (
          <Badge variant="outline" className="shrink-0 text-muted-foreground">
            {current.contextMethod === 'exact'
              ? 'Exact fork'
              : 'Synthetic context · reduced confidence'}
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="grid size-8 shrink-0 place-items-center text-muted-foreground" />
              }
            >
              <Terminal className="size-3.5" aria-hidden="true" />
            </TooltipTrigger>
            <TooltipContent>
              {current.harness ?? 'default harness'}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Rename session"
                  onClick={() => {
                    setInfoSource(null)
                    setEditing(true)
                  }}
                />
              }
            >
              <Pencil className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent>Rename session</TooltipContent>
          </Tooltip>
          <Popover
            open={infoSource === 'menu'}
            onOpenChange={(open) => setInfoSource(open ? 'menu' : null)}
          >
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Session information"
                />
              }
            >
              <MoreHorizontal className="size-4" />
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="w-80 max-w-[calc(100vw-2rem)] space-y-2 text-sm"
            >
              {infoPanel}
            </PopoverContent>
          </Popover>
        </div>
      </header>
    </TooltipProvider>
  )
}
