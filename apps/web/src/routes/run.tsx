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

type Iteration = {
  id: string
  title: string
  beadId: string
  sessionId: string
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
}
export function RunRoute() {
  const { runId } = useParams({ from: '/runs/$runId' })
  const [run, setRun] = useState<Detail | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const load = () =>
    void api
      .getRun(runId)
      .then((value) => setRun(value as Detail))
      .catch(() => undefined)
  useEffect(() => {
    load()
    const timer = setInterval(load, 2000)
    return () => clearInterval(timer)
  }, [runId])
  if (!run)
    return (
      <section className="run-page">
        <p className="muted">Loading run…</p>
      </section>
    )
  const action = async (name: 'pause' | 'resume' | 'cancel') => {
    await api.runAction(runId, name)
    load()
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
          {run.status === 'running' ? (
            <button
              className="icon-button"
              aria-label="Pause run"
              onClick={() => void action('pause')}
            >
              <Pause size={17} />
            </button>
          ) : run.status === 'paused' ? (
            <button
              className="icon-button"
              aria-label="Resume run"
              onClick={() => void action('resume')}
            >
              <Play size={17} />
            </button>
          ) : null}
          {['running', 'paused'].includes(run.status) && (
            <button
              className="icon-button"
              aria-label="Cancel run"
              onClick={() => void action('cancel')}
            >
              <Square size={17} />
            </button>
          )}
        </div>
      </header>
      <div className="provenance">
        {Object.keys(run.config).length ? (
          Object.keys(run.config).map((key) => (
            <span key={key}>{key}: input</span>
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
          </div>
          <div>
            <strong>Blocked</strong>
            {run.frontier.blocked.map((item) => (
              <p key={item.id}>{item.title}</p>
            ))}
          </div>
        </div>
      </section>
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
    await navigator.clipboard.writeText(item.sessionId)
    toast.success('Copied session id')
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
  const load = () =>
    void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`)
      .then((response) => (response.ok ? response.json() : []))
      .then((value) => setMessages(Array.isArray(value) ? value : []))
      .catch(() => undefined)
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
