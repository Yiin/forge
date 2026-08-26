import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import {
  FolderPlus,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  Terminal,
  X,
} from 'lucide-react'
import { api } from '../../lib/api'
import { useSessionsStore, type SessionSummary } from '../../stores/sessions'
import { useShellStore } from '../../stores/shell'
import {
  filterScope,
  jumpTarget,
  partitionSessions,
  relativeTime,
  settledPage,
} from './sidebar-logic'

function statusLabel(status?: string) {
  return status === 'running' ? 'running' : status === 'errored' ? 'error' : ''
}

export function SessionSidebar() {
  const navigate = useNavigate()
  const { sessions, projects, setSessions, setProjects, upsertSession } =
    useSessionsStore()
  const setDrawerOpen = useShellStore((state) => state.setDrawerOpen)
  const [scope, setScope] = useState<string | 'all'>('all')
  const [settledPageNumber, setSettledPageNumber] = useState(1)
  const [projectDialog, setProjectDialog] = useState(false)
  const [projectName, setProjectName] = useState('')
  const [projectPath, setProjectPath] = useState('')
  const [editing, setEditing] = useState<string | null>(null)

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
    const onKey = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) return
      const id = jumpTarget(active, Number(event.key))
      if (id) {
        event.preventDefault()
        void openSession(id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const scoped = useMemo(() => filterScope(sessions, scope), [sessions, scope])
  const { active, settled } = partitionSessions(
    scoped.filter((session) => session.kind !== 'subagent'),
  )
  const visibleSettled = settledPage(settled, settledPageNumber)

  async function openSession(id: string) {
    useShellStore.getState().setLastSession(id)
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
          <Link className="icon-button" aria-label="New session" to="/">
            <Plus size={17} />
          </Link>
        </div>
      </div>
      <Link
        className="runs-link"
        to="/runs"
        onClick={() => setDrawerOpen(false)}
      >
        <span>Runs</span>
        <span className="sidebar-badge">
          {active.filter((s) => s.status === 'running').length || ''}
        </span>
      </Link>
      <div className="scope-row">
        <select
          aria-label="Project scope"
          value={scope}
          onChange={(event) => {
            setScope(event.target.value)
            setSettledPageNumber(1)
          }}
        >
          <option value="all">All projects</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <button
          className="icon-button"
          aria-label="New project"
          onClick={() => setProjectDialog(true)}
        >
          <FolderPlus size={16} />
        </button>
      </div>
      <ul className="session-list">
        {active.length === 0 && settled.length === 0 && (
          <li className="sidebar-empty">
            No sessions yet.<Link to="/">Start a session</Link>
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
        <Link to="/settings" onClick={() => setDrawerOpen(false)}>
          <Settings size={16} /> Settings
        </Link>
      </div>
      {projectDialog && (
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
                onChange={(e) => setProjectName(e.target.value)}
              />
            </label>
            <label>
              Absolute path
              <input
                required
                pattern="/.*"
                value={projectPath}
                onChange={(e) => setProjectPath(e.target.value)}
              />
            </label>
            <button className="new-session" type="submit">
              Create project
            </button>
          </form>
        </div>
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
}: {
  session: SessionSummary
  index?: number
  settled?: boolean
  editing?: boolean
  onOpen: (id: string) => void
  onEdit: () => void
  onRename: (session: SessionSummary, title: string) => void
}) {
  const [title, setTitle] = useState(session.title)
  return (
    <li
      className={`session-row ${settled ? 'settled' : ''}`}
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
        <button className="session-button" onClick={() => onOpen(session.id)}>
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
        onClick={onEdit}
      >
        <MoreHorizontal size={15} />
      </button>
      {session.status === 'running' && (
        <span className="sr-only">{statusLabel(session.status)}</span>
      )}
    </li>
  )
}
