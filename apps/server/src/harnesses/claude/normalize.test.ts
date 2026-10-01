import { describe, expect, it } from 'vitest'
import { ClaudeNormalizer } from './normalize.js'
import { MiB, type EventBody } from './wire.js'

const owner = { runId: 'run', turnId: 'turn' }
function setup() {
  const events: EventBody[] = []
  const normalizer = new ClaudeNormalizer((_, event) => events.push(event))
  return { normalizer, events }
}
describe('Claude content retention', () => {
  it('releases partial text after full reconciliation and keeps only duplicate identities', () => {
    const { normalizer, events } = setup()
    normalizer.content(
      {
        type: 'stream_event',
        event: { type: 'message_start', message: { id: 'message' } },
      },
      owner,
    )
    normalizer.content(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'a'.repeat(MiB) },
        },
      },
      owner,
    )
    expect(normalizer.state.textBytes).toBe(MiB)
    const full = {
      type: 'assistant',
      message: {
        id: 'message',
        content: [{ type: 'text', text: 'a'.repeat(MiB) }],
      },
    }
    normalizer.content(full, owner)
    expect(normalizer.state.textBytes).toBe(0)
    normalizer.content(full, owner)
    expect(events).toHaveLength(1)
    normalizer.finishOwner(owner)
    expect(normalizer.knownMessage(full)?.settled).toBe(true)
    normalizer.close({ status: 'interrupted' })
    expect(normalizer.state).toEqual({
      messages: 0,
      textBytes: 0,
      tools: 0,
      activeTasks: 0,
    })
  })
  it('releases partial blocks on terminal cleanup and preserves a settled stream identity', () => {
    const { normalizer } = setup()
    normalizer.content(
      {
        type: 'stream_event',
        event: { type: 'message_start', message: { id: 'message' } },
      },
      owner,
    )
    normalizer.content(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'partial' },
        },
      },
      owner,
    )
    normalizer.finishOwner(owner)
    expect(normalizer.state.textBytes).toBe(0)
    expect(normalizer.state.messages).toBe(0)
    expect(
      normalizer.knownMessage({
        type: 'stream_event',
        event: { type: 'content_block_delta' },
      }),
    ).toMatchObject({ settled: true, owner })
  })
  it('does not retain an over-budget text append', () => {
    const { normalizer } = setup()
    normalizer.content(
      {
        type: 'stream_event',
        event: { type: 'message_start', message: { id: 'message' } },
      },
      owner,
    )
    normalizer.content(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'a'.repeat(2 * MiB) },
        },
      },
      owner,
    )
    expect(() =>
      normalizer.content(
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'more' },
          },
        },
        owner,
      ),
    ).toThrow('text limit')
    expect(normalizer.state.textBytes).toBe(2 * MiB)
    normalizer.close({ status: 'interrupted' })
    expect(normalizer.state.textBytes).toBe(0)
  })
})

describe('Claude review regressions', () => {
  it.each([false, true])(
    'charges colon-containing tool names per record, streamed=%s',
    (streamed) => {
      const { normalizer, events } = setup()
      const records = [
        { message: 'a', id: 'a', name: 'b:0:c' },
        { message: 'a:0:b', id: 'a:b:0', name: 'c' },
        { message: 'repeat', id: 'repeat', name: 'c' },
      ]
      for (const record of records) {
        const input = {
          type: 'tool_use',
          id: record.id,
          name: record.name,
          input: {},
        }
        const frame = {
          type: 'assistant',
          uuid: record.message,
          message: { id: record.message, content: [input] },
        }
        if (streamed) {
          normalizer.content(
            {
              type: 'stream_event',
              event: { type: 'message_start', message: { id: record.message } },
            },
            owner,
          )
          const start = {
            type: 'stream_event',
            event: {
              type: 'content_block_start',
              index: 0,
              content_block: input,
            },
          }
          normalizer.content(start, owner)
          normalizer.content(start, owner)
          normalizer.content(
            {
              type: 'stream_event',
              event: { type: 'content_block_stop', index: 0 },
            },
            owner,
          )
        }
        normalizer.content(frame, owner)
        normalizer.content(frame, owner)
      }
      expect(
        events
          .filter((event) => event.type === 'tool_started')
          .map((event) => ({ id: event.toolCallId, name: event.name })),
      ).toEqual(records.map(({ id, name }) => ({ id, name })))
      normalizer.finishOwner(owner)
      expect(normalizer.state.tools).toBe(3)
      expect(normalizer.retainedInputBytes).toBe(0)
      normalizer.close({ status: 'interrupted' })
      expect(normalizer.state.tools).toBe(0)
    },
  )

  it.each([false, true])(
    'reconciles identical streamed blocks for child=%s',
    (child) => {
      const { normalizer, events } = setup()
      let target = owner
      if (child) {
        normalizer.content(
          {
            type: 'assistant',
            message: {
              id: 'spawn',
              content: [
                { type: 'tool_use', id: 'agent', name: 'Agent', input: {} },
              ],
            },
          },
          owner,
        )
        target = normalizer.childOwner({ parent_tool_use_id: 'agent' })!
      }
      for (const nativeIds of [false, true]) {
        const messageId = `message-${nativeIds}`
        normalizer.content(
          {
            type: 'stream_event',
            event: { type: 'message_start', message: { id: messageId } },
          },
          target,
        )
        for (const index of [0, 1]) {
          normalizer.content(
            {
              type: 'stream_event',
              event: {
                type: 'content_block_start',
                index,
                content_block: { type: 'text', text: 'a' },
              },
            },
            target,
          )
          const frame = {
            type: 'assistant',
            ...(nativeIds ? { uuid: `frame-${index}` } : {}),
            message: { id: messageId, content: [{ type: 'text', text: 'ab' }] },
          }
          normalizer.content(frame, target)
          normalizer.content(frame, target)
          expect(normalizer.state.textBytes).toBe(0)
        }
      }
      const deltas = events.filter((e) => e.type === 'text_delta')
      expect(deltas.map((e) => e.text).join('')).toBe('abababab')
      expect(new Set(deltas.map((e) => e.itemId)).size).toBe(4)
    },
  )

  it('preserves separate identical full-only frames and rejects native frame retries', () => {
    const { normalizer, events } = setup()
    for (const uuid of ['first', 'second', 'first', 'second'])
      normalizer.content(
        {
          type: 'assistant',
          uuid,
          message: { id: 'message', content: [{ type: 'text', text: 'same' }] },
        },
        owner,
      )
    expect(
      events
        .filter((e) => e.type === 'text_delta')
        .map((e) => e.text)
        .join(''),
    ).toBe('samesame')
    expect(normalizer.state.textBytes).toBe(0)
  })

  it('charges streamed initial input against block, message, and aggregate content limits', () => {
    const { normalizer } = setup()
    const message = (id: string) =>
      normalizer.content(
        {
          type: 'stream_event',
          event: { type: 'message_start', message: { id } },
        },
        owner,
      )
    const start = (index: number, bytes: number) =>
      normalizer.content(
        {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            index,
            content_block: {
              type: 'tool_use',
              id: `tool-${index}`,
              name: 'Bash',
              input: { value: 'x'.repeat(bytes - 12) },
            },
          },
        },
        owner,
      )
    message('one')
    expect(() => start(0, 2 * MiB + 1)).toThrow('tool input limit')
    expect(normalizer.retainedInputBytes).toBe(0)
    start(0, 2 * MiB)
    expect(normalizer.retainedInputBytes).toBe(2 * MiB)
    expect(() =>
      normalizer.content(
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: 'x' },
          },
        },
        owner,
      ),
    ).toThrow('text limit')
    start(1, 2 * MiB)
    expect(() => start(2, 12)).toThrow('tool input limit')
    message('two')
    start(3, 2 * MiB)
    start(4, 2 * MiB)
    message('three')
    expect(() => start(5, 12)).toThrow('tool input limit')
    expect(normalizer.state.textBytes).toBe(0)
    expect(normalizer.retainedInputBytes).toBe(8 * MiB)
    normalizer.finishOwner(owner)
    expect(normalizer.retainedInputBytes).toBe(0)
    normalizer.finishOwner(owner)
    expect(normalizer.retainedInputBytes).toBe(0)
    normalizer.close({ status: 'interrupted' })
    expect(normalizer.retainedInputBytes).toBe(0)
  })

  it('releases replaced inputs and preserves streamed JSON plus full tool deduplication', () => {
    const { normalizer, events } = setup()
    const stream = (event: Record<string, unknown>) =>
      normalizer.content({ type: 'stream_event', event }, owner)
    stream({ type: 'message_start', message: { id: 'message' } })
    const start = (input: unknown) =>
      stream({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tool', name: 'Bash', input },
      })
    start({ large: 'x'.repeat(MiB) })
    expect(normalizer.retainedInputBytes).toBeGreaterThan(MiB)
    start({})
    expect(normalizer.retainedInputBytes).toBe(2)
    stream({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"command":"pwd"}' },
    })
    stream({ type: 'content_block_stop', index: 0 })
    expect(normalizer.retainedInputBytes).toBe(0)
    expect(normalizer.state.textBytes).toBe(0)
    normalizer.content(
      {
        type: 'assistant',
        message: {
          id: 'message',
          content: [
            {
              type: 'tool_use',
              id: 'tool',
              name: 'Bash',
              input: { command: 'pwd' },
            },
          ],
        },
      },
      owner,
    )
    expect(events.filter((e) => e.type === 'tool_started')).toHaveLength(1)
    expect(events.find((e) => e.type === 'tool_started')).toMatchObject({
      input: { command: 'pwd' },
    })
    expect(normalizer.retainedInputBytes).toBe(0)
    normalizer.finishOwner(owner)
    expect(normalizer.retainedInputBytes).toBe(0)
  })
})
