import { ChevronDown, File, FileImage } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Virtualizer } from 'virtua'
import { useParams } from '@tanstack/react-router'
import { useMessagesStore } from '../../stores/messages'
import { MessageRow, ToolCallRow } from './MessageRow'
import { toRenderModel } from './render-model'
import type { ChatRenderItem } from './render-model'
import { AnsweredQuestionRow } from './AnsweredQuestionRow'
import { SubagentCard } from './SubagentCard'
import { ActivityStack } from './ActivityStack'
import { EpicTriageCard } from './EpicTriageCard'
import { useSessionsStore } from '../../stores/sessions'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'

const EMPTY_MESSAGES: never[] = []

export function Timeline({
  resumedWithRecap = false,
  targetSeq,
  bottomInset = 0,
  skills = [],
}: {
  resumedWithRecap?: boolean
  targetSeq?: number
  /** Height of the composer overlay, kept clear so the last row stays visible. */
  bottomInset?: number
  skills?: string[]
}) {
  const { sessionId } = useParams({ from: '/s/$sessionId' })
  const messages = useMessagesStore(
    (state) => state.bySession[sessionId] ?? EMPTY_MESSAGES,
  )
  const pending = useMessagesStore(
    (state) => state.pendingBySession[sessionId] ?? EMPTY_MESSAGES,
  )
  const sessions = useSessionsStore((state) => state.sessions)
  const children = useMemo(
    () => sessions.filter((session) => session.parentSessionId === sessionId),
    [sessions, sessionId],
  )
  const items = useMemo(
    () => toRenderModel(messages, resumedWithRecap, children, pending),
    [messages, resumedWithRecap, children, pending],
  )
  const scrollRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  // The bottom spacer grows with the composer, so re-pin before paint whenever
  // the inset changes; otherwise the last row hides under the composer.
  // virtua sizes its box from row measurements that land after the commit, and
  // its rows overflow that box, so `scrollHeight` still leaves the spacer out
  // while the box is short. Aim past the end by the inset: the browser clamps
  // the overshoot, and the timeline no longer parks one composer above bottom.
  useLayoutEffect(() => {
    if (atBottom)
      scrollRef.current?.scrollTo({
        top: scrollRef.current.scrollHeight + bottomInset,
      })
  }, [items, atBottom, bottomInset])
  // The clamp above uses the height virtua has applied so far, so pin again
  // once the measured rows land and the spacer joins the scrollable area.
  useEffect(() => {
    const node = scrollRef.current
    if (!node || !atBottom || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      node.scrollTo({ top: node.scrollHeight + bottomInset })
    })
    for (const child of node.children) observer.observe(child)
    return () => observer.disconnect()
  }, [atBottom, bottomInset])
  useEffect(() => {
    if (targetSeq === undefined) return
    const target = scrollRef.current?.querySelector(`[data-seq="${targetSeq}"]`)
    if (target instanceof HTMLElement) {
      target.scrollIntoView({ block: 'center' })
      target.classList.add('chat-deep-link-target')
    }
  }, [items, targetSeq])
  return (
    <section className="chat-timeline-shell relative min-h-0 w-full flex-1">
      <div
        ref={scrollRef}
        className="chat-timeline h-full overflow-auto overscroll-contain px-3 py-5 [-webkit-overflow-scrolling:touch] sm:px-5"
        onScroll={(event) => {
          const node = event.currentTarget
          setAtBottom(
            node.scrollHeight - node.scrollTop - node.clientHeight < 48,
          )
        }}
      >
        {/* No `shift`: rows are only appended or folded in place, and `shift`
            makes virtua re-index its size cache on every append, which offsets
            every measured row by one and opens blank bands between rows. */}
        <Virtualizer<ChatRenderItem> data={items}>
          {(item: ChatRenderItem) => (
            <RenderItem
              key={item.id}
              item={item}
              sessionId={sessionId}
              skills={skills}
            />
          )}
        </Virtualizer>
        <div aria-hidden style={{ height: bottomInset }} />
      </div>
      {!atBottom && (
        <Button
          className="chat-jump absolute left-1/2 z-30 -translate-x-1/2 rounded-full border border-border/60 bg-card shadow-sm"
          style={{ bottom: bottomInset + 4 }}
          variant="secondary"
          size="sm"
          onClick={() => {
            scrollRef.current?.scrollTo({
              top: scrollRef.current.scrollHeight + bottomInset,
              behavior: 'smooth',
            })
            setAtBottom(true)
          }}
        >
          <ChevronDown className="size-4" /> Jump to latest
        </Button>
      )}
    </section>
  )
}

function RenderItem({
  item,
  sessionId,
  skills,
}: {
  item: ReturnType<typeof toRenderModel>[number]
  sessionId: string
  skills: string[]
}) {
  return (
    <div
      className={cn(
        'mx-auto w-full min-w-0 max-w-3xl overflow-x-clip',
        item.kind === 'tool' ||
          item.kind === 'subagent' ||
          item.kind === 'activity'
          ? 'pb-2'
          : 'pb-4',
      )}
    >
      <RenderItemContent item={item} sessionId={sessionId} skills={skills} />
    </div>
  )
}

function RenderItemContent({
  item,
  sessionId,
  skills,
}: {
  item: ReturnType<typeof toRenderModel>[number]
  sessionId: string
  skills: string[]
}) {
  if (item.kind === 'message')
    return <MessageRow item={item} sessionId={sessionId} skills={skills} />
  if (item.kind === 'tool') return <ToolCallRow item={item} />
  if (item.kind === 'answered-question')
    return <AnsweredQuestionRow question={item.question} answer={item.answer} />
  if (item.kind === 'subagent')
    return <SubagentCard child={item.child} skills={skills} />
  if (item.kind === 'activity') return <ActivityStack item={item} />
  if (item.kind === 'epic-triage') return <EpicTriageCard card={item.card} />
  if (item.kind === 'attachment') return <AttachmentItem item={item} />
  if (item.kind === 'system') return <SystemItem item={item} />
  return null
}

function SystemItem({
  item,
}: {
  item: Extract<ChatRenderItem, { kind: 'system' }>
}) {
  return (
    <div
      className={cn(
        'chat-system px-2 py-2 text-center text-xs',
        item.alert ? 'text-destructive' : 'text-muted-foreground',
      )}
      role={item.alert ? 'alert' : undefined}
    >
      <span>{item.text}</span>
      {item.code && (
        <details className="chat-system-details mt-1 text-left">
          <summary className="cursor-pointer text-muted-foreground">
            Show process details
          </summary>
          <pre className="mt-1 overflow-auto rounded-lg border border-border bg-card p-2 whitespace-pre-wrap">
            {item.code}
          </pre>
        </details>
      )}
    </div>
  )
}

function AttachmentItem({
  item,
}: {
  item: Extract<ChatRenderItem, { kind: 'attachment' }>
}) {
  const [removed, setRemoved] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    void fetch(`/api/attachments/${encodeURIComponent(item.id)}`, {
      headers: { Range: 'bytes=0-0' },
      signal: controller.signal,
    })
      .then((response) => {
        if (response.status === 410) setRemoved(true)
      })
      .catch(() => undefined)
    return () => controller.abort()
  }, [item.id])
  if (removed)
    return (
      <span className="chat-attachment flex w-fit items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-sm text-muted-foreground">
        {item.filename} · file removed
      </span>
    )
  return (
    <a
      className="chat-attachment flex w-fit items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-sm text-foreground no-underline hover:bg-accent"
      href={`/api/attachments/${encodeURIComponent(item.id)}`}
      target={item.mime?.startsWith('image/') ? '_blank' : undefined}
      rel="noreferrer"
    >
      {item.mime?.startsWith('image/') ? (
        <FileImage className="size-3.5 text-muted-foreground" />
      ) : (
        <File className="size-3.5 text-muted-foreground" />
      )}
      {item.filename}
      {item.sizeBytes !== undefined && (
        <small className="text-muted-foreground">
          {formatBytes(item.sizeBytes)}
        </small>
      )}
    </a>
  )
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
}
