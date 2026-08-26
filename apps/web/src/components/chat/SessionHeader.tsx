import { Copy, MoreHorizontal, Pencil, Terminal, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { api } from '../../lib/api'
import { useSessionsStore } from '../../stores/sessions'
import { registerShortcuts } from '../../lib/shortcuts'

export function SessionHeader({ sessionId }: { sessionId: string }) {
  const session = useSessionsStore((state) =>
    state.sessions.find((item) => item.id === sessionId),
  )
  const upsertSession = useSessionsStore((state) => state.upsertSession)
  const [editing, setEditing] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  const infoRef = useRef<HTMLDetailsElement>(null)
  const headingRef = useRef<HTMLDivElement>(null)
  const [title, setTitle] = useState(session?.title ?? 'New session')
  useEffect(() => setTitle(session?.title ?? 'New session'), [session?.title])
  useEffect(
    () =>
      registerShortcuts({
        'session.rename': () => setEditing(true),
      }),
    [],
  )
  useEffect(() => {
    if (!infoOpen) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (infoRef.current?.contains(target)) return
      if (headingRef.current?.contains(target)) return
      setInfoOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setInfoOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [infoOpen])
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
  return (
    <header className="session-header">
      <div className="session-heading" ref={headingRef}>
        {editing ? (
          <input
            className="session-title-input"
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
          <button
            className="session-title-button"
            onClick={() => setInfoOpen((open) => !open)}
            title="Toggle session information"
          >
            {current.title}
          </button>
        )}
        <button
          className="icon-button session-rename-button"
          aria-label="Rename session"
          onClick={() => setEditing(true)}
        >
          <Pencil size={13} />
        </button>
        <span
          className={`status-dot ${current.status ?? 'idle'}`}
          aria-label={current.status ?? 'idle'}
        />
        <Terminal
          className="session-harness-icon"
          size={14}
          aria-label={current.harness ?? 'harness'}
        />
      </div>
      {current.contextMethod && (
        <span className="session-context-label">
          {current.contextMethod === 'exact'
            ? 'Exact fork'
            : 'Synthetic context · reduced confidence'}
        </span>
      )}
      <details
        ref={infoRef}
        className="session-info"
        open={infoOpen}
        onToggle={(event) =>
          setInfoOpen((event.currentTarget as HTMLDetailsElement).open)
        }
      >
        <summary className="icon-button" aria-label="Session information">
          <MoreHorizontal size={18} />
        </summary>
        <div className="session-info-popover">
          <div className="session-info-heading">
            <strong>{current.title}</strong>
            <button
              className="icon-button"
              aria-label="Close session information"
              onClick={() => setInfoOpen(false)}
            >
              <X size={15} />
            </button>
          </div>
          <span>Harness: {current.harness ?? 'default'}</span>
          <span>Project: {projectId ?? 'none'}</span>
          <span>
            Created:{' '}
            {createdAt && !Number.isNaN(createdAt.getTime())
              ? createdAt.toLocaleString()
              : 'unknown'}
          </span>
          <code>{current.id}</code>
          <button
            className="text-button"
            onClick={() => {
              setEditing(true)
              setInfoOpen(false)
            }}
          >
            <Pencil size={14} /> Rename session
          </button>
          <button className="text-button" onClick={() => void copyId()}>
            <Copy size={14} /> Copy session ID
          </button>
        </div>
      </details>
    </header>
  )
}
