import { Copy, MoreHorizontal, Pencil, Terminal } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api } from '../../lib/api'
import { useSessionsStore } from '../../stores/sessions'

export function SessionHeader({ sessionId }: { sessionId: string }) {
  const session = useSessionsStore((state) =>
    state.sessions.find((item) => item.id === sessionId),
  )
  const upsertSession = useSessionsStore((state) => state.upsertSession)
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(session?.title ?? 'New session')
  useEffect(() => setTitle(session?.title ?? 'New session'), [session?.title])
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
    await navigator.clipboard.writeText(current.id)
    toast.success('Session ID copied')
  }
  return (
    <header className="session-header">
      <div className="session-heading">
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
            onClick={() => setEditing(true)}
            title="Rename session"
          >
            {current.title}
            <Pencil size={13} />
          </button>
        )}
        <span
          className={`status-dot ${current.status ?? 'idle'}`}
          aria-label={current.status ?? 'idle'}
        />
        <Terminal size={14} aria-label={current.harness ?? 'harness'} />
      </div>
      {current.contextMethod && (
        <span className="session-context-label">
          {current.contextMethod === 'exact'
            ? 'Exact fork'
            : 'Synthetic context · reduced confidence'}
        </span>
      )}
      <details className="session-info">
        <summary className="icon-button" aria-label="Session information">
          <MoreHorizontal size={18} />
        </summary>
        <div className="session-info-popover">
          <strong>{current.title}</strong>
          <span>Harness: {current.harness ?? 'default'}</span>
          <span>Project: {current.projectId ?? 'none'}</span>
          <code>{current.id}</code>
          <button className="text-button" onClick={() => void copyId()}>
            <Copy size={14} /> Copy session ID
          </button>
        </div>
      </details>
      <button
        className="icon-button session-copy-button"
        aria-label="Copy session ID"
        onClick={() => void copyId()}
      >
        <Copy size={16} />
      </button>
    </header>
  )
}
