import { create } from 'zustand'
import type { Ephemeral, ServerEvent } from '@forge/protocol/events'
import type { Message, MessageContent } from '@forge/protocol/message'
import type { QueuedPrompt } from '@forge/protocol/session'

export type TimelineItem = Message
export type VolatileEvent = Ephemeral
export type PendingUserMessage = {
  sessionId: string
  itemId: string
  text: string
  createdAt: string
}
type FoldedMessagesState = Pick<MessagesState, 'bySession' | 'lastSeq'> &
  Partial<Pick<MessagesState, 'pendingBySession'>>
type MessagesState = {
  bySession: Record<string, TimelineItem[]>
  pendingBySession: Record<string, PendingUserMessage[]>
  queuedBySession: Record<string, QueuedPrompt[]>
  lastSeq: number
  volatile: VolatileEvent[]
  applyEvent: (event: ServerEvent) => void
  loadMessages: (sessionId: string, messages: Message[]) => void
  addPending: (pending: PendingUserMessage) => void
  removePending: (sessionId: string, itemId: string) => void
  clearPending: (sessionId: string) => void
  setQueued: (sessionId: string, prompts: QueuedPrompt[]) => void
  removeQueued: (sessionId: string, promptId: string) => void
  updateQueued: (sessionId: string, prompt: QueuedPrompt) => void
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

function toolCallId(message: Message): string | undefined {
  if (
    message.content.type === 'tool_call' ||
    message.content.type === 'tool_update' ||
    message.content.type === 'tool_result'
  )
    return message.content.toolCallId
  return undefined
}

export function foldEvent(
  state: Pick<MessagesState, 'bySession' | 'lastSeq'> &
    Partial<Pick<MessagesState, 'pendingBySession'>>,
  event: ServerEvent,
): FoldedMessagesState {
  if (event.seq <= state.lastSeq) return state
  const items = state.bySession[event.sessionId] ?? []
  const pending = state.pendingBySession?.[event.sessionId] ?? []
  // Fold by itemId first. Older rows can lack the server-generated itemId,
  // so use the ACP toolCallId for lifecycle updates and results.
  let index = event.msg.itemId
    ? items.findIndex((item) => item.itemId === event.msg.itemId)
    : -1
  if (
    index < 0 &&
    (event.msg.content.type === 'tool_update' ||
      event.msg.content.type === 'tool_result')
  ) {
    const id = toolCallId(event.msg)
    if (id) index = items.findIndex((item) => toolCallId(item) === id)
  }
  const nextItems = [...items]
  if (index < 0) nextItems.push(event.msg)
  else nextItems[index] = foldMessage(nextItems[index], event.msg)
  return {
    bySession: { ...state.bySession, [event.sessionId]: nextItems },
    pendingBySession: {
      ...state.pendingBySession,
      [event.sessionId]: pending.filter(
        (item) => item.itemId !== event.msg.itemId,
      ),
    },
    lastSeq: event.seq,
  }
}

export const useMessagesStore = create<MessagesState>((set) => ({
  bySession: {},
  pendingBySession: {},
  queuedBySession: {},
  lastSeq: 0,
  volatile: [],
  applyEvent: (event) => set((state) => foldEvent(state, event)),
  loadMessages: (sessionId, messages) =>
    set((state) => ({
      bySession: {
        ...state.bySession,
        [sessionId]: Array.from(
          new Map(
            [...(state.bySession[sessionId] ?? []), ...messages].map(
              (message) => [message.seq, message],
            ),
          ).values(),
        ).sort((left, right) => left.seq - right.seq),
      },
      pendingBySession: {
        ...state.pendingBySession,
        [sessionId]: (state.pendingBySession[sessionId] ?? []).filter(
          (pending) =>
            !messages.some((message) => message.itemId === pending.itemId),
        ),
      },
      lastSeq: Math.max(
        state.lastSeq,
        ...messages.map((message) => message.seq),
        0,
      ),
    })),
  addPending: (pending) =>
    set((state) => ({
      pendingBySession: {
        ...state.pendingBySession,
        [pending.sessionId]: [
          ...(state.pendingBySession[pending.sessionId] ?? []).filter(
            (item) => item.itemId !== pending.itemId,
          ),
          pending,
        ],
      },
    })),
  removePending: (sessionId, itemId) =>
    set((state) => ({
      pendingBySession: {
        ...state.pendingBySession,
        [sessionId]: (state.pendingBySession[sessionId] ?? []).filter(
          (item) => item.itemId !== itemId,
        ),
      },
    })),
  clearPending: (sessionId) =>
    set((state) => ({
      pendingBySession: { ...state.pendingBySession, [sessionId]: [] },
    })),
  setQueued: (sessionId, prompts) =>
    set((state) => ({
      queuedBySession: { ...state.queuedBySession, [sessionId]: prompts },
    })),
  removeQueued: (sessionId, promptId) =>
    set((state) => ({
      queuedBySession: {
        ...state.queuedBySession,
        [sessionId]: (state.queuedBySession[sessionId] ?? []).filter(
          (prompt) => prompt.id !== promptId,
        ),
      },
    })),
  updateQueued: (sessionId, prompt) =>
    set((state) => ({
      queuedBySession: {
        ...state.queuedBySession,
        [sessionId]: (state.queuedBySession[sessionId] ?? []).map((current) =>
          current.id === prompt.id ? prompt : current,
        ),
      },
    })),
  applyEphemeral: (event) =>
    set((state) => ({ volatile: [...state.volatile, event] })),
  reset: () =>
    set({ bySession: {}, pendingBySession: {}, queuedBySession: {}, lastSeq: 0, volatile: [] }),
}))
