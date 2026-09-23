import { useMemo } from 'react'
import { Virtualizer } from 'virtua'
import type { Message } from '@forge/protocol/message'
import { MessageRow } from './MessageRow'
import { toRenderModel } from './render-model'
import type { ChatRenderItem } from './render-model'
import { AgentToolCard, ToolGroup } from './ToolGroup'
import { AttachmentItem } from './TranscriptItems'
import { NativeContentRow } from './NativeContentRow'

export function SubagentTranscript({
  messages,
  messagesVersion,
  skills = [],
  nativeChildId,
  sessionId,
}: {
  messages: Message[]
  messagesVersion: number
  skills?: string[]
  nativeChildId?: string
  sessionId?: string
}) {
  const items = useMemo(
    () => toRenderModel(messages, false, [], [], nativeChildId),
    [messages, messagesVersion, nativeChildId],
  )
  return (
    <div
      className="subagent-transcript h-[min(60vh,460px)] overflow-auto border-t border-border p-3 [&_.chat-row]:max-w-none [&_.chat-tool]:max-w-none [&_.subagent-card]:max-w-none [&_.tool-group]:max-w-none"
      aria-label="Subagent transcript"
    >
      <Virtualizer<ChatRenderItem> data={items}>
        {(item: ChatRenderItem) => {
          if (item.kind === 'message')
            return <MessageRow key={item.id} item={item} skills={skills} />
          if (item.kind === 'plan')
            return (
              <section
                aria-label="Plan"
                className="whitespace-pre-wrap text-sm"
              >
                {item.explanation}
              </section>
            )
          if (item.kind === 'native')
            return (
              <NativeContentRow
                key={item.id}
                item={item}
                sessionId={sessionId}
              />
            )
          if (item.kind === 'tool')
            return (
              <AgentToolCard key={item.id} tool={item} sessionId={sessionId} />
            )
          if (item.kind === 'tool-group')
            return <ToolGroup key={item.id} item={item} sessionId={sessionId} />
          if (item.kind === 'attachment')
            return <AttachmentItem key={item.id} item={item} />
          if (item.kind === 'answered-question')
            return (
              <div
                key={item.id}
                className="py-2 text-center text-xs text-muted-foreground"
              >
                Answered: {String(item.answer)}
              </div>
            )
          if (item.kind === 'epic-triage')
            return (
              <div
                key={item.id}
                className="py-2 text-center text-xs text-muted-foreground"
              >
                Epic triage: {item.card.classification}
              </div>
            )
          if (item.kind === 'system')
            return (
              <div
                key={item.id}
                className="py-2 text-center text-xs text-muted-foreground"
              >
                {item.text}
              </div>
            )
          return <div key={item.id} />
        }}
      </Virtualizer>
    </div>
  )
}
