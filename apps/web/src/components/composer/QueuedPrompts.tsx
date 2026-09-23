import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  ArrowDown,
  ArrowUp,
  GripVertical,
  Pencil,
  SendHorizontal,
  Trash2,
} from 'lucide-react'
import {
  Tooltip,
  TooltipPopup,
  TooltipProvider,
  TooltipTrigger,
} from '../ui/tooltip'
import { cn } from '@/lib/utils'
import type { QueuedPrompt } from '@forge/protocol/session'
import { EDGE_FADE_CLASS, useEdgeFade } from './useEdgeFade'

const DRAG_TYPE = 'application/x-forge-queued-prompt'

const ICON_BUTTON_CLASS =
  'grid size-7 shrink-0 cursor-pointer place-items-center rounded-[5px] text-muted-foreground/80 opacity-72 outline-none transition-[background-color,color,opacity] duration-150 hover:bg-ink/7 hover:text-foreground hover:opacity-100 focus-visible:bg-primary/18 focus-visible:text-primary focus-visible:opacity-100 disabled:pointer-events-none disabled:opacity-45 pointer-coarse:size-9'

const TIP_CLASS = 'px-2 py-[5px] text-[10.5px] text-muted-foreground'

function QueueButton({
  label,
  tip,
  onClick,
  disabled,
  children,
}: {
  label: string
  tip: string
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
            className={ICON_BUTTON_CLASS}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup className={TIP_CLASS}>{tip}</TooltipPopup>
    </Tooltip>
  )
}

/** Summary line for a queued prompt's attachments, or null. */
function attachmentLine(item: QueuedPrompt) {
  const count = item.attachmentIds?.length ?? 0
  if (count === 0) return null
  return count === 1 ? '1 attachment' : `${count} attachments`
}

/**
 * zeron's queue tray: rows tucked behind the top of the composer pill. Rows
 * reorder by drag, or with the up and down buttons on touch and keyboard.
 */
export function QueuedPrompts({
  items,
  onRemove,
  onEdit,
  onMove = () => undefined,
  onSendNow = () => undefined,
}: {
  items: QueuedPrompt[]
  onRemove: (id: string) => void
  onEdit: (item: QueuedPrompt) => void
  /** Moves a row to the given index. */
  onMove?: (id: string, index: number) => void
  onSendNow?: (id: string) => void
}) {
  const list = useEdgeFade<HTMLDivElement>(24)
  const [dragging, setDragging] = useState<string | null>(null)
  const [target, setTarget] = useState<number | null>(null)
  if (items.length === 0) return null
  const finishDrag = (index: number | null) => {
    if (dragging !== null && index !== null) {
      const from = items.findIndex((item) => item.id === dragging)
      if (from >= 0 && from !== index) onMove(dragging, index)
    }
    setDragging(null)
    setTarget(null)
  }
  return (
    <TooltipProvider delay={350}>
      <div className="chat-queue-tray @container relative z-0 mx-4 -mb-[26px] rounded-t-[16px] border border-b-0 border-border bg-frost pb-[18px] backdrop-blur-[16px] duration-150 animate-in fade-in-0 motion-reduce:animate-none">
        <div
          ref={list}
          role="list"
          aria-label="Queued messages"
          aria-live="polite"
          className={cn('max-h-[30vh] overflow-y-auto px-1', EDGE_FADE_CLASS)}
        >
          {items.map((item, index) => {
            const line = attachmentLine(item)
            const text = item.text.replace(/\s+/g, ' ').trim()
            return (
              <div
                key={item.id}
                role="listitem"
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData(DRAG_TYPE, item.id)
                  event.dataTransfer.effectAllowed = 'move'
                  setDragging(item.id)
                }}
                onDragEnd={() => finishDrag(null)}
                onDragOver={(event) => {
                  if (!event.dataTransfer.types.includes(DRAG_TYPE)) return
                  event.preventDefault()
                  event.stopPropagation()
                  setTarget(index)
                }}
                onDrop={(event) => {
                  if (!event.dataTransfer.types.includes(DRAG_TYPE)) return
                  event.preventDefault()
                  event.stopPropagation()
                  finishDrag(index)
                }}
                className={cn(
                  'relative flex h-9 min-w-0 items-center gap-2 rounded-[8px] px-2 transition-[background-color,opacity] duration-150 hover:bg-ink/4 @max-[520px]:gap-1 pointer-coarse:h-11',
                  dragging === item.id && 'opacity-55',
                  target === index &&
                    dragging !== item.id &&
                    'bg-ink/6 inset-ring-1 inset-ring-ink/10',
                )}
              >
                <span
                  aria-hidden
                  className="grid h-[22px] w-3.5 shrink-0 cursor-grab place-items-center rounded-[4px] text-muted-foreground/50 active:cursor-grabbing"
                >
                  <GripVertical className="size-[13px]" />
                </span>
                <span
                  title={item.text}
                  className="flex min-w-0 flex-1 flex-col gap-px"
                >
                  <span className="truncate text-[12.5px] leading-4 text-foreground/90">
                    {text || line || 'Queued message'}
                  </span>
                  {text && line && (
                    <span className="truncate text-[11px] leading-[13px] text-muted-foreground">
                      {line}
                    </span>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-[3px]">
                  <QueueButton
                    label="Move queued message up"
                    tip="Move up"
                    disabled={index === 0}
                    onClick={() => onMove(item.id, index - 1)}
                  >
                    <ArrowUp className="size-[13px]" />
                  </QueueButton>
                  <QueueButton
                    label="Move queued message down"
                    tip="Move down"
                    disabled={index === items.length - 1}
                    onClick={() => onMove(item.id, index + 1)}
                  >
                    <ArrowDown className="size-[13px]" />
                  </QueueButton>
                  <QueueButton
                    label="Remove queued message"
                    tip="Remove"
                    onClick={() => onRemove(item.id)}
                  >
                    <Trash2 className="size-[13px]" />
                  </QueueButton>
                  <QueueButton
                    label="Edit queued message"
                    tip="Edit"
                    onClick={() => onEdit(item)}
                  >
                    <Pencil className="size-[13px]" />
                  </QueueButton>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          aria-label="Send queued message now"
                          onClick={() => onSendNow(item.id)}
                          className="inline-flex h-7 w-[72px] shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-[11.5px] text-muted-foreground outline-none transition-colors duration-150 hover:bg-ink/7 hover:text-foreground focus-visible:bg-primary/18 focus-visible:text-primary @max-[520px]:w-7 pointer-coarse:h-9 pointer-coarse:@max-[520px]:w-9"
                        />
                      }
                    >
                      <span className="@max-[520px]:hidden">Send now</span>
                      <SendHorizontal
                        aria-hidden
                        className="hidden size-[13px] @max-[520px]:block"
                      />
                    </TooltipTrigger>
                    <TooltipPopup className={TIP_CLASS}>
                      Send now (interrupt)
                    </TooltipPopup>
                  </Tooltip>
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </TooltipProvider>
  )
}
