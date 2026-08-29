import { ChevronDown, Wrench } from 'lucide-react'
import { useState } from 'react'
import type { ChatRenderItem } from './render-model'
import { SubagentCard } from './SubagentCard'
import { RunningDots, ToolCallRow } from './MessageRow'
import { cn } from '../../lib/utils'

export function ActivityStack({
  item,
}: {
  item: Extract<ChatRenderItem, { kind: 'activity' }>
}) {
  const [open, setOpen] = useState(false)
  const count = item.tools.length + item.agents.length
  return (
    <article
      className="activity-stack rounded-2xl border border-input bg-background p-3 shadow-xs/5 not-dark:bg-clip-padding dark:bg-input/32"
      data-activity-state={item.state}
    >
      <div
        className="-m-1 flex cursor-pointer items-center gap-1.5 rounded-md p-1 transition-colors select-none hover:bg-accent/20 focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-inset focus-visible:outline-none"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          setOpen((value) => !value)
        }}
      >
        <span
          className={cn(
            'flex size-5 shrink-0 items-center justify-center',
            item.state === 'error'
              ? 'text-destructive'
              : 'text-muted-foreground/65',
          )}
        >
          <Wrench
            className="block size-3.5 shrink-0 stroke-[1.8] opacity-80"
            aria-hidden
          />
        </span>
        <p className="flex min-w-0 flex-1 items-baseline gap-1.5 text-[12px] leading-5">
          <span
            className={cn(
              'min-w-0 shrink truncate font-medium',
              item.state === 'error'
                ? 'text-destructive'
                : 'text-foreground/82',
            )}
          >
            Activity
          </span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground/55">
            {item.tools.length} tools · {item.agents.length} agents
          </span>
        </p>
        <div className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground/70 tabular-nums">
          {item.state === 'running' ? (
            <>
              <span className="sr-only">Running</span>
              <RunningDots />
            </>
          ) : (
            <span>{count} items</span>
          )}
          <ChevronDown
            className={cn(
              'size-3 shrink-0 opacity-70 transition-transform duration-200',
              open && 'rotate-180',
            )}
            aria-hidden
          />
        </div>
      </div>
      {open && (
        <div className="mt-2 space-y-2 border-t border-border/45 pt-2">
          {item.tools.map((tool) => (
            <ToolCallRow key={tool.id} item={tool} />
          ))}
          {item.agents.map((agent) => (
            <SubagentCard key={agent.id} child={agent} />
          ))}
        </div>
      )}
    </article>
  )
}
