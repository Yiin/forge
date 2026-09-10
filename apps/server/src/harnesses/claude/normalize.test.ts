import { describe, expect, it } from 'vitest'
import { ClaudeNormalizer } from './normalize.js'
import { Identities, LIMITS, MiB, type EventBody } from './wire.js'

const owner = { runId: 'run', turnId: 'turn' }
function setup() {
  const events: EventBody[] = []
  const ids = new Identities()
  const normalizer = new ClaudeNormalizer((_, event) => events.push(event), ids)
  return { normalizer, events, ids }
}
describe('Claude content retention', () => {
  it('releases partial text after full reconciliation and keeps only duplicate identities', () => {
    const { normalizer, events, ids } = setup()
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
    expect(ids.size).toBeGreaterThan(0)
    normalizer.close({ status: 'interrupted' })
    ids.clear()
    expect(normalizer.state).toEqual({
      messages: 0,
      textBytes: 0,
      tools: 0,
      activeTasks: 0,
    })
    expect(ids.size).toBe(0)
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
  it.each(['count', 'bytes'] as const)(
    'preserves identity batches on %s overflow and admits an exact later batch',
    (limit) => {
      const ids = new Identities()
      const existing = 'existing'
      ids.add(existing)
      const count = limit === 'count' ? LIMITS.identities - 2 : 63
      for (let i = 0; i < count; i++)
        ids.add(
          String(i).padEnd(limit === 'count' ? 4 : LIMITS.stringBytes, 'x'),
        )
      const before = { size: ids.size, bytes: ids.retainedBytes }
      const last =
        limit === 'count'
          ? 'last'
          : 'y'.repeat(LIMITS.identityBytes - ids.retainedBytes)
      expect(() => ids.add(existing, last, last, 'overflow')).toThrow(
        limit === 'count' ? 'identity limit' : 'identity byte limit',
      )
      expect({ size: ids.size, bytes: ids.retainedBytes }).toEqual(before)
      ids.add(existing, existing)
      expect({ size: ids.size, bytes: ids.retainedBytes }).toEqual(before)
      ids.add(existing, last, last)
      expect(ids.size).toBe(before.size + 1)
      expect(ids.retainedBytes).toBe(before.bytes + Buffer.byteLength(last))
      if (limit === 'count') expect(ids.size).toBe(LIMITS.identities)
      else expect(ids.retainedBytes).toBe(LIMITS.identityBytes)
      ids.add(last, existing)
      expect(ids.size).toBe(before.size + 1)
      expect(ids.retainedBytes).toBe(before.bytes + Buffer.byteLength(last))
      ids.clear()
      expect(ids.size).toBe(0)
      expect(ids.retainedBytes).toBe(0)
    },
  )

  it.each([0, 1])(
    'rejects an oversized batch key at position %s atomically',
    (position) => {
      const ids = new Identities()
      ids.add('existing')
      const keys = ['first', 'last']
      keys[position] = 'é'.repeat(LIMITS.stringBytes / 2 + 1)
      expect(() => ids.add('existing', ...keys)).toThrow('identity byte limit')
      expect(ids.size).toBe(1)
      expect(ids.retainedBytes).toBe(Buffer.byteLength('existing'))
      ids.add('first', 'last', 'existing', 'first')
      expect(ids.size).toBe(3)
      expect(ids.retainedBytes).toBe(Buffer.byteLength('existingfirstlast'))
    },
  )

  it.each([false, true])(
    'charges colon-containing tool names per record, streamed=%s',
    (streamed) => {
      const { normalizer, events, ids } = setup()
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
          const before = { size: ids.size, bytes: ids.retainedBytes }
          normalizer.content(start, owner)
          expect({ size: ids.size, bytes: ids.retainedBytes }).toEqual(before)
          normalizer.content(
            {
              type: 'stream_event',
              event: { type: 'content_block_stop', index: 0 },
            },
            owner,
          )
        }
        normalizer.content(frame, owner)
        const before = { size: ids.size, bytes: ids.retainedBytes }
        normalizer.content(frame, owner)
        expect({ size: ids.size, bytes: ids.retainedBytes }).toEqual(before)
      }
      expect(
        events
          .filter((event) => event.type === 'tool_started')
          .map((event) => ({ id: event.toolCallId, name: event.name })),
      ).toEqual(records.map(({ id, name }) => ({ id, name })))
      const keys = [...(ids as unknown as { values: Set<string> }).values]
      expect(keys.filter((key) => key.startsWith('tool-name:'))).toHaveLength(3)
      expect(
        keys.filter((key) => key.startsWith('block-tool-name:')),
      ).toHaveLength(streamed ? 3 : 0)
      normalizer.finishOwner(owner)
      expect(normalizer.state.tools).toBe(3)
      expect(normalizer.retainedInputBytes).toBe(0)
      normalizer.close({ status: 'interrupted' })
      ids.clear()
      expect(normalizer.state.tools).toBe(0)
      expect(ids.retainedBytes).toBe(0)
    },
  )

  it.each([false, true])(
    'admits exact tool-name key bytes and rejects one extra byte, streamed=%s',
    (streamed) => {
      for (const overflow of [0, 1]) {
        const { normalizer, ids } = setup()
        const prefix = streamed
          ? 'block-tool-name:3:a:b:0:'
          : 'tool-name:3:a:b:'
        const name = 'n'.repeat(
          LIMITS.stringBytes - Buffer.byteLength(prefix) + overflow,
        )
        const input = { type: 'tool_use', id: 'a:b', name, input: {} }
        normalizer.content(
          {
            type: 'stream_event',
            event: { type: 'message_start', message: { id: 'a:b' } },
          },
          owner,
        )
        const admit = () =>
          normalizer.content(
            streamed
              ? {
                  type: 'stream_event',
                  event: {
                    type: 'content_block_start',
                    index: 0,
                    content_block: input,
                  },
                }
              : { type: 'assistant', message: { id: 'a:b', content: [input] } },
            owner,
          )
        if (overflow) {
          expect(admit).toThrow('identity byte limit')
          expect(normalizer.state.tools).toBe(0)
          expect(normalizer.retainedInputBytes).toBe(0)
        } else {
          expect(admit).not.toThrow()
          expect([
            ...(ids as unknown as { values: Set<string> }).values,
          ]).toContain(prefix + name)
          if (streamed)
            normalizer.content(
              {
                type: 'stream_event',
                event: { type: 'content_block_stop', index: 0 },
              },
              owner,
            )
          expect(normalizer.state.tools).toBe(1)
        }
        normalizer.close({ status: 'interrupted' })
        ids.clear()
        expect(normalizer.state.tools).toBe(0)
        expect(ids.retainedBytes).toBe(0)
      }
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

  it('bounds required identity bytes without silently evicting ownership', () => {
    const { ids } = setup()
    expect(() => ids.add('x'.repeat(64 * 1024 + 1))).toThrow(
      'identity byte limit',
    )
    expect(ids.size).toBe(0)
    for (let i = 0; i < 64; i++) ids.add(String(i).padEnd(64 * 1024, 'x'))
    expect(ids.retainedBytes).toBe(4 * MiB)
    expect(() => ids.add('overflow')).toThrow('identity byte limit')
    ids.add('0'.padEnd(64 * 1024, 'x'))
    expect(ids.size).toBe(64)
    expect(ids.retainedBytes).toBe(4 * MiB)
    ids.clear()
    expect(ids.retainedBytes).toBe(0)
    ids.add('after-clear')
    expect(ids.size).toBe(1)
  })

  it.each([false, true])(
    'bounds streamed and full tool names, streamed=%s',
    (streamed) => {
      const { normalizer, ids } = setup()
      const name = 'x'.repeat(64 * 1024)
      const input = { type: 'tool_use', id: 'tool', name, input: {} }
      normalizer.content(
        {
          type: 'stream_event',
          event: { type: 'message_start', message: { id: 'message' } },
        },
        owner,
      )
      expect(() =>
        normalizer.content(
          streamed
            ? {
                type: 'stream_event',
                event: {
                  type: 'content_block_start',
                  index: 0,
                  content_block: input,
                },
              }
            : {
                type: 'assistant',
                message: { id: 'message', content: [input] },
              },
          owner,
        ),
      ).toThrow('identity byte limit')
      expect(normalizer.state.tools).toBe(0)
      expect(normalizer.retainedInputBytes).toBe(0)
      normalizer.close({ status: 'interrupted' })
      ids.clear()
      expect(ids.retainedBytes).toBe(0)
    },
  )

  it.each([false, true])(
    'charges each retained tool name through terminal ownership, repeated=%s',
    (repeated) => {
      const { normalizer, ids } = setup()
      let admitted = 0
      expect(() => {
        for (let i = 0; i < 128; i++) {
          normalizer.content(
            {
              type: 'assistant',
              message: {
                id: `message-${i}`,
                content: [
                  {
                    type: 'tool_use',
                    id: `tool-${i}`,
                    name: String(repeated ? 0 : i).padEnd(63 * 1024, 'n'),
                    input: {},
                  },
                ],
              },
            },
            owner,
          )
          normalizer.finishOwner(owner)
          admitted++
        }
      }).toThrow('identity byte limit')
      expect(admitted).toBeGreaterThan(1)
      expect(admitted).toBeLessThan(128)
      expect(ids.retainedBytes).toBeLessThanOrEqual(4 * MiB)
      const before = ids.retainedBytes
      normalizer.finishOwner(owner)
      expect(ids.retainedBytes).toBe(before)
      normalizer.close({ status: 'interrupted' })
      ids.clear()
      expect(normalizer.state.tools).toBe(0)
      expect(ids.retainedBytes).toBe(0)
    },
  )

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
