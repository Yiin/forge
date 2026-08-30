import { Ephemeral, ServerEvent } from '@forge/protocol/events'
import type { Message } from '@forge/protocol/message'
import { SubscribeFrame } from '@forge/protocol/ws'
import { useMessagesStore } from '../stores/messages'
import { useSessionsStore } from '../stores/sessions'

export interface ForgeWebSocket {
  readonly readyState: number
  send(data: string): void
  close(): void
  onopen: (() => void) | null
  onmessage: ((event: { data: string }) => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
}
type SocketOptions = {
  url?: string
  sessions?: string[] | 'all'
  reconnect?: boolean
  backoff?: { initialMs?: number; maxMs?: number }
  createWebSocket?: (url: string) => ForgeWebSocket
  onConnectionChange?: (state: ConnectionState) => void
}
export type ConnectionState =
  'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error'
const defaultUrl = () =>
  typeof window === 'undefined'
    ? 'ws://localhost:3000/ws'
    : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`

export class ForgeSocket {
  private socket?: ForgeWebSocket
  private timer?: ReturnType<typeof setTimeout>
  private stopped = false
  private attempt = 0
  private readonly options: Required<
    Pick<SocketOptions, 'url' | 'sessions' | 'reconnect'>
  > &
    Pick<SocketOptions, 'backoff' | 'createWebSocket'> &
    Pick<SocketOptions, 'onConnectionChange'>
  constructor(options: SocketOptions = {}) {
    this.options = {
      url: options.url ?? defaultUrl(),
      sessions: options.sessions ?? 'all',
      reconnect: options.reconnect ?? true,
      backoff: options.backoff,
      createWebSocket:
        options.createWebSocket ??
        ((url) => new WebSocket(url) as ForgeWebSocket),
      onConnectionChange: options.onConnectionChange,
    }
  }
  start() {
    this.stopped = false
    this.connect()
    return this
  }
  stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.socket?.close()
    this.socket = undefined
  }
  setSessions(sessions: string[] | 'all') {
    this.options.sessions = sessions
    if (this.socket?.readyState === 1)
      this.socket.send(JSON.stringify(this.subscribeFrame()))
  }
  private connect() {
    if (this.stopped) return
    this.options.onConnectionChange?.(
      this.attempt > 0 ? 'reconnecting' : 'connecting',
    )
    const socket = this.options.createWebSocket!(this.options.url)
    this.socket = socket
    socket.onopen = () => {
      this.attempt = 0
      this.options.onConnectionChange?.('connected')
      socket.send(JSON.stringify(this.subscribeFrame()))
    }
    socket.onmessage = ({ data }) => this.receive(data)
    socket.onerror = () => {
      this.options.onConnectionChange?.('error')
      socket.close()
    }
    socket.onclose = () => {
      if (this.socket === socket) this.socket = undefined
      if (!this.stopped && this.options.reconnect) this.scheduleReconnect()
      else if (!this.stopped) this.options.onConnectionChange?.('disconnected')
    }
  }
  private subscribeFrame() {
    return SubscribeFrame.parse({
      type: 'subscribe',
      sessions: this.options.sessions,
      cursor: useMessagesStore.getState().lastSeq,
    })
  }
  private receive(data: string) {
    let value: unknown
    try {
      value = JSON.parse(data)
    } catch {
      return
    }
    value = normalizeServerEvent(value)
    if (
      value &&
      typeof value === 'object' &&
      'message' in value &&
      value.message
    )
      value = normalizeServerEvent(value.message)
    const ephemeral = Ephemeral.safeParse(value)
    if (ephemeral.success) {
      const frame = ephemeral.data
      if (frame.type === 'sessionStatus') {
        const sessions = useSessionsStore.getState()
        const current = sessions.sessions.find(
          (session) => session.id === frame.sessionId,
        )
        if (current)
          sessions.upsertSession({ ...current, status: frame.status })
      }
      if (frame.type === 'sessionTitle') {
        const sessions = useSessionsStore.getState()
        const current = sessions.sessions.find(
          (session) => session.id === frame.sessionId,
        )
        if (current) sessions.upsertSession({ ...current, title: frame.title })
      }
      if (frame.type === 'contextWindow') {
        useSessionsStore
          .getState()
          .setContextWindow(frame.sessionId, frame.usage)
        return
      }
      return useMessagesStore.getState().applyEphemeral(frame)
    }
    const event = ServerEvent.safeParse(value)
    if (event.success) useMessagesStore.getState().applyEvent(event.data)
  }
  private scheduleReconnect() {
    if (this.timer) return
    this.options.onConnectionChange?.('reconnecting')
    const initial = this.options.backoff?.initialMs ?? 100
    const max = this.options.backoff?.maxMs ?? 10_000
    this.timer = setTimeout(
      () => {
        this.timer = undefined
        this.connect()
      },
      Math.min(max, initial * 2 ** this.attempt++),
    )
  }
}
export function normalizeServerEvent(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  const candidate = value as Record<string, any>
  if (candidate.msg) return value
  if (
    typeof candidate.seq !== 'number' ||
    typeof candidate.sessionId !== 'string'
  )
    return value
  return {
    seq: candidate.seq,
    sessionId: candidate.sessionId,
    msg: {
      seq: candidate.seq,
      sessionId: candidate.sessionId,
      turnId: candidate.turnId ?? `${candidate.sessionId}-turn`,
      // Deltas coalesce per session; everything else needs a unique itemId
      // or same-type messages would fold into each other and lose content.
      itemId:
        candidate.itemId ??
        (candidate.type === 'text_delta' || candidate.type === 'thought_delta'
          ? `${candidate.sessionId}-${candidate.type}`
          : `${candidate.sessionId}-${candidate.seq}`),
      role: candidate.role ?? 'system',
      type: candidate.type,
      content:
        candidate.content && typeof candidate.content === 'object'
          ? { type: candidate.type, ...candidate.content }
          : { type: candidate.type },
      // Replayed history carries its own timestamp, and subagent placement
      // reads it, so keep the row's value and stamp only live frames.
      createdAt:
        typeof candidate.createdAt === 'string'
          ? candidate.createdAt
          : new Date().toISOString(),
    },
  }
}
export const connectForgeSocket = (options?: SocketOptions) =>
  new ForgeSocket(options).start()
// History rows arrive in the same wire shape as socket frames, so the timeline
// has to normalize them too. A row that carries its type outside `content`
// renders as nothing, and it also replaces the folded socket copy of that seq.
export function normalizeMessage(value: unknown): Message {
  const event = normalizeServerEvent(value)
  return event && typeof event === 'object' && 'msg' in event
    ? (event.msg as Message)
    : (value as Message)
}
