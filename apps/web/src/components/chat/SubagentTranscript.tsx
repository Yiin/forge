import { useMemo } from 'react'
import { Virtualizer } from 'virtua'
import type { Message } from '@forge/protocol/message'
import { MessageRow, ToolCallRow } from './MessageRow'
import { toRenderModel } from './render-model'
import type { ChatRenderItem } from './render-model'
import { ActivityStack } from './ActivityStack'
import { AttachmentItem } from './TranscriptItems'

export function SubagentTranscript({
  messages,
  skills = [],
}: {
  messages: Message[]
  skills?: string[]
}) {
  const items = useMemo(() => toRenderModel(messages), [messages])
  return (
    <div
      className="subagent-transcript h-[min(60vh,460px)] overflow-auto border-t border-border p-3 [&_.chat-row]:max-w-none [&_.chat-tool]:max-w-none [&_.subagent-card]:max-w-none [&_.activity-stack]:max-w-none"
      aria-label="Subagent transcript"
    >
      <Virtualizer<ChatRenderItem> data={items}>
        {(item: ChatRenderItem) => {
          if (item.kind === 'message')
            return <MessageRow key={item.id} item={item} skills={skills} />
          if (item.kind === 'tool')
            return <ToolCallRow key={item.id} item={item} />
          if (item.kind === 'activity')
            return <ActivityStack key={item.id} item={item} />
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
