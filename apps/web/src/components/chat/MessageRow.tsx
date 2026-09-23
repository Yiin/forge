import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  GitBranch,
  Minus,
  Pencil,
  X,
} from 'lucide-react'
import type { ComponentType, KeyboardEvent, ReactNode, SVGProps } from 'react'
import { useLayoutEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ChatMarkdown } from './ChatMarkdown'
import type { ChatRenderItem } from './render-model'
import { SkillChipText } from './SkillChipText'
import { formatTimestamp } from './transcript-layout'
import { useCopied } from './useCopied'
import { api } from '../../lib/api'
import { cn } from '../../lib/utils'
import { Tooltip, TooltipPopup, TooltipTrigger } from '../ui/tooltip'

type MessageItem = Extract<ChatRenderItem, { kind: 'message' }>

/** zeron clamps a long prompt to five 22px lines. */
export const USER_COLLAPSED_LINES = 5
const LINE_PX = 22
const COLLAPSED_PX = USER_COLLAPSED_LINES * LINE_PX

/** Asks the transcript to stop following the bottom, such as on a fold. */
export const RELEASE_FOLLOW_EVENT = 'chat:release-follow'

export function MessageRow({
  item,
  sessionId,
  skills = [],
  lane = { copyText: item.text },
  streaming = false,
}: {
  item: MessageItem
  sessionId?: string
  skills?: string[]
  /** The hover lane under a reply; `false` while the entry is unsettled. */
  lane?: { copyText: string } | false
  streaming?: boolean
}) {
  const fork = async (branch: boolean) => {
    if (!sessionId) return
    const text = branch
      ? 'Continue from this point.'
      : window.prompt('Edit this message', item.text)
    if (!text?.trim()) return
    try {
      const result = (await api.fork({
        sessionId,
        messageSeq: item.seq,
        text: text.trim(),
        includeSource: branch,
      })) as { sessionId: string }
      window.location.assign(`/s/${encodeURIComponent(result.sessionId)}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Fork failed')
    }
  }
  if (item.role === 'user')
    return (
      <article
        className="chat-row chat-user group flex min-w-0 flex-col items-end"
        data-seq={item.pending ? undefined : item.seq}
        data-pending={item.pending ? 'true' : undefined}
        data-delivery={item.pending ? item.delivery : undefined}
        aria-busy={
          item.pending && item.delivery !== 'unsent' ? true : undefined
        }
      >
        <UserBubble item={item} skills={skills} />
        <HoverLane align="end">
          {!item.pending && (
            <>
              <Timestamp iso={item.createdAt} />
              <CopyButton text={item.text} />
              {sessionId && (
                <LaneButton
                  label="Edit"
                  hint="Edit and fork"
                  onClick={() => void fork(false)}
                >
                  <Pencil className="size-3.5" aria-hidden />
                </LaneButton>
              )}
            </>
          )}
        </HoverLane>
      </article>
    )
  return (
    <article
      className="chat-row chat-agent group relative min-w-0"
      data-seq={item.seq}
    >
      <ChatMarkdown text={item.text} streaming={streaming} />
      {lane && (
        <HoverLane align="start">
          <Timestamp iso={item.createdAt} />
          <CopyButton text={lane.copyText} />
          {sessionId && (
            <LaneButton
              label="Branch from here"
              onClick={() => void fork(true)}
            >
              <GitBranch className="size-3.5" aria-hidden />
            </LaneButton>
          )}
        </HoverLane>
      )}
    </article>
  )
}

/**
 * A right-aligned plate. Past five lines it clips hard, adds an ellipsis
 * line, and offers Show more; the clip height eases open.
 */
function UserBubble({ item, skills }: { item: MessageItem; skills: string[] }) {
  const clip = useRef<HTMLDivElement>(null)
  const [full, setFull] = useState<number>()
  const [collapsed, setCollapsed] = useState(true)
  const [duration, setDuration] = useState(220)
  useLayoutEffect(() => {
    const node = clip.current
    if (!node) return
    const measure = () => setFull(node.scrollHeight || undefined)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [item.text])
  // Before the first measurement, fall back to zeron's text heuristic.
  const long =
    full === undefined
      ? item.text.split('\n').length > USER_COLLAPSED_LINES ||
        item.text.length > 400
      : full > COLLAPSED_PX + 1
  const folded = long && collapsed
  const delta = Math.abs((full ?? COLLAPSED_PX) - COLLAPSED_PX)
  const toggle = (event: { currentTarget: HTMLElement }) => {
    setDuration(Math.min(220 + 0.32 * delta, 850))
    setCollapsed((value) => !value)
    event.currentTarget.dispatchEvent(
      new CustomEvent(RELEASE_FOLLOW_EVENT, { bubbles: true }),
    )
  }
  return (
    <div
      className={cn(
        'max-w-[calc(var(--transcript-width)*0.8)] min-w-0 rounded-[16px] bg-wash/4 px-4 py-2.5 text-[0.875rem] leading-[1.375rem] break-words whitespace-pre-wrap text-foreground dark:bg-wash/8',
        item.pending && 'opacity-65',
      )}
    >
      <div
        ref={clip}
        className={cn(long && 'overflow-hidden')}
        style={
          long
            ? {
                maxHeight: folded ? COLLAPSED_PX : full,
                transition: `max-height ${duration}ms ${
                  delta > 500
                    ? 'cubic-bezier(0.42, 0, 0.58, 1)'
                    : 'cubic-bezier(0, 0, 0.58, 1)'
                }`,
              }
            : undefined
        }
      >
        <SkillChipText text={item.text} skills={skills} />
      </div>
      {folded && (
        <div className="h-[1.375rem]" aria-hidden>
          ...
        </div>
      )}
      {long && (
        <button
          type="button"
          className="mt-2 flex cursor-pointer items-center gap-[5px] text-muted-foreground transition-colors duration-150 hover:text-foreground pointer-coarse:min-h-11"
          aria-expanded={!folded}
          onClick={toggle}
        >
          {folded ? 'Show more' : 'Show less'}
          {folded ? (
            <ChevronDown className="size-3" aria-hidden />
          ) : (
            <ChevronUp className="size-3" aria-hidden />
          )}
        </button>
      )}
    </div>
  )
}

/**
 * The 32px lane under a message: always reserved so hover never shifts the
 * layout, and faded in on hover or keyboard focus. Touch screens have no
 * hover, so there it always shows.
 */
function HoverLane({
  align,
  children,
}: {
  align: 'start' | 'end'
  children: ReactNode
}) {
  return (
    <div
      className={cn(
        'flex h-8 items-center gap-2 pt-2 opacity-0 transition-opacity duration-150 ease-[cubic-bezier(0.25,0.1,0.25,1)] group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100',
        align === 'end' ? 'justify-end' : 'justify-start',
      )}
    >
      {children}
    </div>
  )
}

function Timestamp({ iso }: { iso?: string }) {
  const label = formatTimestamp(iso)
  if (!label) return null
  return (
    <time
      dateTime={iso}
      className="text-xs text-muted-foreground/55 tabular-nums"
    >
      {label}
    </time>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, copy] = useCopied()
  return (
    <LaneButton
      label="Copy message"
      hint={copied ? 'Copied' : 'Copy'}
      onClick={() => copy(text)}
    >
      {copied ? (
        <Check className="size-3.5" aria-hidden />
      ) : (
        <Copy className="size-3.5" aria-hidden />
      )}
    </LaneButton>
  )
}

function LaneButton({
  label,
  hint = label,
  onClick,
  children,
}: {
  label: string
  hint?: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 ease-[cubic-bezier(0.4,0,0.2,1)] hover:bg-ink/8 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:outline-none pointer-coarse:size-11"
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup>{hint}</TooltipPopup>
    </Tooltip>
  )
}

/**
 * One quiet line of agent work, like a tool group header: an icon, a
 * heading, a faint preview, and a chevron. Opening shows the raw detail
 * under a hanging rule.
 */
export function WorkEntryRow({
  icon: Icon,
  heading,
  preview,
  state,
  expanded,
  detailId,
  onToggle,
  children,
}: {
  icon: ComponentType<SVGProps<SVGSVGElement>>
  heading: string
  preview?: string
  state?: 'running' | 'done' | 'error'
  expanded: boolean
  detailId: string
  onToggle: () => void
  children: ReactNode
}) {
  const toggle = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    onToggle()
  }
  return (
    <div
      className="group/work flex cursor-pointer flex-col text-xs leading-[18px] focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:outline-none"
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      aria-controls={detailId}
      onClick={onToggle}
      onKeyDown={toggle}
    >
      <div className="flex h-[26px] items-center gap-1.5 text-muted-foreground transition-colors duration-150 select-none group-hover/work:text-foreground pointer-coarse:h-11">
        <span className="flex h-[18px] w-[22px] flex-none items-center justify-center">
          <Icon className="size-3.5 shrink-0" aria-hidden />
        </span>
        <p className="flex min-w-0 items-baseline gap-1.5">
          <span className="min-w-0 shrink truncate">{heading}</span>
          {preview && (
            <span className="min-w-0 flex-1 truncate text-faint-foreground">
              {preview}
            </span>
          )}
        </p>
        <ChevronDown
          className="size-3.5 shrink-0 text-faint-foreground transition-transform duration-[140ms] ease-[cubic-bezier(0,0,0.58,1)]"
          style={{ transform: `rotate(${expanded ? 0 : -90}deg)` }}
          aria-hidden
        />
        <StatusChip state={state} />
      </div>
      {expanded && (
        <div
          id={detailId}
          className="ms-[10px] mt-1 mb-1 cursor-default border-s border-ink/10 ps-4 pt-0.5 text-foreground"
          onClick={(event) => event.stopPropagation()}
        >
          {children}
        </div>
      )}
    </div>
  )
}

function StatusChip({ state }: { state?: 'running' | 'done' | 'error' }) {
  if (state === undefined) return null
  if (state === 'running')
    return (
      <>
        <span className="sr-only">Running</span>
        <RunningDots />
      </>
    )
  const [Icon, label] =
    state === 'error'
      ? [X, 'Failed']
      : state === 'done'
        ? [Check, 'Completed']
        : [Minus, 'Empty']
  return (
    <span
      className={cn(
        'flex size-4 items-center justify-center',
        state === 'error' && 'text-destructive',
      )}
      title={label}
    >
      <Icon className="size-3 shrink-0" aria-hidden />
      <span className="sr-only">{label}</span>
    </span>
  )
}

/** Three duty-cycled dots: the resting indicator for work still in flight. */
export function RunningDots() {
  return (
    <span className="inline-flex items-center gap-[3px]" aria-hidden>
      <span className="h-1 w-1 animate-status-pulse rounded-full bg-muted-foreground/30 motion-reduce:animate-none" />
      <span className="h-1 w-1 animate-status-pulse rounded-full bg-muted-foreground/30 [animation-delay:200ms] motion-reduce:animate-none" />
      <span className="h-1 w-1 animate-status-pulse rounded-full bg-muted-foreground/30 [animation-delay:400ms] motion-reduce:animate-none" />
    </span>
  )
}
