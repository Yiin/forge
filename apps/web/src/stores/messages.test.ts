import { describe, expect, it } from 'vitest'
import { foldEvent, useMessagesStore } from './messages'
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
  it('keeps replay folding close to linear for large sessions', () => {
    const run = (count: number) => {
      let state: Parameters<typeof foldEvent>[0] = {
        bySession: {},
        lastSeq: 0,
      }
      const started = performance.now()
      for (let sequence = 1; sequence <= count; sequence++) {
        state = foldEvent(
          state,
          event(
            sequence,
            message({
              itemId: `item-${sequence}`,
              content: { type: 'text_delta', text: 'x' },
            }),
          ),
        )
      }
      expect(state.bySession['ses-1']).toHaveLength(count)
      return performance.now() - started
    }

    const small = run(2_000)
    const large = run(20_000)
    // Ten times as many events must not approach the old hundredfold copy cost.
    expect(large).toBeLessThan(small * 25 + 100)
  })

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

  it('folds lifecycle events by toolCallId when itemIds differ', () => {
    let state: Parameters<typeof foldEvent>[0] = { bySession: {}, lastSeq: 0 }
    state = foldEvent(
      state,
      event(
        1,
        message({
          itemId: 'call-item',
          type: 'tool_call',
          content: {
            type: 'tool_call',
            toolCallId: 'tool-legacy',
            name: 'shell',
            input: 'pwd',
          },
        }),
      ),
    )
    state = foldEvent(
      state,
      event(
        2,
        message({
          itemId: 'update-item',
          type: 'tool_update',
          content: {
            type: 'tool_update',
            toolCallId: 'tool-legacy',
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
          itemId: 'result-item',
          type: 'tool_result',
          content: {
            type: 'tool_result',
            toolCallId: 'tool-legacy',
            output: 'done',
            isError: false,
          },
        }),
      ),
    )
    expect(state.bySession['ses-1']).toHaveLength(1)
    expect(state.bySession['ses-1'][0]).toMatchObject({
      itemId: 'result-item',
      content: { type: 'tool_result', output: 'done' },
    })
  })

  it('drops events at or below the global cursor', () => {
    const state = foldEvent(
      { bySession: {}, lastSeq: 4, seenSeqs: new Set([4]) },
      event(4, message({})),
    )
    expect(state).toEqual({
      bySession: {},
      lastSeq: 4,
      seenSeqs: new Set([4]),
    })
  })

  it('reconciles pending rows when the server item arrives', () => {
    const pending = {
      sessionId: 'ses-1',
      itemId: 'client_1234567890abcdef1234567890abcdef',
      text: 'hello',
      createdAt: 'now',
    }
    const state = foldEvent(
      {
        bySession: {},
        lastSeq: 0,
        pendingBySession: { 'ses-1': [pending] },
      },
      event(1, message({ itemId: pending.itemId, role: 'user' })),
    )
    expect(state.bySession['ses-1']).toHaveLength(1)
    expect(state.pendingBySession?.['ses-1']).toEqual([])
  })

  it('reloads older session history after opening a newer session', () => {
    useMessagesStore.getState().reset()
    useMessagesStore.getState().loadMessages(
      'ses-1',
      Array.from({ length: 5 }, (_, index) =>
        message({ seq: index + 1, itemId: `ses-1-item-${index + 1}` }),
      ),
    )
    useMessagesStore.getState().loadMessages(
      'ses-2',
      Array.from({ length: 4 }, (_, index) =>
        message({
          sessionId: 'ses-2',
          seq: index + 6,
          itemId: `ses-2-item-${index + 1}`,
        }),
      ),
    )
    useMessagesStore.getState().loadMessages(
      'ses-1',
      Array.from({ length: 5 }, (_, index) =>
        message({ seq: index + 1, itemId: `ses-1-item-${index + 1}` }),
      ),
    )
    const state = useMessagesStore.getState()
    expect(state.bySession['ses-1']).toHaveLength(5)
    expect(state.bySession['ses-2']).toHaveLength(4)
    expect(state.lastSeq).toBe(0)
  })

  it('reconciles REST snapshots with live deltas without moving the live cursor', () => {
    useMessagesStore.getState().reset()
    useMessagesStore.getState().loadMessages('ses-1', [
      message({
        seq: 8,
        itemId: 'item-1',
        content: { type: 'text_delta', text: 'hello' },
      }),
    ])
    expect(useMessagesStore.getState().lastSeq).toBe(0)
    useMessagesStore.getState().applyEvent(
      event(
        8,
        message({
          seq: 8,
          itemId: 'item-1',
          content: { type: 'text_delta', text: 'hello' },
        }),
      ),
    )
    useMessagesStore.getState().applyEvent(
      event(
        9,
        message({
          seq: 9,
          itemId: 'item-1',
          content: { type: 'text_delta', text: ' world' },
        }),
      ),
    )
    expect(useMessagesStore.getState().bySession['ses-1'][0].content).toEqual({
      type: 'text_delta',
      text: 'hello world',
    })
    expect(useMessagesStore.getState().lastSeq).toBe(9)
  })

  it('keeps the newest snapshot cursor and queued state after reload', () => {
    useMessagesStore.getState().reset()
    useMessagesStore.getState().loadSnapshot({
      type: 'sessionSnapshot',
      sessionId: 'ses-1',
      cursor: 12,
      messages: [message({ seq: 4 })],
      queuedPrompts: [
        { id: 'q1', sessionId: 'ses-1', text: 'later', createdAt: 1 },
      ],
    })
    expect(useMessagesStore.getState().snapshotCursorBySession['ses-1']).toBe(
      12,
    )
    expect(useMessagesStore.getState().queuedBySession['ses-1']).toHaveLength(1)
    expect(useMessagesStore.getState().lastSeq).toBe(0)
  })

  it('does not double-fold cumulative live text when a snapshot races it', () => {
    useMessagesStore.getState().reset()
    const first = message({
      seq: 1,
      content: { type: 'text_delta', text: 'a' },
    })
    const second = message({
      seq: 2,
      content: { type: 'text_delta', text: 'b' },
    })
    useMessagesStore.getState().applyEvent(event(1, first))
    useMessagesStore.getState().applyEvent(event(2, second))
    useMessagesStore.getState().loadSnapshot({
      type: 'sessionSnapshot',
      sessionId: 'ses-1',
      cursor: 1,
      messages: [first],
    })
    expect(useMessagesStore.getState().bySession['ses-1'][0].content).toEqual({
      type: 'text_delta',
      text: 'ab',
    })
  })

  it('keeps the snapshot prefix when live text started before the snapshot', () => {
    useMessagesStore.getState().reset()
    useMessagesStore.getState().applyEvent(
      event(
        2,
        message({
          seq: 2,
          content: { type: 'text_delta', text: 'b' },
        }),
      ),
    )
    useMessagesStore.getState().applyEvent(
      event(
        3,
        message({
          seq: 3,
          content: { type: 'text_delta', text: 'c' },
        }),
      ),
    )
    useMessagesStore.getState().loadSnapshot({
      type: 'sessionSnapshot',
      sessionId: 'ses-1',
      cursor: 2,
      messages: [
        message({
          seq: 1,
          content: { type: 'text_delta', text: 'a' },
        }),
        message({
          seq: 2,
          content: { type: 'text_delta', text: 'b' },
        }),
      ],
    })
    expect(useMessagesStore.getState().bySession['ses-1'][0].content).toEqual({
      type: 'text_delta',
      text: 'abc',
    })
  })

  it('keeps repeated live deltas during snapshot reconciliation', () => {
    useMessagesStore.getState().reset()
    for (const [seq, text] of [
      [2, 'a'],
      [3, 'a'],
    ] as const)
      useMessagesStore
        .getState()
        .applyEvent(
          event(seq, message({ seq, content: { type: 'text_delta', text } })),
        )
    useMessagesStore.getState().loadSnapshot({
      type: 'sessionSnapshot',
      sessionId: 'ses-1',
      cursor: 2,
      messages: [
        message({ seq: 1, content: { type: 'text_delta', text: 'a' } }),
        message({ seq: 2, content: { type: 'text_delta', text: 'a' } }),
      ],
    })
    expect(useMessagesStore.getState().bySession['ses-1'][0].content).toEqual({
      type: 'text_delta',
      text: 'aaa',
    })
  })

  it('keeps the global cursor monotonic across sessions', () => {
    useMessagesStore.getState().reset()
    useMessagesStore
      .getState()
      .applyEvent(event(8, message({ sessionId: 'ses-1', seq: 8 })))
    useMessagesStore
      .getState()
      .applyEvent(event(3, message({ sessionId: 'ses-2', seq: 3 })))
    expect(useMessagesStore.getState().lastSeq).toBe(8)
  })
})

it('replays authoritative snapshots without merging sibling turns or child channels', () => {
  const rows = [
    message({ seq: 1, content: { type: 'text_delta', text: 'wrong' } }),
    message({
      seq: 2,
      type: 'thought_delta',
      content: { type: 'thought_delta', text: 'thought' },
    }),
    message({
      seq: 3,
      content: { type: 'text_delta', text: 'child', childId: 'child' },
    }),
    message({
      seq: 4,
      type: 'content_snapshot',
      content: {
        type: 'content_snapshot',
        contentType: 'text',
        text: 'correct',
      },
    }),
    message({ seq: 5, content: { type: 'text_delta', text: ' suffix' } }),
    message({
      seq: 6,
      turnId: 'other',
      content: { type: 'text_delta', text: 'other' },
    }),
  ]
  const store = useMessagesStore
  store.getState().reset()
  for (const row of rows) store.getState().applyEvent(event(row.seq, row))
  const live = store.getState().bySession['ses-1']
  expect(live).toHaveLength(4)
  expect(
    live.find((row) => row.content.type === 'content_snapshot')?.content,
  ).toMatchObject({ text: 'correct suffix' })
  store.getState().reset()
  store.getState().loadMessages('ses-1', rows)
  expect(store.getState().bySession['ses-1']).toEqual(
    [...live].sort((a, b) => a.seq - b.seq),
  )
  store.getState().reset()
})
