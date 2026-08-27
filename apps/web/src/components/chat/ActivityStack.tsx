import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  LoaderCircle,
} from 'lucide-react'
import { useState } from 'react'
import type { ChatRenderItem } from './render-model'
import { SubagentCard } from './SubagentCard'
import { ToolCallRow } from './MessageRow'
import { cn } from '../../lib/utils'

export function ActivityStack({
  item,
}: {
  item: Extract<ChatRenderItem, { kind: 'activity' }>
}) {
  const [open, setOpen] = useState(false)
  const Icon =
    item.state === 'running'
      ? LoaderCircle
      : item.state === 'error'
        ? CircleAlert
        : item.state === 'done'
          ? Check
          : CircleAlert
  const statusColor =
    item.state === 'done'
      ? 'text-primary'
      : item.state === 'error'
        ? 'text-destructive'
        : 'text-muted-foreground'
  const count = item.tools.length + item.agents.length
  return (
    <article
      className={cn(
        'activity-stack mx-auto mb-3 max-w-[760px] overflow-hidden rounded-lg border bg-card',
        item.state === 'running' ? 'border-primary/40' : 'border-border',
      )}
    >
      <button
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-xs"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon
          className={cn(
            'size-4 shrink-0',
            statusColor,
            item.state === 'running' && 'animate-spin',
          )}
        />
        <strong className="font-medium text-foreground">Activity</strong>
        <span className="text-muted-foreground">
          {item.tools.length} tools · {item.agents.length} agents · {item.state}
        </span>
        <span className="ml-auto text-muted-foreground">{count} items</span>
        {open ? (
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        )}
      </button>
      {open && (
        <div className="space-y-2 border-t border-border p-3">
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
