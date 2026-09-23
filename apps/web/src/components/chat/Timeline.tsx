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
import { MessageRow, USER_FOLD_EVENT, type UserFoldDetail } from './MessageRow'
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
  promptIndex,
  rowMeta,
  workingPhase,
  type RowMeta,
  type WorkingPhase,
} from './transcript-layout'
import { ATTACH_MS, TranscriptScroll } from './transcript-scroll'
import { prefersReducedMotion } from './motion'
import { noteArrivals, type Arrivals } from './tool-reveal'
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
  offline = false,
  onRetry,
}: {
  resumedWithRecap?: boolean
  targetSeq?: number
  /** Height of the composer overlay, kept clear so the last row stays visible. */
  bottomInset?: number
  skills?: string[]
  running?: boolean
  /** The live connection is down; waiting prompts read as queued. */
  offline?: boolean
  /** Sends the prompts that never reached the server again. */
  onRetry?: () => void
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
  const phase = workingPhase({ pending, offline, running, turnStartedAt })
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
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const content = useRef<HTMLDivElement>(null)
  const list = useRef<VirtualizerHandle>(null)
  const driver = useRef<TranscriptScroll>(undefined)
  const [jump, setJump] = useState(false)
  const lastInput = useRef(0)
  const holding = useRef(false)
  const spacer = bottomInset + BOTTOM_CLEARANCE
  const latest = useRef({ items, spacer, bottomInset })
  latest.current = { items, spacer, bottomInset }

  // One driver per scroller and session. React attaches the content ref
  // before this one, so both boxes exist when the driver starts.
  const attachScroller = useCallback(
    (node: HTMLDivElement | null) => {
      driver.current?.dispose()
      driver.current = undefined
      scrollerRef.current = node
      setScroller(node)
      if (!node || !content.current) return
      driver.current = new TranscriptScroll(node, content.current, {
        prompt: (itemId) => {
          const index = promptIndex(latest.current.items, itemId)
          if (index < 0 || !list.current) return undefined
          return { index, offset: list.current.getItemOffset(index) }
        },
        // The runway ends only once both the laid-out rows and virtua's own
        // sizes pass it. virtua sizes a row it has yet to measure from its
        // average, which can be far off for a fresh prompt, and it learns a
        // row's growth a frame after layout; ending on either alone would
        // end the runway early or let the content box shrink under the view.
        tailHeight: (index) => {
          const { items, spacer } = latest.current
          let height = spacer
          for (let row = index; row < items.length; row += 1) {
            const node = content.current?.querySelector<HTMLElement>(
              `[data-row-index="${row}"]`,
            )
            const known = list.current?.getItemSize(row) ?? 0
            height += node ? Math.min(node.offsetHeight, known) : known
          }
          return height
        },
        bottomInset: () => latest.current.bottomInset,
        reducedMotion: prefersReducedMotion,
        onFollow: (state) => setJump(state.jump),
      })
    },
    // A new session starts a fresh driver.
    [sessionId],
  )

  useLayoutEffect(() => {
    if (items.length) driver.current?.contentArrived()
    driver.current?.kick()
  }, [items])
  // Measured rows and a resized viewport move the target; look again.
  useEffect(() => {
    const box = content.current
    if (!scroller || !box || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => driver.current?.kick())
    observer.observe(scroller)
    observer.observe(box)
    if (box.firstElementChild) observer.observe(box.firstElementChild)
    return () => observer.disconnect()
  }, [scroller])
  // Sending a prompt glides it to the top of the view.
  const pendingCount = pending.length
  const newestPending = pending.at(-1)?.itemId
  const previousPending = useRef(pendingCount)
  useLayoutEffect(() => {
    if (pendingCount > previousPending.current && newestPending) {
      holding.current = false
      driver.current?.ownSend(newestPending)
    }
    previousPending.current = pendingCount
  }, [pendingCount, newestPending])
  // After a send, so a composer that shrinks as it clears the text moves a
  // pinned view only when no runway has taken it.
  useLayoutEffect(() => {
    driver.current?.insetChanged()
  }, [spacer])
  // A folding prompt stops the follow and keeps its row in view.
  useEffect(() => {
    if (!scroller) return
    const fold = (event: Event) => {
      const row = (event.target as Element).closest('[data-transcript-row]')
      const detail = (event as CustomEvent<UserFoldDetail | null>).detail
      if (row instanceof HTMLElement && detail)
        driver.current?.foldStart(row, detail.heightChange, detail.heightDelta)
      else driver.current?.release()
    }
    scroller.addEventListener(USER_FOLD_EVENT, fold)
    return () => scroller.removeEventListener(USER_FOLD_EVENT, fold)
  }, [scroller])
  // Selecting text by dragging stops the follow, so the stream cannot
  // carry the selection away.
  useEffect(() => {
    if (!scroller) return
    let pressed = false
    const press = (event: PointerEvent) => {
      pressed = event.button === 0 && event.target !== scroller
    }
    const lift = () => {
      pressed = false
    }
    const select = () => {
      if (!pressed) return
      const selection = document.getSelection()
      if (!selection || selection.isCollapsed) return
      if (!scroller.contains(selection.anchorNode)) return
      pressed = false
      driver.current?.release()
    }
    scroller.addEventListener('pointerdown', press)
    window.addEventListener('pointerup', lift)
    window.addEventListener('pointercancel', lift)
    document.addEventListener('selectionchange', select)
    return () => {
      scroller.removeEventListener('pointerdown', press)
      window.removeEventListener('pointerup', lift)
      window.removeEventListener('pointercancel', lift)
      document.removeEventListener('selectionchange', select)
    }
  }, [scroller])

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
      driver.current?.release()
    }
    if (holding.current) list.current?.scrollToIndex(index, { align: 'center' })
  }, [items, targetSeq, deepLinkId])

  // Tool rows that arrive once the transcript has landed grow in; the rows
  // it opened with are history. Arrival times are noted as the items come,
  // so a row that mounts late, or remounts, plays only what is left.
  const [landed, setLanded] = useState(false)
  const hasItems = items.length > 0
  useEffect(() => {
    if (!hasItems || landed) return
    const timer = setTimeout(() => setLanded(true), ATTACH_MS)
    return () => clearTimeout(timer)
  }, [hasItems, landed])
  const [arrivals] = useState<Arrivals>(() => new Map())
  useMemo(
    () => noteArrivals(arrivals, items, performance.now(), landed),
    [arrivals, items, landed],
  )

  const markInput = () => {
    lastInput.current = performance.now()
    holding.current = false
    driver.current?.userInput()
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

  return (
    <section
      className="chat-timeline-shell relative min-h-0 w-full flex-1"
      style={{ '--fade-bottom': `${bottomInset}px` } as CSSProperties}
    >
      <div
        ref={attachScroller}
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
        onScroll={() => {
          driver.current?.scrolled(
            dragging.current ||
              performance.now() - lastInput.current < INPUT_WINDOW_MS,
          )
        }}
      >
        {/* The runway's reserved space lands on this box as a minimum
            height, so the rows and the spacer need no layout of their own. */}
        <div ref={content}>
          {/* No `shift`: rows are only appended or folded in place, and
              `shift` makes virtua re-index its size cache on every append,
              which offsets every measured row by one and opens blank bands
              between rows. */}
          <Virtualizer<ChatRenderItem>
            ref={list}
            data={items}
            scrollRef={scrollerRef}
          >
            {(item: ChatRenderItem, index: number) => (
              <RenderItem
                key={item.id}
                index={index}
                item={item}
                meta={meta[index]}
                sessionId={sessionId}
                skills={skills}
                live={item.id === liveGroupId}
                arrivals={arrivals}
                deepLink={item.id === deepLinkId}
                phase={phase}
                turnStartedAt={turnStartedAt}
                onRetry={onRetry}
              />
            )}
          </Virtualizer>
          <div aria-hidden style={{ height: spacer }} />
        </div>
      </div>
      <PromptRail
        scroller={scroller}
        handle={list}
        prompts={prompts}
        onNavigate={() => {
          holding.current = false
          driver.current?.release()
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
            onClick={() => {
              holding.current = false
              driver.current?.toBottom()
            }}
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
  index,
  item,
  meta,
  sessionId,
  skills,
  live,
  arrivals,
  deepLink,
  phase,
  turnStartedAt,
  onRetry,
}: {
  index: number
  item: ChatRenderItem
  meta: RowMeta
  sessionId: string
  skills: string[]
  live: boolean
  /** When tool rows arrived; see `noteArrivals`. */
  arrivals: Arrivals
  deepLink: boolean
  phase: WorkingPhase
  turnStartedAt?: string
  onRetry?: () => void
}) {
  return (
    <div
      data-transcript-row
      data-row-index={index}
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
            phase={phase}
            startedAt={turnStartedAt}
            onRetry={onRetry}
          />
        ) : (
          <RenderItemContent
            item={item}
            meta={meta}
            sessionId={sessionId}
            skills={skills}
            live={live}
            arrivals={arrivals}
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
  arrivals,
}: {
  item: ChatRenderItem
  meta: RowMeta
  sessionId: string
  skills: string[]
  live: boolean
  arrivals: Arrivals
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
    return (
      <ToolGroup
        item={item}
        sessionId={sessionId}
        live={live}
        arrivals={arrivals}
      />
    )
  if (item.kind === 'epic-triage') return <EpicTriageCard card={item.card} />
  if (item.kind === 'plan') return <PlanCard item={item} />
  if (item.kind === 'attachment') return <AttachmentItem item={item} />
  if (item.kind === 'system') return <SystemItem item={item} />
  if (item.kind === 'native')
    return <NativeContentRow item={item} sessionId={sessionId} />
  return null
}
