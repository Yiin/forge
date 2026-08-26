import {
  Check,
  CircleAlert,
  ChevronDown,
  ChevronRight,
  Clock3,
  LoaderCircle,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { Message } from '@forge/protocol/message'
import { connectForgeSocket, normalizeServerEvent } from '../../lib/socket'
import { useMessagesStore } from '../../stores/messages'
import {
  deriveSubagentStatus,
  elapsedSeconds,
  resultPreview,
  toolCount,
  type SubagentSession,
} from './subagent'
import { SubagentTranscript } from './SubagentTranscript'

const EMPTY_MESSAGES: Message[] = []

export function SubagentCard({ child }: { child: SubagentSession }) {
  const [expanded, setExpanded] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const messages = useMessagesStore(
    (state) => state.bySession[child.id] ?? EMPTY_MESSAGES,
  )
  const status = deriveSubagentStatus(messages, child.status)
  const preview = resultPreview(messages)
  const tools = toolCount(messages)
  useEffect(() => {
    if (status !== 'running') return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [status])

  useEffect(() => {
    if (!expanded || loaded) return
    let active = true
    setLoadError(false)
    void fetch(`/api/sessions/${encodeURIComponent(child.id)}/messages`)
      .then((response) => {
        if (!response.ok) throw new Error('Could not load transcript')
        return response.json()
      })
      .then((rows: unknown) => {
        if (!active || !Array.isArray(rows)) return
        const parsedRows: Message[] = []
        for (const row of rows) {
          const event = normalizeServerEvent(row)
          if (!event || typeof event !== 'object' || !('msg' in event)) continue
          const parsed = Message.safeParse(event.msg)
          if (parsed.success) parsedRows.push(parsed.data)
        }
        useMessagesStore.getState().loadMessages(child.id, parsedRows)
        setLoaded(true)
      })
      .catch(() => {
        if (active) {
          setLoadError(true)
          setLoaded(false)
        }
      })
    return () => {
      active = false
    }
  }, [child.id, expanded, loaded])

  useEffect(() => {
    if (!expanded) return
    const socket = connectForgeSocket({ sessions: [child.id] })
    return () => socket.stop()
  }, [child.id, expanded])

  const Icon =
    status === 'running'
      ? LoaderCircle
      : status === 'done'
        ? Check
        : CircleAlert
  const statusText = status === 'unknown' ? 'status unknown' : status
  return (
    <article className={`subagent-card subagent-${status}`}>
      <button
        className="subagent-summary"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <Icon size={16} className={status === 'running' ? 'spin' : undefined} />
        <span className="subagent-copy">
          <strong>{child.title || 'Subagent'}</strong>
          <span>
            {statusText}
            {tools ? ` · ${tools} tools` : ''}
            {preview ? ` · ${preview}` : ''}
          </span>
        </span>
        {status === 'running' && (
          <span className="subagent-elapsed">
            <Clock3 size={14} aria-hidden="true" />{' '}
            {elapsedSeconds(messages, now)}s
          </span>
        )}
        {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </button>
      {expanded && loadError ? (
        <div className="subagent-load-error" role="alert">
          <span>Could not load transcript.</span>
          <button
            type="button"
            onClick={() => {
              setLoadError(false)
              setLoaded(false)
            }}
          >
            Retry
          </button>
        </div>
      ) : expanded && !loaded && messages.length === 0 ? (
        <div className="subagent-load-state">Loading transcript…</div>
      ) : expanded ? (
        messages.length ? (
          <SubagentTranscript messages={messages} />
        ) : (
          <div className="subagent-load-state">No transcript items.</div>
        )
      ) : null}
    </article>
  )
}
