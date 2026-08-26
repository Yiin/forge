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
  const count = item.tools.length + item.agents.length
  return (
    <article className={`activity-stack activity-stack-${item.state}`}>
      <button
        className="activity-stack-summary"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon
          size={16}
          className={item.state === 'running' ? 'spin' : undefined}
        />
        <strong>Activity</strong>
        <span>
          {item.tools.length} tools · {item.agents.length} agents · {item.state}
        </span>
        <small>{count} items</small>
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </button>
      {open && (
        <div className="activity-stack-detail">
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
