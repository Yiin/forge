import {
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  File,
  FileCode,
  FileImage,
  FileJson,
  FilePlus,
  FileText,
  FolderSearch,
  Globe,
  LayoutGrid,
  ListChecks,
  MessageCircle,
  PenLine,
  Search,
  SquareTerminal,
} from 'lucide-react'
import type { ComponentType, ReactNode, SVGProps } from 'react'
import { useId, useRef, useState } from 'react'
import { AgentCard, AgentCardAction } from './AgentCard'
import { usePinnedDisclosure, useFoldMount } from './disclosure'
import type { ChatRenderItem, MessageItem, ToolItem } from './render-model'
import { capThoughtLines, thoughtLines } from './thought-lines'
import type { FileDiff } from './tool-diff'
import {
  basename,
  capLines,
  describeTool,
  DETAIL_MAX_LINES,
  summarizeToolGroup,
  toolResult,
  type ToolKind,
} from './tool-view'
import { cn } from '../../lib/utils'
import { useShellStore } from '../../stores/shell'
import './tool-group.css'

type Icon = ComponentType<SVGProps<SVGSVGElement>>

const KIND_ICONS: Record<ToolKind, Icon> = {
  exec: SquareTerminal,
  read: FileText,
  write: FilePlus,
  edit: PenLine,
  patch: FileText,
  search: Search,
  glob: FolderSearch,
  fetch: Globe,
  websearch: Globe,
  todo: ListChecks,
  mcp: LayoutGrid,
  agent: LayoutGrid,
  other: LayoutGrid,
}

/** The fetched-in-full view shows this many lines before its own tail row. */
const FULL_OUTPUT_MAX_LINES = 400

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`

/**
 * One run of tool work: a 26px summary line with a chevron, folding over a
 * tree of tool and thought rows. Open by default only while it is the live
 * tail of a streaming turn; a click pins the reader's choice.
 */
export function ToolGroup({
  item,
  sessionId,
  live = false,
}: {
  item: Extract<ChatRenderItem, { kind: 'tool-group' }>
  sessionId?: string
  live?: boolean
}) {
  const [pin, setPin] = usePinnedDisclosure(item.id)
  const open = pin ?? live
  const fold = useFoldMount(open)
  const bodyId = useId()
  // Rows present at mount are history; only later arrivals animate in.
  const seen = useRef<Set<string> | null>(null)
  seen.current ??= new Set(item.entries.map((entry) => entry.id))
  const summary = summarizeToolGroup(item.entries)
  return (
    <section className="tool-group font-sans text-xs leading-[18px]">
      <button
        type="button"
        className="tool-press flex h-[26px] w-full cursor-pointer items-center gap-1.5 pe-1 text-left text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:outline-none pointer-coarse:h-11"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setPin(!open)}
      >
        <span className="relative h-[18px] w-[22px] flex-none" aria-hidden>
          <ChevronDown
            className="absolute top-[2px] left-[5.5px] size-3.5 text-muted-foreground transition-transform duration-[140ms] ease-[cubic-bezier(0,0,0.58,1)]"
            style={{ transform: `rotate(${open ? 0 : -90}deg)` }}
          />
        </span>
        <span
          className={cn('h-[18px] min-w-0 truncate', live && 'tool-shimmer')}
        >
          {summary}
        </span>
      </button>
      {fold.mounted && (
        <div className="tool-fold" data-open={fold.expanded}>
          <div>
            <div id={bodyId} className="pt-0.5">
              {item.entries.map((entry, index) => {
                const last = index === item.entries.length - 1
                const enter = live && !seen.current!.has(entry.id)
                return entry.kind === 'message' ? (
                  <ThoughtRow
                    key={entry.id}
                    item={entry}
                    last={last}
                    enter={enter}
                    live={live && last}
                  />
                ) : (
                  <ToolRow
                    key={entry.id}
                    tool={entry}
                    sessionId={sessionId}
                    last={last}
                    enter={enter}
                  />
                )
              })}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

/**
 * The tree rail beside one row: a trunk at x=12.5, a 6px elbow to x=28 at
 * the row middle, and a trunk onward unless this is the last row. The elbow
 * and the trunk beside it are one path, so the joint does not paint twice.
 */
function Rail({ last }: { last: boolean }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-y-0 left-0 w-12 text-ink/16 dark:text-ink/12"
    >
      <span className="absolute top-0 left-3 h-[calc(var(--tool-row-mid)-6px)] w-px bg-current" />
      <svg
        className="absolute left-0 top-[calc(var(--tool-row-mid)-6px)]"
        width="28"
        height="12"
        fill="none"
      >
        <path
          d={`M12.5 0Q12.5 6.5 18.5 6.5H28${last ? '' : 'M12.5 0V12'}`}
          stroke="currentColor"
        />
      </svg>
      {!last && (
        <span className="absolute top-[calc(var(--tool-row-mid)+6px)] bottom-0 left-3 w-px bg-current" />
      )}
    </span>
  )
}

/** Shared row frame: rail, rail icon, a 32px disclosure button, a fold. */
function TreeRow({
  id,
  icon: RowIcon,
  failed,
  last,
  enter,
  defaultOpen = false,
  header,
  children,
}: {
  id: string
  icon: Icon
  failed?: boolean
  last: boolean
  enter: boolean
  defaultOpen?: boolean
  header: ReactNode
  children: () => ReactNode
}) {
  const [pin, setPin] = usePinnedDisclosure(id)
  const open = pin ?? defaultOpen
  const fold = useFoldMount(open)
  const bodyId = useId()
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <div
      className={cn(
        'relative [--tool-row-mid:16px] pointer-coarse:[--tool-row-mid:22px]',
        enter && 'tool-row-enter',
      )}
    >
      <Rail last={last} />
      <RowIcon
        aria-hidden
        className={cn(
          'pointer-events-none absolute top-[calc(var(--tool-row-mid)-8px)] left-8 size-4 stroke-[1.5]',
          failed ? 'text-destructive' : 'text-muted-foreground',
        )}
      />
      <button
        type="button"
        className="tool-press group/row flex h-8 w-full cursor-pointer items-center gap-2 ps-14 pe-1 text-left focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:outline-none focus-visible:ring-inset pointer-coarse:h-11"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setPin(!open)}
      >
        {header}
        {failed && (
          <>
            {' '}
            <span className="sr-only">Failed</span>
          </>
        )}
        <span
          className={cn(
            'ms-auto flex size-[18px] shrink-0 items-center justify-center opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-visible/row:opacity-100',
            open && 'opacity-100',
          )}
          aria-hidden
        >
          <Chevron
            className={cn(
              'size-3 text-faint-foreground',
              failed
                ? 'group-hover/row:text-destructive'
                : 'group-hover/row:text-foreground',
            )}
          />
        </span>
      </button>
      {fold.mounted && (
        <div className="tool-fold" data-open={fold.expanded}>
          <div>
            <div id={bodyId} className="flex flex-col gap-px ps-14 pe-1 pb-1">
              {children()}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** Label and detail tone: muted, brighter on hover, red when failed. */
function tone(failed?: boolean) {
  return failed
    ? 'text-destructive'
    : 'text-muted-foreground transition-colors group-hover/row:text-foreground'
}

export function ToolRow({
  tool,
  sessionId,
  last = true,
  enter = false,
}: {
  tool: ToolItem
  sessionId?: string
  last?: boolean
  enter?: boolean
}) {
  const view = describeTool(tool)
  return (
    <TreeRow
      id={tool.id}
      icon={KIND_ICONS[view.kind]}
      failed={view.failed}
      last={last}
      enter={enter}
      header={
        <>
          <span className={cn('shrink-0', tone(view.failed))}>
            {view.label}
          </span>{' '}
          {view.path ? (
            <span className="flex min-w-0 flex-1">
              <FileBadge path={view.path} failed={view.failed} />
            </span>
          ) : (
            view.detail && (
              <span
                className={cn('min-w-0 flex-1 truncate', tone(view.failed))}
              >
                {view.detail}
              </span>
            )
          )}
        </>
      }
    >
      {() => <ToolDetail tool={tool} sessionId={sessionId} />}
    </TreeRow>
  )
}

function ToolDetail({
  tool,
  sessionId,
}: {
  tool: ToolItem
  sessionId?: string
}) {
  const view = describeTool(tool)
  const result = toolResult(tool, view)
  const path = view.path
  return (
    <>
      <OutputLines lines={view.call} hidden={view.callHidden} />
      {result.diffs.map((diff, index) => (
        <DiffBlock key={index} diff={diff} showPath={result.diffs.length > 1} />
      ))}
      {result.output !== undefined && result.output.trim() !== '' && (
        <ResultOutput text={result.output} />
      )}
      {path && sessionId && (
        <DetailLink
          onClick={() =>
            useShellStore.getState().openDockTab(sessionId, {
              id: `file-${sessionId}-${path}`,
              kind: 'file',
              title: basename(path) || 'File',
              path,
            })
          }
        >
          Open {path}
        </DetailLink>
      )}
    </>
  )
}

function ResultOutput({ text }: { text: string }) {
  const [full, setFull] = useState(false)
  const capped = capLines(text, full ? FULL_OUTPUT_MAX_LINES : DETAIL_MAX_LINES)
  return (
    <>
      <OutputLines lines={capped.lines} hidden={capped.hidden} />
      {!full && capped.hidden > 0 && (
        <DetailLink onClick={() => setFull(true)}>
          Show full output ({formatSize(new TextEncoder().encode(text).length)})
        </DetailLink>
      )}
    </>
  )
}

function formatSize(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : `${Math.ceil(bytes / 1024)} KB`
}

/** Mono, one fixed 18px line each, clipped rather than wrapped. */
function OutputLines({ lines, hidden }: { lines: string[]; hidden: number }) {
  if (!lines.length) return null
  return (
    <div className="py-1.5 font-mono text-xs leading-[18px] text-faint-foreground">
      {lines.map((line, index) => (
        <div key={index} className="h-[18px] truncate whitespace-pre">
          {line || ' '}
        </div>
      ))}
      {hidden > 0 && (
        <div className="h-[18px] font-sans">
          … {plural(hidden, 'more line', 'more lines')}
        </div>
      )}
    </div>
  )
}

function DetailLink({
  onClick,
  children,
}: {
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className="tool-press flex h-6 w-fit max-w-full cursor-pointer items-center truncate text-left text-faint-foreground transition-colors hover:text-muted-foreground focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:outline-none"
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function gutterWidth(diff: FileDiff) {
  let max = 0
  for (const row of diff.rows)
    if (row.type !== 'hunk')
      max = Math.max(max, row.oldLine ?? 0, row.newLine ?? 0)
  return Math.max(36, String(max).length * 6.6 + 14)
}

/** zeron's unified inline diff: accent bar, gutters, marker, clipped code. */
function DiffBlock({ diff, showPath }: { diff: FileDiff; showPath: boolean }) {
  const gutter = diff.numbered ? gutterWidth(diff) : 0
  const notices = [
    ...(showPath && diff.path ? [diff.path] : []),
    ...diff.notices,
    ...(diff.truncatedFrom
      ? [
          `Diff truncated, showing first ${diff.rows.length} of ${diff.truncatedFrom} lines`,
        ]
      : []),
  ]
  return (
    <div className="overflow-hidden pb-2 font-mono text-xs">
      {notices.map((notice) => (
        <div
          key={notice}
          className="flex h-6 items-center truncate px-4 font-sans text-[11px] text-faint-foreground"
        >
          {notice}
        </div>
      ))}
      {diff.rows.map((row, index) =>
        row.type === 'hunk' ? (
          <div
            key={index}
            className="flex h-7 items-center truncate bg-primary/8 px-4 text-[11px] text-faint-foreground"
          >
            {row.text}
          </div>
        ) : (
          <div
            key={index}
            className={cn(
              'flex h-[21px] items-center',
              row.type === 'add' && 'bg-success/[0.055]',
              row.type === 'del' && 'bg-destructive/[0.055]',
            )}
          >
            <span
              className={cn(
                'h-full w-[3px] shrink-0',
                row.type === 'add' && 'bg-success/55',
                row.type === 'del' && 'bg-destructive/55',
              )}
            />
            {diff.numbered && (
              <>
                <LineNumber
                  width={gutter}
                  value={row.oldLine}
                  tone={row.type === 'del' ? 'del' : undefined}
                />
                <LineNumber
                  width={gutter}
                  value={row.type === 'del' ? undefined : row.newLine}
                  tone={row.type === 'add' ? 'add' : undefined}
                />
              </>
            )}
            <span
              className={cn(
                'w-7 shrink-0 text-center',
                row.type === 'add' && 'text-success',
                row.type === 'del' && 'text-destructive',
                row.type === 'ctx' && 'text-faint-foreground/50',
              )}
            >
              {row.type === 'add' ? '+' : row.type === 'del' ? '−' : '·'}
            </span>
            <span className="min-w-0 flex-1 truncate ps-3 whitespace-pre text-foreground/92">
              {row.text}
            </span>
          </div>
        ),
      )}
    </div>
  )
}

function LineNumber({
  width,
  value,
  tone,
}: {
  width: number
  value?: number
  tone?: 'add' | 'del'
}) {
  return (
    <span
      className={cn(
        'shrink-0 pe-2 text-right text-[11px] tabular-nums',
        tone === 'add'
          ? 'text-success/90'
          : tone === 'del'
            ? 'text-destructive/90'
            : 'text-faint-foreground/80',
      )}
      style={{ width }}
    >
      {value ?? ''}
    </span>
  )
}

const CODE_FILE =
  /\.(tsx?|jsx?|mjs|cjs|rs|py|go|rb|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|zsh|bash|css|scss|html|vue|svelte|sql|lua|zig)$/i
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg|avif|ico|bmp)$/i
const DATA_FILE = /\.(json|jsonc|ya?ml|toml|lock)$/i

function fileIcon(path: string): Icon {
  if (CODE_FILE.test(path)) return FileCode
  if (IMAGE_FILE.test(path)) return FileImage
  if (DATA_FILE.test(path)) return FileJson
  if (/\.(md|mdx|txt|rst)$/i.test(path)) return FileText
  return File
}

/** Basename pill; the full path lives in the expanded call block. */
function FileBadge({ path, failed }: { path: string; failed?: boolean }) {
  const FileIcon = fileIcon(path)
  return (
    <span
      className="flex h-[22px] min-w-0 items-center gap-1.5 rounded-[5px] bg-ink/6 ps-px pe-1.5 backdrop-blur-[16px]"
      title={path}
    >
      <span className="flex size-5 shrink-0 items-center justify-center rounded-[4px] bg-white dark:bg-black/16">
        <FileIcon
          aria-hidden
          className="size-3.5 stroke-[1.5] text-muted-foreground"
        />
      </span>
      <span
        className={cn(
          'min-w-0 truncate',
          failed
            ? 'text-destructive'
            : 'text-foreground/85 group-hover/row:text-foreground',
        )}
      >
        {basename(path)}
      </span>
    </span>
  )
}

/**
 * Thinking inside a group: always labelled "Thought process". A thought that
 * is still streaming at the tail opens and follows its newest lines.
 */
export function ThoughtRow({
  item,
  last = true,
  enter = false,
  live = false,
}: {
  item: MessageItem
  last?: boolean
  enter?: boolean
  live?: boolean
}) {
  return (
    <TreeRow
      id={item.id}
      icon={MessageCircle}
      last={last}
      enter={enter}
      defaultOpen={live}
      header={<span className={cn('shrink-0', tone())}>Thought process</span>}
    >
      {() => <ThoughtText text={item.text} live={live} />}
    </TreeRow>
  )
}

function ThoughtText({ text, live }: { text: string; live: boolean }) {
  const { lines, hidden } = capThoughtLines(thoughtLines(text), live)
  const more = hidden > 0 && (
    <div className="h-[18px]">
      … {plural(hidden, 'more line', 'more lines')}
    </div>
  )
  return (
    <div className="py-1.5 text-xs leading-[18px] text-faint-foreground">
      {live && more}
      {lines.map((line, index) => (
        <div key={index} className="h-[18px] truncate whitespace-pre">
          {line.length
            ? line.map((span, spanIndex) => (
                <span
                  key={spanIndex}
                  className={cn(
                    span.bold && 'font-semibold',
                    span.italic && 'italic',
                    span.code && 'font-mono',
                    span.strike && 'line-through decoration-1',
                    span.link && 'underline decoration-1 underline-offset-2',
                  )}
                >
                  {span.text}
                </span>
              ))
            : ' '}
        </div>
      ))}
      {!live && more}
    </div>
  )
}

function agentModel(input: unknown) {
  if (!input || typeof input !== 'object') return undefined
  const fields = input as Record<string, unknown>
  for (const key of ['model', 'modelId', 'model_id', 'subagent_model']) {
    const value = fields[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function dockTitle(detail: string) {
  const title = detail.replace(/^(Agent|Task)\s*[:·-]?\s*/i, '').trim()
  if (!title) return 'Subagent'
  return title.length > 40 ? `${title.slice(0, 40)}…` : title
}

/**
 * A subagent spawn as a standalone card. The card expands to the call and
 * its result; the trailing tile opens the child transcript in the dock.
 */
export function AgentToolCard({
  tool,
  sessionId,
}: {
  tool: ToolItem
  sessionId?: string
}) {
  const view = describeTool(tool)
  const [pin, setPin] = usePinnedDisclosure(tool.id)
  const expanded = pin ?? false
  const bodyId = useId()
  const childId = tool.nativeChildId
  return (
    <AgentCard
      className="chat-tool"
      detail={view.detail || 'Subagent'}
      model={agentModel(tool.input)}
      running={tool.state === 'running'}
      failed={view.failed}
      expanded={expanded}
      bodyId={bodyId}
      onToggle={() => setPin(!expanded)}
      action={
        childId && sessionId ? (
          <AgentCardAction
            label="Open child transcript"
            icon={<ArrowUpRight className="size-[11px]" aria-hidden />}
            onClick={() =>
              useShellStore.getState().openDockTab(sessionId, {
                id: `native-child-${sessionId}-${childId}`,
                kind: 'subagent',
                title: dockTitle(view.detail),
                nativeChildId: childId,
              })
            }
          />
        ) : undefined
      }
    >
      <div className="flex flex-col gap-px px-3 pb-1">
        <ToolDetail tool={tool} sessionId={sessionId} />
      </div>
    </AgentCard>
  )
}
