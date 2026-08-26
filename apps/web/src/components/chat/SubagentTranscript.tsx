import { useMemo } from 'react'
import { Virtualizer } from 'virtua'
import type { Message } from '@forge/protocol/message'
import { MessageRow, ToolCallRow } from './MessageRow'
import { toRenderModel } from './render-model'

export function SubagentTranscript({ messages }: { messages: Message[] }) {
  const items = useMemo(() => toRenderModel(messages), [messages])
  return (
    <div className="subagent-transcript" aria-label="Subagent transcript">
      <Virtualizer data={items}>
        {(item) => {
          if (item.kind === 'message') return <MessageRow item={item} />
          if (item.kind === 'tool') return <ToolCallRow item={item} />
          if (item.kind === 'system')
            return <div className="chat-system">{item.text}</div>
          return null
        }}
      </Virtualizer>
    </div>
  )
}
