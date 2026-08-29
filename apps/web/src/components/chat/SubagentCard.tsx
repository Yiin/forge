import { Bot, ChevronDown } from 'lucide-react'
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
import { RunningDots } from './MessageRow'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'

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

  const failed = status === 'errored' || status === 'interrupted'
  const statusText = status === 'unknown' ? 'status unknown' : status
  return (
    <article
      className="subagent-card rounded-2xl border border-input bg-background p-3 shadow-xs/5 not-dark:bg-clip-padding dark:bg-input/32"
      data-subagent-status={status}
    >
      <div
        className="-m-1 flex cursor-pointer items-center gap-1.5 rounded-md p-1 transition-colors select-none hover:bg-accent/20 focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-inset focus-visible:outline-none"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          setExpanded((value) => !value)
        }}
      >
        <span
          className={cn(
            'flex size-5 shrink-0 items-center justify-center',
            failed ? 'text-destructive' : 'text-muted-foreground/65',
          )}
        >
          <Bot
            className="block size-3.5 shrink-0 stroke-[1.8] opacity-80"
            aria-hidden
          />
        </span>
        <p className="flex min-w-0 flex-1 items-baseline gap-1.5 text-[12px] leading-5">
          <span
            className={cn(
              'min-w-0 shrink truncate font-medium',
              failed ? 'text-destructive' : 'text-foreground/82',
            )}
          >
            {child.title || 'Subagent'}
          </span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground/55">
            {tools ? `${tools} tools` : 'No tool calls'}
            {preview ? ` · ${preview}` : ''}
          </span>
        </p>
        <div className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground/70 tabular-nums">
          {status === 'running' ? (
            <>
              <span className="sr-only">Running</span>
              <RunningDots />
              <span>{elapsedSeconds(messages, now)}s</span>
            </>
          ) : (
            <span className="capitalize">{statusText}</span>
          )}
          <ChevronDown
            className={cn(
              'size-3 shrink-0 opacity-70 transition-transform duration-200',
              expanded && 'rotate-180',
            )}
            aria-hidden
          />
        </div>
      </div>
      {expanded && loadError ? (
        <div
          className="mt-2 flex items-center justify-between gap-3 border-t border-border/45 pt-2 text-xs text-muted-foreground"
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
        <div className="mt-2 border-t border-border/45 pt-2 text-xs text-muted-foreground">
          Loading transcript…
        </div>
      ) : expanded ? (
        messages.length ? (
          <div className="mt-2 border-t border-border/45 pt-2">
            <SubagentTranscript messages={messages} />
          </div>
        ) : (
          <div className="mt-2 border-t border-border/45 pt-2 text-xs text-muted-foreground">
            No transcript items.
          </div>
        )
      ) : null}
    </article>
  )
}
