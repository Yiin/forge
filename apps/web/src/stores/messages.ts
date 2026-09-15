import { create } from 'zustand'
import type { Ephemeral, ServerEvent } from '@forge/protocol/events'
import type { Message, MessageContent } from '@forge/protocol/message'
import type { QueuedPrompt } from '@forge/protocol/session'
import type { SessionSnapshot } from '@forge/protocol/ws'

export type TimelineItem = Message
export type VolatileEvent = Ephemeral
export type PendingUserMessage = {
  sessionId: string
  itemId: string
  text: string
  createdAt: string
}
type FoldedMessagesState = Pick<MessagesState, 'bySession' | 'lastSeq'> &
  Partial<Pick<MessagesState, 'pendingBySession' | 'seenSeqs'>>
type MessagesState = {
  bySession: Record<string, TimelineItem[]>
  pendingBySession: Record<string, PendingUserMessage[]>
  queuedBySession: Record<string, QueuedPrompt[]>
  snapshotCursorBySession: Record<string, number>
  snapshotStateBySession: Record<
    string,
    { commands?: unknown[]; requests?: unknown[]; usage?: unknown }
  >
  seenSeqs: Set<number>
  liveEventsBySession: Record<string, Message[]>
  lastSeq: number
  volatile: VolatileEvent[]
  applyEvent: (event: ServerEvent) => void
  loadMessages: (sessionId: string, messages: Message[]) => void
  loadSnapshot: (snapshot: SessionSnapshot) => void
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

type MessageIndex = {
  byItemId: Map<string, number>
  byToolCallId: Map<string, number>
}

const messageIndexes = new WeakMap<Message[], MessageIndex>()

function indexMessages(items: Message[]): MessageIndex {
  const existing = messageIndexes.get(items)
  if (existing) return existing
  const index: MessageIndex = {
    byItemId: new Map(),
    byToolCallId: new Map(),
  }
  for (let position = 0; position < items.length; position++) {
    const item = items[position]!
    if (!index.byItemId.has(item.itemId))
      index.byItemId.set(item.itemId, position)
    const toolId = toolCallId(item)
    if (toolId && !index.byToolCallId.has(toolId))
      index.byToolCallId.set(toolId, position)
  }
  messageIndexes.set(items, index)
  return index
}

function sameItem(left: Message, right: Message): boolean {
  if (left.itemId === right.itemId) return true
  const leftTool = toolCallId(left)
  return leftTool !== undefined && leftTool === toolCallId(right)
}

function mergeProjected(existing: Message, incoming: Message): Message {
  const current = existing.content
  const next = incoming.content
  if (
    (current.type !== 'text_delta' || next.type !== 'text_delta') &&
    (current.type !== 'thought_delta' || next.type !== 'thought_delta')
  )
    return incoming
  const currentText = current.text
  const nextText = next.text
  if (nextText.startsWith(currentText)) return incoming
  if (currentText.startsWith(nextText)) return existing
  const overlap = Math.min(currentText.length, nextText.length)
  for (let length = overlap; length > 0; length--)
    if (currentText.endsWith(nextText.slice(0, length)))
      return {
        ...incoming,
        content: {
          ...next,
          text: currentText + nextText.slice(length),
        },
      }
  return {
    ...incoming,
    content: { ...next, text: currentText + nextText },
  }
}

function mergeMessages(existing: Message[], incoming: Message[]): Message[] {
  const result = [...existing].sort((left, right) => left.seq - right.seq)
  // A whole session's history goes through here, so look items up by index
  // rather than scanning the result for every incoming row. The index is local
  // because the final sort invalidates its positions.
  const index: MessageIndex = { byItemId: new Map(), byToolCallId: new Map() }
  const seqs = new Set<number>()
  for (const [position, item] of result.entries()) {
    seqs.add(item.seq)
    if (!index.byItemId.has(item.itemId))
      index.byItemId.set(item.itemId, position)
    const itemTool = toolCallId(item)
    if (itemTool !== undefined && !index.byToolCallId.has(itemTool))
      index.byToolCallId.set(itemTool, position)
  }
  for (const message of [...incoming].sort(
    (left, right) => left.seq - right.seq,
  )) {
    // A snapshot and replay can contain the same durable row. Sequence is the
    // durable event identity, so do not fold an overlap twice.
    if (seqs.has(message.seq)) continue
    seqs.add(message.seq)
    const tool = toolCallId(message)
    const at =
      index.byItemId.get(message.itemId) ??
      (tool === undefined ? undefined : index.byToolCallId.get(tool)) ??
      -1
    if (at < 0) {
      result.push(message)
      index.byItemId.set(message.itemId, result.length - 1)
      if (tool !== undefined && !index.byToolCallId.has(tool))
        index.byToolCallId.set(tool, result.length - 1)
    } else result[at] = foldMessage(result[at]!, message)
  }
  return result.sort((left, right) => left.seq - right.seq)
}

function mergeNewerMessages(
  history: Message[],
  newer: Message[],
  liveEvents: Message[],
): Message[] {
  const result = [...history]
  for (const message of newer) {
    const index = result.findIndex((item) => sameItem(item, message))
    if (index < 0) result.push(message)
    else if (message.seq > result[index].seq) {
      // If the history row was already live-folded, the newer projection is
      // cumulative. Otherwise this is a first delta and must be appended.
      const raw = liveEvents
        .filter(
          (event) => event.seq > result[index].seq && sameItem(event, message),
        )
        .sort((left, right) => left.seq - right.seq)
      result[index] =
        raw.length && raw[0].seq === result[index].seq + 1
          ? raw.reduce(foldMessage, result[index])
          : mergeProjected(
              result[index],
              newer.find((item) => sameItem(item, result[index])) ?? message,
            )
    }
  }
  return result.sort((left, right) => left.seq - right.seq)
}

export function foldEvent(
  state: Pick<MessagesState, 'bySession' | 'lastSeq'> &
    Partial<Pick<MessagesState, 'pendingBySession' | 'seenSeqs'>>,
  event: ServerEvent,
): FoldedMessagesState {
  // The seen set is updated in place for the same reason the item array is:
  // a replayed session copies it once per event otherwise.
  const seenSeqs = state.seenSeqs ?? new Set<number>()
  if (seenSeqs.has(event.seq))
    return { ...state, lastSeq: Math.max(state.lastSeq, event.seq) }
  const items = state.bySession[event.sessionId] ?? []
  const pending = state.pendingBySession?.[event.sessionId] ?? []
  const index = indexMessages(items)
  // Fold by itemId first. Older rows can lack the server-generated itemId,
  // so use the ACP toolCallId for lifecycle updates and results.
  let itemIndex = event.msg.itemId
    ? (index.byItemId.get(event.msg.itemId) ?? -1)
    : -1
  if (
    itemIndex < 0 &&
    (event.msg.content.type === 'tool_update' ||
      event.msg.content.type === 'tool_result')
  ) {
    const id = toolCallId(event.msg)
    if (id) itemIndex = index.byToolCallId.get(id) ?? -1
  }
  if (itemIndex < 0) {
    itemIndex = items.length
    items.push(event.msg)
  } else {
    items[itemIndex] = foldMessage(items[itemIndex]!, event.msg)
  }
  if (!index.byItemId.has(event.msg.itemId))
    index.byItemId.set(event.msg.itemId, itemIndex)
  const toolId = toolCallId(event.msg)
  if (toolId && !index.byToolCallId.has(toolId))
    index.byToolCallId.set(toolId, itemIndex)
  return {
    // The item array is append-only and is updated in place. This avoids a
    // full session copy for every replayed delta. Consumers subscribe to the
    // record, which is replaced here, so they still observe each update.
    bySession: { ...state.bySession, [event.sessionId]: items },
    pendingBySession: {
      ...state.pendingBySession,
      [event.sessionId]: pending.filter(
        (item) => item.itemId !== event.msg.itemId,
      ),
    },
    lastSeq: Math.max(state.lastSeq, event.seq),
    seenSeqs: seenSeqs.add(event.seq),
  }
}

export const useMessagesStore = create<MessagesState>((set) => ({
  bySession: {},
  pendingBySession: {},
  queuedBySession: {},
  snapshotCursorBySession: {},
  snapshotStateBySession: {},
  seenSeqs: new Set(),
  liveEventsBySession: {},
  lastSeq: 0,
  volatile: [],
  applyEvent: (event) =>
    set((state) => {
      // foldEvent marks the sequence in place, so read it before folding.
      const seen = state.seenSeqs.has(event.seq)
      const folded = foldEvent(state, event)
      if (seen) return folded
      return {
        ...folded,
        liveEventsBySession: {
          ...state.liveEventsBySession,
          [event.sessionId]: [
            ...(state.liveEventsBySession[event.sessionId] ?? []),
            event.msg,
          ].slice(-2000),
        },
      }
    }),
  loadMessages: (sessionId, messages) =>
    set((state) => {
      const history = mergeMessages([], messages)
      const watermark = Math.max(0, ...messages.map((message) => message.seq))
      const newerLive = (state.bySession[sessionId] ?? []).filter(
        (message) => message.seq > watermark,
      )
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: mergeNewerMessages(
            history,
            newerLive,
            state.liveEventsBySession[sessionId] ?? [],
          ),
        },
        pendingBySession: {
          ...state.pendingBySession,
          [sessionId]: (state.pendingBySession[sessionId] ?? []).filter(
            (pending) =>
              !messages.some((message) => message.itemId === pending.itemId),
          ),
        },
        // REST history is scoped to one session. It cannot advance the global
        // live cursor because another subscribed session may have unseen rows.
        seenSeqs: new Set([
          ...state.seenSeqs,
          ...messages.map((message) => message.seq),
        ]),
      }
    }),
  loadSnapshot: (snapshot) => {
    const current =
      useMessagesStore.getState().snapshotCursorBySession[snapshot.sessionId]
    if (current !== undefined && snapshot.cursor < current) return
    if (snapshot.queuedPrompts)
      useMessagesStore
        .getState()
        .setQueued(snapshot.sessionId, snapshot.queuedPrompts)
    useMessagesStore
      .getState()
      .loadMessages(snapshot.sessionId, snapshot.messages)
    set((state) => ({
      snapshotCursorBySession: {
        ...state.snapshotCursorBySession,
        [snapshot.sessionId]: Math.max(
          state.snapshotCursorBySession[snapshot.sessionId] ?? 0,
          snapshot.cursor,
        ),
      },
      snapshotStateBySession: {
        ...state.snapshotStateBySession,
        [snapshot.sessionId]: {
          ...(snapshot.commands ? { commands: snapshot.commands } : {}),
          ...(snapshot.requests ? { requests: snapshot.requests } : {}),
          ...(snapshot.usage !== undefined ? { usage: snapshot.usage } : {}),
        },
      },
    }))
  },
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
    set((state) => {
      if (event.type === 'availableCommands')
        return {
          volatile: [
            ...state.volatile.filter(
              (current) =>
                !(
                  current.type === 'availableCommands' &&
                  current.sessionId === event.sessionId
                ),
            ),
            event,
          ],
        }
      const commands = state.volatile.filter(
        (current) => current.type === 'availableCommands',
      )
      const other = state.volatile
        .filter((current) => current.type !== 'availableCommands')
        .concat(event)
        .slice(-99)
      return { volatile: [...other, ...commands] }
    }),
  reset: () =>
    set({
      bySession: {},
      pendingBySession: {},
      queuedBySession: {},
      snapshotCursorBySession: {},
      snapshotStateBySession: {},
      seenSeqs: new Set(),
      liveEventsBySession: {},
      lastSeq: 0,
      volatile: [],
    }),
}))
