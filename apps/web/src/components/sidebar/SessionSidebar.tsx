import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import {
  FolderPlus,
  Folder,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  Terminal,
  X,
} from 'lucide-react'
import { api } from '../../lib/api'
import { folderName } from '../../lib/folder-name'
import { FolderPicker } from '../FolderPicker'
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '../ui/select'
import { useSessionsStore, type SessionSummary } from '../../stores/sessions'
import { useShellStore } from '../../stores/shell'
import {
  filterScope,
  partitionSessions,
  relativeTime,
  settledPage,
} from './sidebar-logic'

function statusLabel(status?: string) {
  return status === 'running' ? 'running' : status === 'errored' ? 'error' : ''
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
  const [projectDialog, setProjectDialog] = useState(false)
  const [projectName, setProjectName] = useState('')
  const [projectPath, setProjectPath] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
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
  async function createProject(event: FormEvent) {
    event.preventDefault()
    const result = await api.createProject({
      name: projectName,
      path: projectPath,
    })
    setProjects([
      ...projects,
      { id: result.id, name: projectName, path: projectPath },
    ])
    setScope(result.id)
    setProjectDialog(false)
    setProjectName('')
    setProjectPath('')
    setNameTouched(false)
  }
  return (
    <nav className="session-sidebar nav">
      <div className="sidebar-header">
        <div className="brand">forge</div>
        <div className="sidebar-actions">
          <button
            className="icon-button"
            aria-label="Search"
            onClick={() =>
              window.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'k', metaKey: true }),
              )
            }
          >
            <Search size={16} />
          </button>
          <Link
            className="icon-button"
            aria-label="New session"
            to="/"
            search={{ new: '1' }}
          >
            <Plus size={17} />
          </Link>
        </div>
      </div>
      <div className="primary-nav">
        <Link
          to="/"
          search={{ new: '1' }}
          activeOptions={{ exact: true }}
          activeProps={{ className: 'active', 'aria-current': 'page' }}
          onClick={() => setDrawerOpen(false)}
        >
          <MessageSquare size={16} /> Chat
        </Link>
        <Link
          to="/files"
          activeProps={{ className: 'active', 'aria-current': 'page' }}
          onClick={() => setDrawerOpen(false)}
        >
          <Folder size={16} /> Files
        </Link>
      </div>
      <Link
        className="runs-link"
        to="/runs"
        activeProps={{ className: 'runs-link active', 'aria-current': 'page' }}
        onClick={() => setDrawerOpen(false)}
      >
        <span>Runs</span>
        <span className="sidebar-badge">
          {active.filter((s) => s.status === 'running').length || ''}
        </span>
      </Link>
      {runs.map((run) => (
        <Link
          key={run.id}
          className="sidebar-run"
          to="/runs/$runId"
          params={{ runId: run.id }}
          onClick={() => setDrawerOpen(false)}
        >
          <span className={`status-dot ${run.status}`} />
          <span>{run.title}</span>
          <small>
            {run.iterationCount}/{run.workerCount}
          </small>
        </Link>
      ))}
      <div className="scope-row">
        <Select
          value={scope}
          onValueChange={(value) => {
            if (typeof value !== 'string') return
            setScope(value)
            setSettledPageNumber(1)
          }}
        >
          <SelectTrigger aria-label="Project scope">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="all">All projects</SelectItem>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <button
          className="icon-button"
          aria-label="New project"
          onClick={() => {
            setProjectName('')
            setProjectPath('')
            setNameTouched(false)
            setProjectDialog(true)
          }}
        >
          <FolderPlus size={16} />
        </button>
      </div>
      <ul className="session-list">
        {active.length === 0 && settled.length === 0 && (
          <li className="sidebar-empty">
            No sessions yet.
            <Link to="/" search={{ new: '1' }}>
              Start a session
            </Link>
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
        {settled.length > 0 && <li className="settled-divider">Settled</li>}
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
            <button
              className="show-more"
              onClick={() => setSettledPageNumber((page) => page + 1)}
            >
              Show {visibleSettled.remaining} more
            </button>
          </li>
        )}
      </ul>
      <div className="nav-footer">
        <Link
          to="/settings"
          activeProps={{ className: 'active', 'aria-current': 'page' }}
          onClick={() => setDrawerOpen(false)}
        >
          <Settings size={16} /> Settings
        </Link>
      </div>
      {projectDialog &&
        // Portal escapes the vaul drawer's transform; otherwise position:fixed
        // would anchor the dialog to the 320px drawer instead of the viewport.
        createPortal(
          <div className="project-dialog-backdrop">
            <form className="project-dialog" onSubmit={createProject}>
              <div className="dialog-title">
                <strong>New project</strong>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Close"
                  onClick={() => setProjectDialog(false)}
                >
                  <X size={16} />
                </button>
              </div>
              <label>
                Name
                <input
                  autoFocus
                  required
                  value={projectName}
                  onChange={(e) => {
                    setNameTouched(true)
                    setProjectName(e.target.value)
                  }}
                />
              </label>
              <FolderPicker
                onSelect={(path) => {
                  setProjectPath(path)
                  if (!nameTouched) setProjectName(folderName(path))
                }}
              />
              <button
                className="new-session"
                type="submit"
                disabled={!projectPath}
              >
                Create project
              </button>
            </form>
          </div>,
          document.body,
        )}
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
  const toggleUnread = () => {
    const next = !session.unread
    useSessionsStore.getState().upsertSession({ ...session, unread: next })
    setMenuOpen(false)
  }
  const copyId = async () => {
    await navigator.clipboard?.writeText(session.id)
    setMenuOpen(false)
  }
  return (
    <li
      className={`session-row session-row-enter ${settled ? 'settled' : ''}`}
      onDoubleClick={onEdit}
    >
      {editing ? (
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => onRename(session, title)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onRename(session, title)
            if (e.key === 'Escape') onEdit()
          }}
        />
      ) : (
        <button
          className="session-button"
          aria-current={
            window.location.pathname === `/s/${encodeURIComponent(session.id)}`
              ? 'page'
              : undefined
          }
          onClick={() => onOpen(session.id)}
        >
          <span className={`status-dot ${session.status ?? 'idle'}`} />
          <span className="session-copy">
            <span className="session-title">
              {index !== undefined && index < 9 && <kbd>{index + 1}</kbd>}
              {session.title || 'Untitled session'}
            </span>
            {!settled && session.snippet && (
              <span className="session-snippet">{session.snippet}</span>
            )}
          </span>
          <span className="session-time">
            {relativeTime(session.lastActivityAt)}
          </span>
          <Terminal size={13} aria-label={session.harness} />
        </button>
      )}
      <button
        className="icon-button row-menu"
        aria-label={`Actions for ${session.title}`}
        aria-expanded={menuOpen}
        onClick={(event) => {
          event.stopPropagation()
          setMenuOpen((open) => !open)
        }}
      >
        <MoreHorizontal size={15} />
      </button>
      {menuOpen && (
        <div className="session-menu" role="menu">
          <button
            role="menuitem"
            onClick={() => {
              onEdit()
              setMenuOpen(false)
            }}
          >
            Rename
          </button>
          <button
            role="menuitem"
            onClick={() => void onSettle(session, !settled)}
          >
            {settled ? 'Un-settle' : 'Settle'}
          </button>
          <button role="menuitem" onClick={toggleUnread}>
            {session.unread ? 'Mark read' : 'Mark unread'}
          </button>
          <button role="menuitem" onClick={() => void copyId()}>
            Copy session id
          </button>
          <button
            className="danger"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false)
              onDelete(session)
            }}
          >
            Delete
          </button>
        </div>
      )}
      {session.status === 'running' && (
        <span className="sr-only">{statusLabel(session.status)}</span>
      )}
    </li>
  )
}
