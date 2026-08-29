import {
  Bot,
  Check,
  ChevronDown,
  Eye,
  Globe,
  Hammer,
  Minus,
  SquarePen,
  Terminal,
  Wrench,
  X,
  Copy,
  GitBranch,
  Pencil,
} from 'lucide-react'
import type { ComponentType, KeyboardEvent, SVGProps } from 'react'
import { useState } from 'react'
import { toast } from 'sonner'
import { ChatMarkdown } from './ChatMarkdown'
import type { ChatRenderItem } from './render-model'
import { SkillChipText } from './SkillChipText'
import { summarizeToolCall } from './tool-summary'
import { api } from '../../lib/api'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Tooltip, TooltipPopup, TooltipTrigger } from '../ui/tooltip'

const META_ROW_CLASS =
  'mt-1.5 flex items-center gap-2 text-xs tabular-nums opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100'

export function MessageRow({
  item,
  sessionId,
}: {
  item: Extract<ChatRenderItem, { kind: 'message' }>
  sessionId?: string
}) {
  const [open, setOpen] = useState(!item.thought)
  const copy = async () => {
    await navigator.clipboard.writeText(item.text)
    toast.success('Copied message')
  }
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
  if (item.thought)
    return (
      <article className="chat-row chat-thought" data-seq={item.seq}>
        <WorkEntryRow
          icon={Bot}
          heading="Thought"
          expanded={open}
          detailId={`thought-${item.id}`}
          onToggle={() => setOpen(!open)}
        >
          <ChatMarkdown text={item.text} />
        </WorkEntryRow>
      </article>
    )
  if (item.role === 'user')
    return (
      <article
        className="chat-row chat-user group flex flex-col items-end gap-1"
        data-seq={item.seq}
      >
        <div className="relative max-w-[80%] rounded-2xl border border-border bg-secondary p-3 text-sm text-foreground">
          <SkillChipText text={item.text} skills={[]} />
        </div>
        <div className={META_ROW_CLASS}>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Copy message"
            onClick={() => void copy()}
          >
            <Copy className="size-3.5" />
          </Button>
          {sessionId && (
            <Button variant="ghost" size="xs" onClick={() => void fork(false)}>
              <Pencil className="size-3.5" /> Edit
            </Button>
          )}
        </div>
      </article>
    )
  return (
    <article
      className="chat-row chat-agent group relative min-w-0 px-1 py-0.5"
      data-seq={item.seq}
    >
      <ChatMarkdown text={item.text} />
      <div className={META_ROW_CLASS}>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Copy message"
          onClick={() => void copy()}
        >
          <Copy className="size-3.5" />
        </Button>
        {sessionId && (
          <Button variant="ghost" size="xs" onClick={() => void fork(true)}>
            <GitBranch className="size-3.5" /> Branch from here
          </Button>
        )}
      </div>
    </article>
  )
}

export function ToolCallRow({
  item,
}: {
  item: Extract<ChatRenderItem, { kind: 'tool' }>
}) {
  const [open, setOpen] = useState(false)
  const summary = summarizeToolCall(item.name, item.input)
  return (
    <article className="chat-tool">
      <WorkEntryRow
        icon={toolIcon(item.name, item.input)}
        heading={summary.title}
        preview={summary.detail}
        state={item.state}
        expanded={open}
        detailId={`tool-detail-${item.id}`}
        onToggle={() => setOpen(!open)}
      >
        <pre className="max-h-64 overflow-auto break-words whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-muted-foreground">
          {JSON.stringify(item.input, null, 2)}
        </pre>
        {item.output !== undefined && (
          <pre className="mt-2 max-h-64 overflow-auto break-words whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-muted-foreground">
            {JSON.stringify(item.output, null, 2)}
          </pre>
        )}
      </WorkEntryRow>
    </article>
  )
}

/**
 * One line of agent work: an icon, a heading, a truncated preview, and a
 * status chip. Expanding reveals the raw detail under a hanging rule.
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
  children: React.ReactNode
}) {
  const toggle = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    onToggle()
  }
  return (
    <div
      className="flex cursor-pointer flex-col rounded-md px-0.5 py-0.5 transition-colors hover:bg-accent/20 focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-inset focus-visible:outline-none"
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      aria-controls={detailId}
      onClick={onToggle}
      onKeyDown={toggle}
    >
      <div className="flex items-center gap-1.5 select-none">
        <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground/65">
          <Icon
            className="block size-3.5 shrink-0 stroke-[1.8] opacity-80"
            aria-hidden
          />
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <p className="flex w-full min-w-0 items-baseline gap-1.5 text-[12px] leading-5">
            <span className="min-w-0 shrink truncate font-medium text-foreground/82">
              {heading}
            </span>
            {preview && (
              <span className="min-w-0 flex-1 truncate text-muted-foreground/55">
                {preview}
              </span>
            )}
          </p>
          <div className="flex shrink-0 items-center gap-px text-muted-foreground/55">
            <span className="flex size-4 shrink-0 items-center justify-center">
              <ChevronDown
                className={cn(
                  'size-3 shrink-0 opacity-70 transition-transform duration-200',
                  expanded && 'rotate-180',
                )}
                aria-hidden
              />
            </span>
            <span className="flex size-4 shrink-0 items-center justify-center">
              <StatusChip state={state} />
            </span>
          </div>
        </div>
      </div>
      {expanded && (
        <div
          id={detailId}
          className="mt-1 ms-7 cursor-default border-s border-border/45 ps-3 pt-0.5"
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
  if (state === 'error')
    return (
      <Tooltip>
        <TooltipTrigger
          render={<span className="flex size-4 items-center justify-center" />}
        >
          <X className="block size-3 shrink-0 text-destructive" aria-hidden />
          <span className="sr-only">Failed</span>
        </TooltipTrigger>
        <TooltipPopup>Failed</TooltipPopup>
      </Tooltip>
    )
  if (state === 'done')
    return (
      <Tooltip>
        <TooltipTrigger
          render={<span className="flex size-4 items-center justify-center" />}
        >
          <Check className="block size-3 shrink-0" aria-hidden />
          <span className="sr-only">Completed</span>
        </TooltipTrigger>
        <TooltipPopup>Completed</TooltipPopup>
      </Tooltip>
    )
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="flex size-4 items-center justify-center" />}
      >
        <Minus className="block size-3 shrink-0 opacity-70" aria-hidden />
        <span className="sr-only">Empty</span>
      </TooltipTrigger>
      <TooltipPopup>Empty</TooltipPopup>
    </Tooltip>
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

const READ_TOOL = /read|view|grep|glob|search|list|ls/i
const WRITE_TOOL = /write|edit|patch|update|create|notebook/i
const WEB_TOOL = /web|fetch|http|url|browser|search/i
const AGENT_TOOL = /task|agent|spawn/i
const BUILD_TOOL = /build|compile|make|install|deploy/i

function toolIcon(
  name: string,
  input: unknown,
): ComponentType<SVGProps<SVGSVGElement>> {
  const clean = name.replace(/`/g, '').trim()
  if (
    input &&
    typeof input === 'object' &&
    !Array.isArray(input) &&
    ('command' in input || 'cmd' in input)
  )
    return Terminal
  if (AGENT_TOOL.test(clean)) return Bot
  if (WEB_TOOL.test(clean)) return Globe
  if (WRITE_TOOL.test(clean)) return SquarePen
  if (READ_TOOL.test(clean)) return Eye
  if (BUILD_TOOL.test(clean)) return Hammer
  return Wrench
}
