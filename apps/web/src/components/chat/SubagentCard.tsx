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
import { cn } from '../../lib/utils'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'

const EMPTY_MESSAGES: Message[] = []

const STATUS_BADGE: Record<string, string> = {
  running: 'border-primary/40 bg-primary/10 text-primary',
  done: 'border-primary/40 bg-primary/10 text-primary',
  errored: 'border-destructive/40 bg-destructive/10 text-destructive',
  interrupted: 'border-destructive/40 bg-destructive/10 text-destructive',
  unknown: 'border-border bg-muted text-muted-foreground',
}

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
    <article
      className={cn(
        'subagent-card mx-auto mb-3 max-w-[760px] overflow-hidden rounded-lg border bg-card',
        status === 'running' ? 'border-primary/40' : 'border-border',
      )}
    >
      <button
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <Icon
          className={cn(
            'size-4 shrink-0 text-muted-foreground',
            status === 'running' && 'animate-spin text-primary',
          )}
        />
        <span className="grid min-w-0 flex-1 gap-1">
          <span className="flex items-center gap-2">
            <strong className="truncate text-sm font-medium text-foreground">
              {child.title || 'Subagent'}
            </strong>
            <Badge
              variant="outline"
              className={cn('shrink-0 capitalize', STATUS_BADGE[status])}
            >
              {statusText}
            </Badge>
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {tools ? `${tools} tools` : 'No tool calls'}
            {preview ? ` · ${preview}` : ''}
          </span>
        </span>
        {status === 'running' && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <Clock3 className="size-3.5" aria-hidden="true" />
            {elapsedSeconds(messages, now)}s
          </span>
        )}
        {expanded ? (
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        )}
      </button>
      {expanded && loadError ? (
        <div
          className="flex items-center justify-between gap-3 border-t border-border p-3 text-xs text-muted-foreground"
          role="alert"
        >
          <span>Could not load transcript.</span>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => {
              setLoadError(false)
              setLoaded(false)
            }}
          >
            Retry
          </Button>
        </div>
      ) : expanded && !loaded && messages.length === 0 ? (
        <div className="border-t border-border p-3 text-xs text-muted-foreground">
          Loading transcript…
        </div>
      ) : expanded ? (
        messages.length ? (
          <SubagentTranscript messages={messages} />
        ) : (
          <div className="border-t border-border p-3 text-xs text-muted-foreground">
            No transcript items.
          </div>
        )
      ) : null}
    </article>
  )
}
