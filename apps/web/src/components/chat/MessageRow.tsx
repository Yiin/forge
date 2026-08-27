import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  GitBranch,
  LoaderCircle,
  Pencil,
} from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { ChatMarkdown } from './ChatMarkdown'
import type { ChatRenderItem } from './render-model'
import { SkillChipText } from './SkillChipText'
import { api } from '../../lib/api'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'

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
      <article
        className="chat-row chat-thought mx-auto mb-3 max-w-[760px] border-l-2 border-border pl-3 text-muted-foreground"
        data-seq={item.seq}
      >
        <button
          className="inline-flex items-center gap-1.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          type="button"
          aria-expanded={open}
          aria-controls={`thought-${item.id}`}
          onClick={() => setOpen(!open)}
        >
          {open ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronRight className="size-3.5" />
          )}
          Thought
        </button>
        {open && (
          <div id={`thought-${item.id}`} className="mt-1 pl-5">
            <ChatMarkdown text={item.text} />
          </div>
        )}
      </article>
    )
  return (
    <article
      className={cn(
        'chat-row group/row mx-auto mb-3 flex max-w-[760px] flex-col',
        `chat-${item.role}`,
        item.role === 'user' && 'items-end',
      )}
      data-seq={item.seq}
    >
      <div
        className={cn(
          'mb-1 flex w-full items-center gap-1 text-xs text-muted-foreground',
          item.role === 'user' && 'justify-end',
        )}
      >
        {item.role === 'agent' && (
          <span className="mr-auto font-medium">Forge</span>
        )}
        <span
          className={cn(
            'flex items-center gap-1',
            'opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 group-focus-within/row:opacity-100',
          )}
        >
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Copy message"
            onClick={() => void copy()}
          >
            <Copy className="size-3.5" />
          </Button>
          {sessionId &&
            (item.role === 'user' ? (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => void fork(false)}
              >
                <Pencil className="size-3.5" /> Edit
              </Button>
            ) : (
              <Button variant="ghost" size="xs" onClick={() => void fork(true)}>
                <GitBranch className="size-3.5" /> Branch from here
              </Button>
            ))}
        </span>
        {item.role === 'user' && <span className="font-medium">You</span>}
      </div>
      {item.role === 'user' ? (
        <p className="max-w-[78%] rounded-2xl rounded-tr-md bg-muted px-4 py-2.5 text-sm text-foreground">
          <SkillChipText text={item.text} skills={[]} />
        </p>
      ) : (
        <ChatMarkdown text={item.text} />
      )}
    </article>
  )
}

export function ToolCallRow({
  item,
}: {
  item: Extract<ChatRenderItem, { kind: 'tool' }>
}) {
  const [open, setOpen] = useState(false)
  const Status =
    item.state === 'running'
      ? LoaderCircle
      : item.state === 'done'
        ? Check
        : CircleAlert
  const statusColor =
    item.state === 'done'
      ? 'text-primary'
      : item.state === 'error'
        ? 'text-destructive'
        : 'text-muted-foreground'
  return (
    <article
      className={cn(
        'chat-tool mx-auto mb-3 max-w-[760px] overflow-hidden rounded-lg border bg-card',
        item.state === 'running' ? 'border-primary/40' : 'border-border',
      )}
    >
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs"
        type="button"
        aria-expanded={open}
        aria-controls={`tool-detail-${item.id}`}
        onClick={() => setOpen(!open)}
      >
        <Status
          className={cn(
            'size-3.5 shrink-0',
            statusColor,
            item.state === 'running' && 'animate-spin',
          )}
        />
        <strong className="font-medium text-foreground">{item.name}</strong>
        <span className={cn('ml-auto', statusColor)}>{item.state}</span>
        {open ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        )}
      </button>
      {open && (
        <div
          id={`tool-detail-${item.id}`}
          className="space-y-2 border-t border-border px-3 py-2"
        >
          <pre className="overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">
            {JSON.stringify(item.input, null, 2)}
          </pre>
          {item.output !== undefined && (
            <pre className="overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">
              {JSON.stringify(item.output, null, 2)}
            </pre>
          )}
        </div>
      )}
    </article>
  )
}
