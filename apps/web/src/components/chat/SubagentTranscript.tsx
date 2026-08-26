import { useMemo } from 'react'
import { Virtualizer } from 'virtua'
import type { Message } from '@forge/protocol/message'
import { MessageRow, ToolCallRow } from './MessageRow'
import { toRenderModel } from './render-model'
import type { ChatRenderItem } from './render-model'

export function SubagentTranscript({ messages }: { messages: Message[] }) {
  const items = useMemo(() => toRenderModel(messages), [messages])
  return (
    <div className="subagent-transcript" aria-label="Subagent transcript">
      <Virtualizer<ChatRenderItem> data={items}>
        {(item: ChatRenderItem) => {
          if (item.kind === 'message')
            return <MessageRow key={item.id} item={item} />
          if (item.kind === 'tool')
            return <ToolCallRow key={item.id} item={item} />
          if (item.kind === 'system')
            return (
              <div key={item.id} className="chat-system">
                {item.text}
              </div>
            )
          return <div key={item.id} />
        }}
      </Virtualizer>
    </div>
  )
}
