import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ForgeSocket, type ForgeWebSocket } from './socket'
import { useMessagesStore } from '../stores/messages'
import { useSessionsStore } from '../stores/sessions'

class MockSocket implements ForgeWebSocket {
  static sockets: MockSocket[] = []
  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor() {
    MockSocket.sockets.push(this)
  }
  send(data: string) {
    this.sent.push(data)
  }
  close() {
    this.readyState = 3
    this.onclose?.()
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  message(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) })
  }
  drop() {
    this.readyState = 3
    this.onclose?.()
  }
}

describe('ForgeSocket', () => {
  beforeEach(() => {
    MockSocket.sockets = []
    useMessagesStore.getState().reset()
    useSessionsStore.setState({ sessions: [], projects: [], contextWindow: {} })
    vi.useFakeTimers()
  })
  it('resubscribes from the cursor and produces no duplicate after a drop', () => {
    const socket = new ForgeSocket({
      createWebSocket: () => new MockSocket(),
      backoff: { initialMs: 10, maxMs: 10 },
    }).start()
    const first = MockSocket.sockets[0]
    first.open()
    const msg = {
      seq: 1,
      sessionId: 'ses-1',
      msg: {
        seq: 1,
        sessionId: 'ses-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        role: 'agent',
        type: 'text_delta',
        content: { type: 'text_delta', text: 'one' },
        createdAt: 'now',
      },
    }
    first.message(msg)
    first.drop()
    vi.advanceTimersByTime(10)
    const second = MockSocket.sockets[1]
    second.open()
    expect(JSON.parse(second.sent[0]).cursor).toBe(1)
    second.message(msg)
    second.message({
      ...msg,
      seq: 2,
      msg: {
        ...msg.msg,
        seq: 2,
        content: { type: 'text_delta', text: ' two' },
      },
    })
    second.message({
      type: 'presence',
      seq: null,
      sessionId: 'ses-1',
      connected: true,
    })
    expect(useMessagesStore.getState().bySession['ses-1'][0].content).toEqual({
      type: 'text_delta',
      text: 'one two',
    })
    expect(useMessagesStore.getState().volatile).toHaveLength(1)
    socket.stop()
  })

  it('stores the newest context window frame without adding volatile messages', () => {
    const socket = new ForgeSocket({
      createWebSocket: () => new MockSocket(),
    }).start()
    const mock = MockSocket.sockets[0]
    mock.open()
    const usage = {
      usedTokens: 10,
      maxTokens: 100,
      source: 'test',
      observedAt: 20,
    }
    mock.message({
      type: 'contextWindow',
      seq: null,
      sessionId: 'ses-1',
      usage,
    })
    mock.message({
      type: 'contextWindow',
      seq: null,
      sessionId: 'ses-1',
      usage: { ...usage, usedTokens: 1, observedAt: 10 },
    })
    expect(useSessionsStore.getState().contextWindow['ses-1']).toEqual(usage)
    expect(useMessagesStore.getState().volatile).toHaveLength(0)
    socket.stop()
  })
})
