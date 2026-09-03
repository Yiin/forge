import { Pencil, X } from 'lucide-react'
import { Button } from '../ui/button'
import { cn } from '@/lib/utils'
import type { QueuedPrompt } from '@forge/protocol/session'

export function QueuedPrompts({
  items,
  onRemove,
  onEdit,
}: {
  items: QueuedPrompt[]
  onRemove: (id: string) => void
  onEdit: (item: QueuedPrompt) => void
}) {
  if (items.length === 0) return null
  return (
    <div className="flex flex-col gap-1 px-2 pt-2" aria-live="polite">
      {items.map((item) => (
        <div
          key={item.id}
          className="flex min-w-0 items-center gap-1 rounded-md border bg-muted/50 py-1 pl-2 text-xs"
        >
          <span className="min-w-0 flex-1 truncate" title={item.text}>
            {item.text}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn('size-11 shrink-0 sm:size-7')}
            onClick={() => onEdit(item)}
            aria-label="Edit queued message"
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11 shrink-0 sm:size-7"
            onClick={() => onRemove(item.id)}
            aria-label="Remove queued message"
          >
            <X className="size-3.5" />
          </Button>
        </div>
      ))}
    </div>
  )
}
