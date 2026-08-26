import { ChevronDown, FileText } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Virtualizer } from 'virtua'
import { Link, useParams } from '@tanstack/react-router'
import { useMessagesStore } from '../../stores/messages'
import { MessageRow, ToolCallRow } from './MessageRow'
import { toRenderModel } from './render-model'
import type { ChatRenderItem } from './render-model'
import { SubagentCard } from './SubagentCard'
import { useSessionsStore } from '../../stores/sessions'

const EMPTY_MESSAGES: never[] = []

export function Timeline({
  resumedWithRecap = false,
}: {
  resumedWithRecap?: boolean
}) {
  const { sessionId } = useParams({ from: '/s/$sessionId' })
  const messages = useMessagesStore(
    (state) => state.bySession[sessionId] ?? EMPTY_MESSAGES,
  )
  const children = useSessionsStore((state) =>
    state.sessions.filter((session) => session.parentSessionId === sessionId),
  )
  const items = useMemo(
    () => toRenderModel(messages, resumedWithRecap, children),
    [messages, resumedWithRecap, children],
  )
  const scrollRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  useEffect(() => {
    if (atBottom)
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [items.length, atBottom])
  return (
    <section className="chat-timeline-shell">
      <div
        ref={scrollRef}
        className="chat-timeline"
        onScroll={(event) => {
          const node = event.currentTarget
          setAtBottom(
            node.scrollHeight - node.scrollTop - node.clientHeight < 48,
          )
        }}
      >
        <Virtualizer<ChatRenderItem> data={items} shift>
          {(item: ChatRenderItem) => (
            <RenderItem key={item.id} item={item} sessionId={sessionId} />
          )}
        </Virtualizer>
      </div>
      {!atBottom && (
        <button
          className="chat-jump"
          onClick={() => {
            scrollRef.current?.scrollTo({
              top: scrollRef.current.scrollHeight,
              behavior: 'smooth',
            })
            setAtBottom(true)
          }}
        >
          <ChevronDown size={16} /> Jump to latest
        </button>
      )}
    </section>
  )
}

function RenderItem({
  item,
  sessionId,
}: {
  item: ReturnType<typeof toRenderModel>[number]
  sessionId: string
}) {
  if (item.kind === 'message') return <MessageRow item={item} />
  if (item.kind === 'tool') return <ToolCallRow item={item} />
  if (item.kind === 'subagent') return <SubagentCard child={item.child} />
  if (item.kind === 'attachment')
    return (
      <Link
        className="chat-attachment"
        to="/files/$projectId/$"
        params={{ projectId: sessionId, _splat: item.path }}
      >
        <FileText size={15} /> {item.filename}
      </Link>
    )
  return <div className="chat-system">{item.text}</div>
}
