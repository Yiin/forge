import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  LoaderCircle,
} from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { ChatMarkdown } from './ChatMarkdown'
import type { ChatRenderItem } from './render-model'
import { SkillChipText } from './SkillChipText'
import { api } from '../../lib/api'

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
        <button className="chat-collapse" onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}{' '}
          Thought
        </button>
        {open && <ChatMarkdown text={item.text} />}
      </article>
    )
  return (
    <article className={`chat-row chat-${item.role}`} data-seq={item.seq}>
      <div className="chat-row-actions">
        <span>{item.role === 'user' ? 'You' : 'Forge'}</span>
        <button
          className="chat-icon-button"
          aria-label="Copy message"
          onClick={copy}
        >
          <Copy size={14} />
        </button>
        {sessionId &&
          (item.role === 'user' ? (
            <button
              className="chat-text-action"
              onClick={() => void fork(false)}
            >
              Edit
            </button>
          ) : (
            <button
              className="chat-text-action"
              onClick={() => void fork(true)}
            >
              Branch from here
            </button>
          ))}
      </div>
      {item.role === 'user' ? (
        <p>
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
  return (
    <article className={`chat-tool chat-tool-${item.state}`}>
      <button className="chat-tool-summary" onClick={() => setOpen(!open)}>
        <Status
          size={15}
          className={item.state === 'running' ? 'spin' : undefined}
        />
        <strong>{item.name}</strong>
        <span>{item.state}</span>
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
      </button>
      {open && (
        <div className="chat-tool-detail">
          <pre>{JSON.stringify(item.input, null, 2)}</pre>
          {item.output !== undefined && (
            <pre>{JSON.stringify(item.output, null, 2)}</pre>
          )}
        </div>
      )}
    </article>
  )
}
