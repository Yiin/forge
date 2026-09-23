import { Bot, ChevronDown, ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'
import './tool-group.css'

/**
 * zeron's subagent chip: a 30px quiet card with a bot tile, the `Agent`
 * label, the task description, and a trailing tile. Forge child sessions and
 * native child tools share it; each supplies its own body and actions.
 */
export function AgentCard({
  className,
  detail,
  model,
  meta,
  hint,
  running,
  failed,
  expanded,
  bodyId,
  onToggle,
  action,
  children,
  ...data
}: {
  className?: string
  detail: string
  model?: string | null
  /** Faint trailing text, such as elapsed time or a tool count. */
  meta?: string
  /** Tooltip on the toggle, such as the agent's last reply. */
  hint?: string
  running?: boolean
  failed?: boolean
  expanded: boolean
  bodyId: string
  onToggle: () => void
  /** A trailing tile button beside the toggle, such as opening a dock tab. */
  action?: ReactNode
  children?: ReactNode
  [key: `data-${string}`]: string | undefined
}) {
  const Chevron = expanded ? ChevronDown : ChevronRight
  return (
    <div className="py-1">
      <article
        className={cn(
          'overflow-hidden rounded-[9px] border border-ink/9 bg-ink/3 text-xs leading-[18px] dark:border-ink/7',
          className,
        )}
        {...data}
      >
        <div className="flex h-7 items-center pe-2 transition-colors hover:bg-ink/2">
          <button
            type="button"
            className="tool-press group/agent flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 ps-2 text-left focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:outline-none focus-visible:ring-inset"
            aria-expanded={expanded}
            aria-controls={bodyId}
            title={hint || undefined}
            onClick={onToggle}
          >
            <span className="flex size-[18px] shrink-0 items-center justify-center rounded-[5px] bg-ink/8 text-muted-foreground">
              <Bot className="size-3" aria-hidden />
            </span>
            <span
              className={cn(
                'shrink-0 font-medium',
                failed ? 'text-destructive' : 'text-muted-foreground',
              )}
            >
              Agent
            </span>{' '}
            <span
              className={cn(
                'min-w-0 flex-1 truncate',
                failed ? 'text-destructive' : 'text-foreground/85',
              )}
            >
              {detail}
            </span>
            {model && (
              <span className="shrink-0 text-[11px] text-faint-foreground">
                {model}
              </span>
            )}
            {meta && (
              <span className="shrink-0 text-[11px] text-faint-foreground tabular-nums">
                {meta}
              </span>
            )}
            {running && (
              <>
                {' '}
                <span className="sr-only">Running</span>
                <GlyphSpinner />
              </>
            )}
            {failed && (
              <>
                {' '}
                <span className="sr-only">Failed</span>
              </>
            )}
            <span className="flex size-[18px] shrink-0 items-center justify-center rounded-[5px] bg-ink/6 text-muted-foreground/80">
              <Chevron className="size-3" aria-hidden />
            </span>
          </button>
          {action}
        </div>
        {expanded && (
          <div id={bodyId} className="border-t border-ink/6">
            {children}
          </div>
        )}
      </article>
    </div>
  )
}

/** A trailing 18px tile button for a card action. */
export function AgentCardAction({
  label,
  icon,
  onClick,
}: {
  label: string
  icon: ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="tool-press ms-1.5 flex size-[18px] shrink-0 cursor-pointer items-center justify-center rounded-[5px] bg-ink/6 text-muted-foreground/80 transition-colors hover:bg-ink/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:outline-none"
      onClick={onClick}
    >
      {icon}
    </button>
  )
}

/** zeron's 2x3 dot chase, tinted with the accent. */
export function GlyphSpinner() {
  const ring = [
    [0, 1],
    [5, 2],
    [4, 3],
  ]
  const tints = [
    'bg-[color-mix(in_oklab,var(--primary)_70%,white)]',
    'bg-primary',
    'bg-[color-mix(in_oklab,var(--primary)_80%,black)]',
  ]
  return (
    <span
      className="glyph-spinner grid shrink-0 grid-cols-2 gap-[2px]"
      aria-hidden
    >
      {ring.flatMap((row, rowIndex) =>
        row.map((step, column) => (
          <span
            key={`${rowIndex}-${column}`}
            className={cn('size-[2px] rounded-full', tints[rowIndex])}
            style={{ ['--offset' as string]: step / 6 }}
          />
        )),
      )}
    </span>
  )
}
