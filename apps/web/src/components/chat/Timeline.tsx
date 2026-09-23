import type { CSSProperties } from 'react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Virtualizer, type VirtualizerHandle } from 'virtua'
import { useParams } from '@tanstack/react-router'
import { useMessagesStore } from '../../stores/messages'
import { MessageRow, RELEASE_FOLLOW_EVENT } from './MessageRow'
import { toRenderModel } from './render-model'
import type { ChatRenderItem } from './render-model'
import { AnsweredQuestionRow } from './AnsweredQuestionRow'
import { SubagentCard } from './SubagentCard'
import { AgentToolCard, ToolGroup } from './ToolGroup'
import { EpicTriageCard } from './EpicTriageCard'
import { useSessionsStore } from '../../stores/sessions'
import { cn } from '../../lib/utils'
import { NativeContentRow } from './NativeContentRow'
import { AttachmentItem, PlanCard, SystemItem } from './TranscriptItems'
import { WorkingLine } from './WorkingLine'
import { PromptRail } from './PromptRail'
import { railPrompts } from './prompt-rail'
import {
  BOTTOM_CLEARANCE,
  rowMeta,
  sendingBridge,
  type RowMeta,
} from './transcript-layout'
import {
  distanceFromBottom,
  followAfterScroll,
  initialFollow,
  jumpStart,
  releaseFollow,
  restoreFollow,
} from './scroll-follow'
import './transcript.css'

const EMPTY_MESSAGES: never[] = []
/** A scroll this soon after wheel, touch or key input counts as the user's. */
const INPUT_WINDOW_MS = 250
const SCROLL_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  ' ',
])

export function Timeline({
  resumedWithRecap = false,
  targetSeq,
  bottomInset = 0,
  skills = [],
  running = false,
}: {
  resumedWithRecap?: boolean
  targetSeq?: number
  /** Height of the composer overlay, kept clear so the last row stays visible. */
  bottomInset?: number
  skills?: string[]
  running?: boolean
}) {
  const { sessionId } = useParams({ from: '/s/$sessionId' })
  const messagesBySession = useMessagesStore((state) => state.bySession)
  const messagesVersion = useMessagesStore((state) => state.lastSeq)
  const messages = messagesBySession[sessionId] ?? EMPTY_MESSAGES
  const pending = useMessagesStore(
    (state) => state.pendingBySession[sessionId] ?? EMPTY_MESSAGES,
  )
  const sessions = useSessionsStore((state) => state.sessions)
  const children = useMemo(
    () => sessions.filter((session) => session.parentSessionId === sessionId),
    [sessions, sessionId],
  )
  const working = running || pending.length > 0
  const items = useMemo(() => {
    const base = toRenderModel(messages, resumedWithRecap, children, pending)
    return working
      ? [...base, { kind: 'working' as const, id: 'working-indicator' }]
      : base
  }, [messages, messagesVersion, resumedWithRecap, children, pending, working])
  const meta = useMemo(() => rowMeta(items, running), [items, running])
  const prompts = useMemo(() => railPrompts(items), [items])
  // The running turn began at its turn_start, or at the prompt that opened
  // it when the harness sends no turn_start of its own.
  const turnStartedAt = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (
        message.content.type === 'turn_start' ||
        (message.role === 'user' && message.content.type === 'text_delta')
      )
        return message.createdAt
    }
    return undefined
    // The store appends to the same array, so its length marks new rows.
  }, [messages, messages.length])
  const sending =
    !running || sendingBridge(pending.at(-1)?.createdAt, turnStartedAt)
  // zeron opens a tool group by default only while it is the live tail of
  // the streaming turn; pending user bubbles trail the turn, so skip them.
  const liveGroupId = useMemo(() => {
    if (!running) return undefined
    const tail = items
      .filter(
        (item) =>
          item.kind !== 'working' && !(item.kind === 'message' && item.pending),
      )
      .at(-1)
    return tail?.kind === 'tool-group' ? tail.id : undefined
  }, [items, running])

  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  const list = useRef<VirtualizerHandle>(null)
  // The view starts pinned; a deep link releases it once its row exists.
  const follow = useRef(initialFollow)
  const [jump, setJump] = useState(false)
  const lastInput = useRef(0)
  const holding = useRef(false)
  const spacer = bottomInset + BOTTOM_CLEARANCE
  const spacerRef = useRef(spacer)
  spacerRef.current = spacer

  const setFollow = useCallback((next: typeof initialFollow) => {
    follow.current = next
    setJump(next.jump)
  }, [])
  // virtua sizes its box from row measurements that land after the commit,
  // and its rows overflow that box, so `scrollHeight` can still leave the
  // spacer out. Aim past the end by the spacer; the browser clamps it.
  const pin = useCallback(() => {
    if (!scroller || !follow.current.pinned) return
    scroller.scrollTo({ top: scroller.scrollHeight + spacerRef.current })
  }, [scroller])

  useLayoutEffect(pin, [pin, items, spacer])
  // Pin again once measured rows land and resize the scrolled content.
  useEffect(() => {
    if (!scroller || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(pin)
    for (const child of scroller.children) observer.observe(child)
    return () => observer.disconnect()
  }, [scroller, pin])
  // Sending a prompt follows the bottom again.
  const pendingCount = pending.length
  const previousPending = useRef(pendingCount)
  useLayoutEffect(() => {
    if (pendingCount > previousPending.current) {
      holding.current = false
      setFollow(restoreFollow(follow.current))
      pin()
    }
    previousPending.current = pendingCount
  }, [pendingCount, pin, setFollow])
  // A folding bubble or a rail jump asks the view to stop following.
  useEffect(() => {
    if (!scroller) return
    const release = () => setFollow(releaseFollow(follow.current))
    scroller.addEventListener(RELEASE_FOLLOW_EVENT, release)
    return () => scroller.removeEventListener(RELEASE_FOLLOW_EVENT, release)
  }, [scroller, setFollow])

  // `?m=<seq>` centres that message and marks it until the reader scrolls.
  const [deepLinkId, setDeepLinkId] = useState<string>()
  useEffect(() => {
    if (targetSeq === undefined) return
    const index = items.findIndex(
      (item) => item.kind === 'message' && item.seq === targetSeq,
    )
    if (index < 0) return
    if (deepLinkId === undefined) {
      holding.current = true
      setDeepLinkId(items[index].id)
      setFollow(releaseFollow(follow.current))
    }
    if (holding.current) list.current?.scrollToIndex(index, { align: 'center' })
  }, [items, targetSeq, deepLinkId, setFollow])

  const markInput = () => {
    lastInput.current = performance.now()
    holding.current = false
  }
  const dragging = useRef(false)
  useEffect(() => {
    const stop = () => {
      dragging.current = false
    }
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    return () => {
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
  }, [])

  const toBottom = () => {
    if (!scroller) return
    holding.current = false
    setFollow(restoreFollow(follow.current))
    const max = scroller.scrollHeight - scroller.clientHeight
    const start = jumpStart(
      distanceFromBottom(scroller),
      scroller.clientHeight,
      max,
    )
    if (start !== undefined) scroller.scrollTop = start
    const reduce = window.matchMedia?.(
      '(prefers-reduced-motion: reduce)',
    ).matches
    scroller.scrollTo({
      top: scroller.scrollHeight + spacer,
      behavior: reduce ? 'auto' : 'smooth',
    })
  }

  return (
    <section
      className="chat-timeline-shell relative min-h-0 w-full flex-1"
      style={{ '--fade-bottom': `${bottomInset}px` } as CSSProperties}
    >
      <div
        ref={setScroller}
        className="chat-timeline h-full overflow-auto overscroll-contain [-webkit-overflow-scrolling:touch]"
        onWheel={markInput}
        onTouchStart={markInput}
        onTouchMove={markInput}
        onKeyDown={(event) => {
          if (SCROLL_KEYS.has(event.key)) markInput()
        }}
        onPointerDown={(event) => {
          // A press on the scroller itself is a press on its scrollbar.
          if (event.target === event.currentTarget) {
            dragging.current = true
            markInput()
          }
        }}
        onScroll={(event) => {
          const userInput =
            dragging.current ||
            performance.now() - lastInput.current < INPUT_WINDOW_MS
          const next = followAfterScroll(
            follow.current,
            distanceFromBottom(event.currentTarget),
            userInput,
          )
          if (next.pinned !== follow.current.pinned || next.jump !== jump)
            setFollow(next)
          else follow.current = next
        }}
      >
        {/* No `shift`: rows are only appended or folded in place, and `shift`
            makes virtua re-index its size cache on every append, which offsets
            every measured row by one and opens blank bands between rows. */}
        <Virtualizer<ChatRenderItem> ref={list} data={items}>
          {(item: ChatRenderItem, index: number) => (
            <RenderItem
              key={item.id}
              item={item}
              meta={meta[index]}
              sessionId={sessionId}
              skills={skills}
              live={item.id === liveGroupId}
              deepLink={item.id === deepLinkId}
              sending={sending}
              turnStartedAt={turnStartedAt}
            />
          )}
        </Virtualizer>
        <div aria-hidden style={{ height: spacer }} />
      </div>
      <PromptRail
        scroller={scroller}
        handle={list}
        prompts={prompts}
        onNavigate={() => {
          holding.current = false
          setFollow(releaseFollow(follow.current))
        }}
      />
      {jump && (
        <div
          className="pointer-events-none absolute inset-x-0 z-30 flex justify-center pe-2.5"
          style={{ bottom: bottomInset + 6 }}
        >
          <button
            type="button"
            className="chat-jump pointer-events-auto flex h-[30px] cursor-pointer items-center gap-1.5 rounded-full border border-border bg-surface-raised ps-[11px] pe-[13px] text-[13px] text-foreground shadow-md transition-colors duration-150 hover:bg-[color-mix(in_oklab,var(--surface-raised),var(--foreground)_8%)] focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:outline-none"
            onClick={toBottom}
          >
            <span className="text-muted-foreground" aria-hidden>
              ↓
            </span>
            Scroll to bottom
          </button>
        </div>
      )}
    </section>
  )
}

function RenderItem({
  item,
  meta,
  sessionId,
  skills,
  live,
  deepLink,
  sending,
  turnStartedAt,
}: {
  item: ChatRenderItem
  meta: RowMeta
  sessionId: string
  skills: string[]
  live: boolean
  deepLink: boolean
  sending: boolean
  turnStartedAt?: string
}) {
  return (
    <div
      className="flex w-full justify-center px-5 sm:px-12"
      style={{ paddingTop: meta.gap }}
    >
      <div
        className={cn(
          'w-full max-w-(--transcript-width) min-w-0 overflow-x-clip',
          deepLink && 'chat-deep-link-target',
        )}
      >
        {item.kind === 'working' ? (
          <WorkingLine
            seed={sessionId}
            sending={sending}
            startedAt={turnStartedAt}
          />
        ) : (
          <RenderItemContent
            item={item}
            meta={meta}
            sessionId={sessionId}
            skills={skills}
            live={live}
          />
        )}
      </div>
    </div>
  )
}

function RenderItemContent({
  item,
  meta,
  sessionId,
  skills,
  live,
}: {
  item: ChatRenderItem
  meta: RowMeta
  sessionId: string
  skills: string[]
  live: boolean
}) {
  if (item.kind === 'message')
    return (
      <MessageRow
        item={item}
        sessionId={sessionId}
        skills={skills}
        lane={meta.lane ?? false}
        streaming={meta.streaming}
      />
    )
  if (item.kind === 'tool')
    return <AgentToolCard tool={item} sessionId={sessionId} />
  if (item.kind === 'answered-question')
    return <AnsweredQuestionRow question={item.question} answer={item.answer} />
  if (item.kind === 'subagent')
    return <SubagentCard child={item.child} skills={skills} />
  if (item.kind === 'tool-group')
    return <ToolGroup item={item} sessionId={sessionId} live={live} />
  if (item.kind === 'epic-triage') return <EpicTriageCard card={item.card} />
  if (item.kind === 'plan') return <PlanCard item={item} />
  if (item.kind === 'attachment') return <AttachmentItem item={item} />
  if (item.kind === 'system') return <SystemItem item={item} />
  if (item.kind === 'native')
    return <NativeContentRow item={item} sessionId={sessionId} />
  return null
}
