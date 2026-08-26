import { describe, expect, it } from 'vitest'
import { foldEvent } from './messages'
import type { ServerEvent } from '@forge/protocol/events'
import type { Message } from '@forge/protocol/message'

const message = (overrides: Partial<Message>): Message => ({
  seq: 1,
  sessionId: 'ses-1',
  turnId: 'turn-1',
  itemId: 'item-1',
  role: 'agent',
  type: 'text_delta',
  content: { type: 'text_delta', text: '' },
  createdAt: 'now',
  ...overrides,
})
const event = (seq: number, msg: Message): ServerEvent => ({
  seq,
  sessionId: msg.sessionId,
  msg,
})

describe('message folding', () => {
  it('joins deltas by item and keeps sessions independent', () => {
    let state: Parameters<typeof foldEvent>[0] = { bySession: {}, lastSeq: 0 }
    state = foldEvent(
      state,
      event(1, message({ content: { type: 'text_delta', text: 'hel' } })),
    )
    state = foldEvent(
      state,
      event(
        2,
        message({
          sessionId: 'ses-2',
          itemId: 'item-2',
          content: { type: 'text_delta', text: 'other' },
        }),
      ),
    )
    state = foldEvent(
      state,
      event(3, message({ content: { type: 'text_delta', text: 'lo' } })),
    )
    expect(state.bySession['ses-1'][0].content).toEqual({
      type: 'text_delta',
      text: 'hello',
    })
    expect(state.bySession['ses-2'][0].content).toEqual({
      type: 'text_delta',
      text: 'other',
    })
  })

  it('folds a tool call, update, and result into one item', () => {
    let state: Parameters<typeof foldEvent>[0] = { bySession: {}, lastSeq: 0 }
    state = foldEvent(
      state,
      event(
        1,
        message({
          type: 'tool_call',
          content: {
            type: 'tool_call',
            toolCallId: 'tool-1',
            name: 'shell',
            input: 'ls',
          },
        }),
      ),
    )
    state = foldEvent(
      state,
      event(
        2,
        message({
          type: 'tool_update',
          content: {
            type: 'tool_update',
            toolCallId: 'tool-1',
            status: 'running',
          },
        }),
      ),
    )
    state = foldEvent(
      state,
      event(
        3,
        message({
          type: 'tool_result',
          content: {
            type: 'tool_result',
            toolCallId: 'tool-1',
            output: 'done',
            isError: false,
          },
        }),
      ),
    )
    expect(state.bySession['ses-1']).toHaveLength(1)
    expect(state.bySession['ses-1'][0].content).toMatchObject({
      type: 'tool_result',
      name: 'shell',
      status: 'running',
      output: 'done',
    })
  })

  it('drops events at or below the global cursor', () => {
    const state = foldEvent(
      { bySession: {}, lastSeq: 4 },
      event(4, message({})),
    )
    expect(state).toEqual({ bySession: {}, lastSeq: 4 })
  })
})
