import { create } from 'zustand'
import type { Ephemeral, ServerEvent } from '@forge/protocol/events'
import type { Message, MessageContent } from '@forge/protocol/message'

export type TimelineItem = Message
export type VolatileEvent = Ephemeral
type MessagesState = {
  bySession: Record<string, TimelineItem[]>
  lastSeq: number
  volatile: VolatileEvent[]
  applyEvent: (event: ServerEvent) => void
  loadMessages: (sessionId: string, messages: Message[]) => void
  applyEphemeral: (event: VolatileEvent) => void
  reset: () => void
}

function foldMessage(existing: Message, incoming: Message): Message {
  const current = existing.content
  const next = incoming.content
  let content: MessageContent = next
  if (
    (current.type === 'text_delta' && next.type === 'text_delta') ||
    (current.type === 'thought_delta' && next.type === 'thought_delta')
  )
    content = { ...next, text: current.text + next.text }
  else if (
    (current.type === 'tool_call' || current.type === 'tool_update') &&
    (next.type === 'tool_update' || next.type === 'tool_result')
  )
    content = { ...current, ...next }
  return { ...existing, ...incoming, content }
}

export function foldEvent(
  state: Pick<MessagesState, 'bySession' | 'lastSeq'>,
  event: ServerEvent,
): Pick<MessagesState, 'bySession' | 'lastSeq'> {
  if (event.seq <= state.lastSeq) return state
  const items = state.bySession[event.sessionId] ?? []
  const index = items.findIndex((item) => item.itemId === event.msg.itemId)
  const nextItems = [...items]
  if (index < 0) nextItems.push(event.msg)
  else nextItems[index] = foldMessage(nextItems[index], event.msg)
  return {
    bySession: { ...state.bySession, [event.sessionId]: nextItems },
    lastSeq: event.seq,
  }
}

export const useMessagesStore = create<MessagesState>((set) => ({
  bySession: {},
  lastSeq: 0,
  volatile: [],
  applyEvent: (event) => set((state) => foldEvent(state, event)),
  loadMessages: (sessionId, messages) =>
    set((state) => ({
      bySession: {
        ...state.bySession,
        [sessionId]: Array.from(
          new Map(
            [...(state.bySession[sessionId] ?? []), ...messages].map((message) => [
              message.seq,
              message,
            ]),
          ).values(),
        ).sort((left, right) => left.seq - right.seq),
      },
    })),
  applyEphemeral: (event) =>
    set((state) => ({ volatile: [...state.volatile, event] })),
  reset: () => set({ bySession: {}, lastSeq: 0, volatile: [] }),
}))
