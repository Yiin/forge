import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import {
  Activity,
  FolderPlus,
  Folder,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  Terminal,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/menu'
import { api } from '../../lib/api'
import { openProjectCreation } from '../ProjectCreationDialog'
import { openNewDraft } from '../../lib/draft-entry'
import { useSessionsStore, type SessionSummary } from '../../stores/sessions'
import { useShellStore } from '../../stores/shell'
import {
  filterScope,
  partitionSessions,
  relativeTime,
  settledPage,
} from './sidebar-logic'

const iconButtonClass = 'size-11 pointer-fine:size-9'
const navLinkClass =
  'flex items-center gap-2 rounded-md px-2 py-2 text-sm text-sidebar-foreground/90 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground'
const navLinkActiveClass =
  'bg-sidebar-accent font-medium text-sidebar-foreground'

function statusLabel(status?: string) {
  return status === 'running' ? 'running' : status === 'errored' ? 'error' : ''
}

function statusDotClass(status?: string) {
  if (status === 'running') return 'bg-primary'
  if (status === 'errored') return 'bg-destructive'
  return 'bg-muted-foreground/50'
}

export function SessionSidebar() {
  const navigate = useNavigate()
  const location = useLocation()
  const sessions = useSessionsStore((state) => state.sessions)
  const projects = useSessionsStore((state) => state.projects)
  const setSessions = useSessionsStore((state) => state.setSessions)
  const setProjects = useSessionsStore((state) => state.setProjects)
  const upsertSession = useSessionsStore((state) => state.upsertSession)
  const removeSession = useSessionsStore((state) => state.removeSession)
  const setDrawerOpen = useShellStore((state) => state.setDrawerOpen)
  const [scope, setScope] = useState<string | 'all'>('all')
  const [settledPageNumber, setSettledPageNumber] = useState(1)
  const [editing, setEditing] = useState<string | null>(null)
  const [runs, setRuns] = useState<
    Array<{
      id: string
      title: string
      status: string
      iterationCount: number
      workerCount: number
    }>
  >([])

  useEffect(() => {
    void Promise.all([api.listSessions(), api.listProjects()])
      .then(([sessionData, projectData]) => {
        setSessions(
          Array.isArray(sessionData)
            ? sessionData
            : (sessionData.sessions ?? []),
        )
        setProjects(
          Array.isArray(projectData)
            ? projectData
            : (projectData.projects ?? []),
        )
      })
      .catch(() => undefined)
  }, [setProjects, setSessions])
  useEffect(() => {
    const load = () =>
      void api
        .listRuns()
        .then((value) =>
          setRuns(
            (value as typeof runs).filter((run) =>
              ['running', 'paused'].includes(run.status),
            ),
          ),
        )
        .catch(() => undefined)
    load()
    const timer = setInterval(load, 2000)
    return () => clearInterval(timer)
  }, [])

  const scoped = useMemo(() => filterScope(sessions, scope), [sessions, scope])
  const { active, settled } = partitionSessions(
    scoped.filter((session) => session.kind !== 'subagent'),
  )
  const visibleSettled = settledPage(settled, settledPageNumber)

  async function openSession(id: string) {
    setDrawerOpen(false)
    await navigate({ to: '/s/$sessionId', params: { sessionId: id } })
  }
  function newDraft() {
    setDrawerOpen(false)
    void openNewDraft(navigate).catch(() => undefined)
  }
  async function rename(session: SessionSummary, title: string) {
    const clean = title.trim()
    setEditing(null)
    if (!clean || clean === session.title) return
    upsertSession({ ...session, title: clean })
    try {
      await api.renameSession(session.id, clean)
    } catch {
      upsertSession(session)
    }
  }
  async function settle(session: SessionSummary, settled: boolean) {
    upsertSession({ ...session, status: settled ? 'archived' : 'idle' })
    try {
      await api.settleSession(session.id, settled)
    } catch {
      upsertSession(session)
    }
  }
  async function remove(session: SessionSummary) {
    if (
      !window.confirm(
        `Delete “${session.title || 'Untitled session'}”? This cannot be undone.`,
      )
    )
      return
    removeSession(session.id)
    if (location.pathname === `/s/${encodeURIComponent(session.id)}`) {
      useShellStore.getState().clearLastSession()
      await navigate({ to: '/', search: { new: '1' } })
    }
    try {
      await api.deleteSession(session.id)
    } catch {
      upsertSession(session)
    }
  }
  const runningCount = active.filter((s) => s.status === 'running').length
  return (
    <nav className="flex h-full flex-col gap-3 text-sm">
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="text-lg font-semibold tracking-tight">forge</span>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className={iconButtonClass}
            aria-label="Search"
            onClick={() =>
              window.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'k', metaKey: true }),
              )
            }
          >
            <Search className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={iconButtonClass}
            aria-label="New session"
            onClick={newDraft}
          >
            <Plus className="size-4" />
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-0.5">
        <Link
          to="/"
          search={{ new: '1' }}
          activeOptions={{ exact: true }}
          className={navLinkClass}
          activeProps={{
            className: cn(navLinkClass, navLinkActiveClass),
            'aria-current': 'page',
          }}
          onClick={(event) => {
            event.preventDefault()
            newDraft()
          }}
        >
          <MessageSquare className="size-4" /> Chat
        </Link>
        <Link
          to="/files"
          className={navLinkClass}
          activeProps={{
            className: cn(navLinkClass, navLinkActiveClass),
            'aria-current': 'page',
          }}
          onClick={() => setDrawerOpen(false)}
        >
          <Folder className="size-4" /> Files
        </Link>
      </div>
      <div className="flex flex-col gap-0.5">
        <Link
          to="/runs"
          className={cn(navLinkClass, 'justify-between')}
          activeProps={{
            className: cn(navLinkClass, navLinkActiveClass, 'justify-between'),
            'aria-current': 'page',
          }}
          onClick={() => setDrawerOpen(false)}
        >
          <span className="flex items-center gap-2">
            <Activity className="size-4" /> Runs
          </span>
          {runningCount > 0 && (
            <Badge variant="secondary">{runningCount}</Badge>
          )}
        </Link>
        {runs.map((run) => (
          <Link
            key={run.id}
            to="/runs/$runId"
            params={{ runId: run.id }}
            className="ml-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground"
            onClick={() => setDrawerOpen(false)}
          >
            <span
              className={cn(
                'size-1.5 shrink-0 rounded-full',
                statusDotClass(run.status),
              )}
            />
            <span className="min-w-0 flex-1 truncate">{run.title}</span>
            <small className="text-muted-foreground">
              {run.iterationCount}/{run.workerCount}
            </small>
          </Link>
        ))}
      </div>
      <div className="flex items-center gap-1 px-1">
        <Select
          value={scope}
          items={[
            { value: 'all', label: 'All projects' },
            ...projects.map((project) => ({
              value: project.id,
              label: project.name,
            })),
          ]}
          onValueChange={(value) => {
            setScope(value ?? 'all')
            setSettledPageNumber(1)
          }}
        >
          <SelectTrigger
            aria-label="Project scope"
            size="sm"
            className="flex-1"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All projects</SelectItem>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          size="icon"
          className={iconButtonClass}
          aria-label="New project"
          onClick={() => {
            setDrawerOpen(false)
            openProjectCreation()
          }}
        >
          <FolderPlus className="size-4" />
        </Button>
      </div>
      <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
        {active.length === 0 && settled.length === 0 && (
          <li className="flex flex-col items-start gap-1 px-2 py-3 text-muted-foreground">
            No sessions yet.
            <Button variant="link" className="h-auto p-0" onClick={newDraft}>
              Start a session
            </Button>
          </li>
        )}
        {active.map((session, index) => (
          <SessionRow
            key={session.id}
            session={session}
            index={index}
            editing={editing === session.id}
            onOpen={openSession}
            onEdit={() => setEditing(session.id)}
            onRename={rename}
            onSettle={settle}
            onDelete={remove}
          />
        ))}
        {settled.length > 0 && (
          <li className="px-2 pt-3 pb-1 text-xs font-medium text-muted-foreground">
            Settled
          </li>
        )}
        {visibleSettled.items.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            onOpen={openSession}
            onEdit={() => setEditing(session.id)}
            onRename={rename}
            onSettle={settle}
            onDelete={remove}
            settled
          />
        ))}
        {visibleSettled.hasMore && (
          <li>
            <Button
              variant="ghost"
              className="w-full justify-start text-muted-foreground"
              onClick={() => setSettledPageNumber((page) => page + 1)}
            >
              Show {visibleSettled.remaining} more
            </Button>
          </li>
        )}
      </ul>
      <div className="mt-auto flex flex-col gap-0.5 border-t border-sidebar-border pt-2">
        <Link
          to="/settings"
          className={navLinkClass}
          activeProps={{
            className: cn(navLinkClass, navLinkActiveClass),
            'aria-current': 'page',
          }}
          onClick={() => setDrawerOpen(false)}
        >
          <Settings className="size-4" /> Settings
        </Link>
      </div>
    </nav>
  )
}

function SessionRow({
  session,
  index,
  settled,
  editing,
  onOpen,
  onEdit,
  onRename,
  onSettle,
  onDelete,
}: {
  session: SessionSummary
  index?: number
  settled?: boolean
  editing?: boolean
  onOpen: (id: string) => void
  onEdit: () => void
  onRename: (session: SessionSummary, title: string) => void
  onSettle: (session: SessionSummary, settled: boolean) => void
  onDelete: (session: SessionSummary) => void
}) {
  const [title, setTitle] = useState(session.title)
  const [menuOpen, setMenuOpen] = useState(false)
  const location = useLocation()
  const isCurrent = location.pathname === `/s/${encodeURIComponent(session.id)}`
  const toggleUnread = () => {
    const next = !session.unread
    useSessionsStore.getState().upsertSession({ ...session, unread: next })
  }
  const copyId = async () => {
    await navigator.clipboard?.writeText(session.id)
  }
  return (
    <li
      className={cn(
        'group relative flex items-center rounded-md',
        settled && 'opacity-70',
      )}
      onDoubleClick={onEdit}
    >
      {editing ? (
        <Input
          autoFocus
          value={title}
          className="h-9"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => onRename(session, title)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onRename(session, title)
            if (e.key === 'Escape') onEdit()
          }}
        />
      ) : (
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-2 pr-10 pl-2 text-left hover:bg-sidebar-accent"
          aria-current={isCurrent ? 'page' : undefined}
          onClick={() => onOpen(session.id)}
        >
          <span
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              statusDotClass(session.status),
            )}
          />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex items-center gap-1.5 truncate text-sm">
              {index !== undefined && index < 9 && (
                <Kbd className="h-4 min-w-4">{index + 1}</Kbd>
              )}
              <span className="truncate">
                {session.title || 'Untitled session'}
              </span>
            </span>
            {!settled && session.snippet && (
              <span className="truncate text-xs text-muted-foreground">
                {session.snippet}
              </span>
            )}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {relativeTime(session.lastActivityAt)}
          </span>
          <Terminal
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-label={session.harness}
          />
        </button>
      )}
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                iconButtonClass,
                'absolute right-0 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 data-[popup-open]:opacity-100 pointer-coarse:opacity-100',
              )}
              aria-label={`Actions for ${session.title}`}
            />
          }
        >
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onEdit}>Rename</DropdownMenuItem>
          <DropdownMenuItem onClick={() => void onSettle(session, !settled)}>
            {settled ? 'Un-settle' : 'Settle'}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={toggleUnread}>
            {session.unread ? 'Mark read' : 'Mark unread'}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void copyId()}>
            Copy session id
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onClick={() => onDelete(session)}
          >
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {session.status === 'running' && (
        <span className="sr-only">{statusLabel(session.status)}</span>
      )}
    </li>
  )
}
