import { Link, useParams } from '@tanstack/react-router'
import {
  Copy,
  Pause,
  Play,
  Square,
  ChevronDown,
  ChevronRight,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { toast } from 'sonner'
import { Dialog } from '../components/ui/dialog'

type Iteration = {
  id: string
  title: string
  beadId: string
  sessionId: string
  harness: string | null
  model: string | null
  attempt: number
  status: string
  failureReason: string | null
  startedAt: number
  endedAt: number | null
}
type Detail = {
  id: string
  title: string
  status: string
  mode: string
  workerCount: number
  baseBranch: string
  iterationCount: number
  iterations: Iteration[]
  frontier: {
    ready: { id: string; title: string; priority: number }[]
    blocked: { id: string; title: string; priority: number }[]
  }
  config: Record<string, unknown>
  provenance: Record<string, string>
}
export function RunRoute() {
  const { runId } = useParams({ from: '/runs/$runId' })
  const [run, setRun] = useState<Detail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionState, setActionState] = useState<
    Record<string, 'pending' | 'failed'>
  >({})
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const load = () =>
    void api
      .getRun(runId)
      .then((value) => {
        setRun(value as Detail)
        setError(null)
      })
      .catch((cause) =>
        setError(
          cause instanceof Error ? cause.message : 'Could not load this run.',
        ),
      )
      .finally(() => setLoading(false))
  useEffect(() => {
    load()
    const timer = setInterval(load, 2000)
    return () => clearInterval(timer)
  }, [runId])
  if (loading && !run)
    return (
      <section className="run-page">
        <p className="muted">Loading run…</p>
      </section>
    )
  if (error && !run)
    return (
      <section className="run-page">
        <Link className="back-link" to="/runs">
          ← All runs
        </Link>
        <div className="state-card state-error" role="alert">
          <strong>Could not load this run</strong>
          <p>{error}</p>
          <button className="ui-button" onClick={() => void load()}>
            Retry
          </button>
        </div>
      </section>
    )
  if (!run) return null
  const action = async (name: 'pause' | 'resume' | 'cancel') => {
    setActionState((current) => ({ ...current, [name]: 'pending' }))
    try {
      await api.runAction(runId, name)
      setActionState((current) => {
        const next = { ...current }
        delete next[name]
        return next
      })
      await load()
      toast.success(name === 'cancel' ? 'Run cancelled.' : `Run ${name}d.`)
    } catch (cause) {
      setActionState((current) => ({ ...current, [name]: 'failed' }))
      toast.error(
        cause instanceof Error ? cause.message : `Could not ${name} run.`,
      )
    }
  }
  const actionButton = (
    name: 'pause' | 'resume' | 'cancel',
    label: string,
    icon: React.ReactNode,
  ) => {
    const state = actionState[name]
    return (
      <button
        className="icon-button"
        aria-label={label}
        disabled={state === 'pending'}
        onClick={() =>
          name === 'cancel' ? setConfirmCancel(true) : void action(name)
        }
      >
        {state === 'pending' ? '…' : icon}
      </button>
    )
  }
  return (
    <section className="run-page">
      <Link className="back-link" to="/runs">
        ← All runs
      </Link>
      <header className="run-header">
        <div>
          <p className="eyebrow">Epic run</p>
          <h1>{run.title || 'Untitled run'}</h1>
          <p className="run-meta">
            <span className={`status-dot ${run.status}`} />
            {run.status} · {run.mode} · {run.workerCount} workers ·{' '}
            {run.baseBranch}
          </p>
        </div>
        <div className="run-actions">
          {run.status === 'running'
            ? actionButton('pause', 'Pause run', <Pause size={17} />)
            : run.status === 'paused'
              ? actionButton('resume', 'Resume run', <Play size={17} />)
              : null}
          {['running', 'paused'].includes(run.status) &&
            actionButton('cancel', 'Cancel run', <Square size={17} />)}
        </div>
      </header>
      {(['pause', 'resume', 'cancel'] as const).map((name) =>
        actionState[name] === 'failed' ? (
          <p className="failure action-failure" role="alert" key={name}>
            Could not {name} the run. Try again.
          </p>
        ) : null,
      )}
      {error && (
        <div className="state-card state-warning" role="status">
          <strong>Live updates paused</strong>
          <p>{error} Showing the last saved data.</p>
          <button className="ui-button" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      <div className="provenance">
        {Object.keys(run.config).length ? (
          Object.keys(run.config).map((key) => (
            <span key={key}>
              {key}: {run.provenance[key] ?? 'default'}
            </span>
          ))
        ) : (
          <span>Defaults</span>
        )}
      </div>
      <section className="frontier">
        <h2>Frontier</h2>
        <div className="frontier-columns">
          <div>
            <strong>Ready</strong>
            {run.frontier.ready.map((item) => (
              <p key={item.id}>{item.title}</p>
            ))}
            {!run.frontier.ready.length && (
              <p className="muted">No ready children.</p>
            )}
          </div>
          <div>
            <strong>Blocked</strong>
            {run.frontier.blocked.map((item) => (
              <p key={item.id}>{item.title}</p>
            ))}
            {!run.frontier.blocked.length && (
              <p className="muted">No blocked children.</p>
            )}
          </div>
        </div>
      </section>
      <Dialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title="Cancel run"
      >
        <div className="confirm-dialog">
          <h2>Cancel this run?</h2>
          <p>
            The run will stop. Existing iteration data will remain available.
          </p>
          <div className="launch-actions">
            <button
              className="ui-button"
              onClick={() => setConfirmCancel(false)}
            >
              Keep running
            </button>
            <button
              className="ui-button danger"
              disabled={actionState.cancel === 'pending'}
              onClick={() => {
                setConfirmCancel(false)
                void action('cancel')
              }}
            >
              Cancel run
            </button>
          </div>
        </div>
      </Dialog>
      <section className="iterations">
        <h2>
          Iterations <small>{run.iterationCount}</small>
        </h2>
        {run.iterations.map((item) => (
          <IterationRow
            key={item.id}
            item={item}
            expanded={open === item.id}
            onToggle={() => setOpen(open === item.id ? null : item.id)}
          />
        ))}
        {run.iterations.length === 0 && (
          <p className="muted">Workers have not started.</p>
        )}
      </section>
    </section>
  )
}
function IterationRow({
  item,
  expanded,
  onToggle,
}: {
  item: Iteration
  expanded: boolean
  onToggle: () => void
}) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(item.sessionId)
      toast.success('Copied session id')
    } catch {
      toast.error('Could not copy session id.')
    }
  }
  return (
    <article className="iteration">
      <button
        className="iteration-summary"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={`${item.title || 'Untitled iteration'}, ${item.status}, attempt ${item.attempt}`}
      >
        <span className={`status-dot ${item.status}`} />
        <span className="iteration-title">{item.title}</span>
        <span className="iteration-attempt">attempt {item.attempt}</span>
        {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </button>
      <div className="iteration-meta">
        <code title="Worker session id">{item.sessionId}</code>
        <button
          className="copy-chip"
          onClick={(event) => {
            event.stopPropagation()
            void copy()
          }}
          aria-label="Copy session id"
        >
          <Copy size={14} /> Copy
        </button>
      </div>
      {item.failureReason && <p className="failure">{item.failureReason}</p>}
      {expanded && <Transcript sessionId={item.sessionId} />}
    </article>
  )
}
function Transcript({ sessionId }: { sessionId: string }) {
  const [messages, setMessages] = useState<
    Array<{ role?: string; content?: { text?: string } }>
  >([])
  const transcriptRef = useRef<HTMLDivElement>(null)
  const [following, setFollowing] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const load = () =>
    void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`)
      .then((response) => {
        if (!response.ok) throw new Error('Transcript unavailable')
        return response.json()
      })
      .then((value) => {
        setMessages(Array.isArray(value) ? value : [])
        setError(false)
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false))
  useEffect(() => {
    load()
    const timer = setInterval(load, 1000)
    return () => clearInterval(timer)
  }, [sessionId])
  useEffect(() => {
    const element = transcriptRef.current
    if (element && following) element.scrollTop = element.scrollHeight
  }, [messages, following])
  return (
    <>
      <div
        className="iteration-transcript"
        ref={transcriptRef}
        onScroll={(event) => {
          const element = event.currentTarget
          setFollowing(
            element.scrollHeight - element.scrollTop - element.clientHeight <
              32,
          )
        }}
        aria-live="polite"
      >
        {messages.map((message, index) => (
          <p key={index}>
            <strong>{message.role ?? 'event'}</strong>{' '}
            {message.content?.text ?? ''}
          </p>
        ))}
      </div>
      {loading && <p className="muted">Loading transcript…</p>}
      {!loading && error && (
        <p className="failure">Transcript unavailable. Retrying…</p>
      )}
      {!loading && !error && messages.length === 0 && (
        <p className="muted">No transcript messages yet.</p>
      )}
      {!following && (
        <button
          className="transcript-latest"
          onClick={() => {
            setFollowing(true)
            transcriptRef.current?.scrollTo({
              top: transcriptRef.current.scrollHeight,
              behavior: 'smooth',
            })
          }}
        >
          Jump to latest
        </button>
      )}
    </>
  )
}
