import type { Message } from '@forge/protocol/message'

export type ToolState = 'running' | 'done' | 'error'
export type ChatRenderItem =
  | {
      kind: 'message'
      id: string
      role: 'user' | 'agent'
      text: string
      thought?: boolean
    }
  | {
      kind: 'tool'
      id: string
      name: string
      state: ToolState
      input: unknown
      output?: unknown
    }
  | { kind: 'attachment'; id: string; filename: string; path: string; mime?: string; sizeBytes?: number }
  | { kind: 'system'; id: string; text: string }

export function toRenderModel(
  messages: Message[],
  resumedWithRecap = false,
): ChatRenderItem[] {
  const result: ChatRenderItem[] = resumedWithRecap
    ? [{ kind: 'system', id: 'resumed-recap', text: 'Resumed with recap' }]
    : []
  for (const message of messages) {
    const content = message.content
    if (content.type === 'text_delta' || content.type === 'thought_delta') {
      const previous = result.at(-1)
      if (previous?.kind === 'message' && previous.id === message.itemId) {
        previous.text += content.text
      } else {
        result.push({
          kind: 'message',
          id: message.itemId,
          role: message.role === 'user' ? 'user' : 'agent',
          text: content.text,
          ...(content.type === 'thought_delta' ? { thought: true } : {}),
        })
      }
    } else if (
      content.type === 'tool_call' ||
      content.type === 'tool_update' ||
      content.type === 'tool_result'
    ) {
      const previous = result.find(
        (item) => item.kind === 'tool' && item.id === message.itemId,
      )
      if (previous?.kind === 'tool') {
        if (content.type === 'tool_update')
          previous.state = stateForStatus(content.status)
        if (content.type === 'tool_result') {
          previous.output = content.output
          previous.state = content.isError ? 'error' : 'done'
        }
      } else {
        result.push({
          kind: 'tool',
          id: message.itemId,
          name: 'name' in content ? content.name : 'Tool',
          state:
            content.type === 'tool_result'
              ? content.isError
                ? 'error'
                : 'done'
              : content.type === 'tool_update'
                ? stateForStatus(content.status)
                : 'running',
          input: content.type === 'tool_call' ? content.input : undefined,
          output: content.type === 'tool_result' ? content.output : undefined,
        })
      }
    } else if (content.type === 'attachment_ref') {
      result.push({
        kind: 'attachment',
        id: message.itemId,
        filename: content.filename,
        path: content.path,
        mime: content.mime,
        sizeBytes: content.sizeBytes,
      })
    } else if (content.type === 'turn_interrupted') {
      result.push({
        kind: 'system',
        id: message.itemId,
        text: content.reason
          ? `Turn interrupted: ${content.reason}`
          : 'Turn interrupted',
      })
    } else if (content.type === 'error') {
      result.push({ kind: 'system', id: message.itemId, text: content.message })
    }
  }
  return result
}

function stateForStatus(status: string): ToolState {
  if (/error|fail/i.test(status)) return 'error'
  if (/done|complete|success/i.test(status)) return 'done'
  return 'running'
}
