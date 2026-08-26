import { describe, expect, it } from 'vitest'
import type { Message } from '@forge/protocol/message'
import { toRenderModel } from './render-model'

const message = (
  content: Message['content'],
  overrides: Partial<Message> = {},
): Message => ({
  seq: 1,
  sessionId: 's',
  turnId: 't',
  itemId: 'i',
  role: 'agent',
  createdAt: 'now',
  type: content.type,
  content,
  ...overrides,
})

describe('chat render model', () => {
  it('keeps progressive text under one stable item key', () => {
    expect(
      toRenderModel([
        message({ type: 'text_delta', text: 'hel' }),
        message({ type: 'text_delta', text: 'lo' }),
      ]),
    ).toEqual([
      { kind: 'message', id: 'i', seq: 1, role: 'agent', text: 'hello' },
    ])
  })
  it('folds tool states and preserves input and output', () => {
    const items = toRenderModel([
      message({
        type: 'tool_call',
        toolCallId: 'tool',
        name: 'shell',
        input: 'ls',
      }),
      message({ type: 'tool_update', toolCallId: 'tool', status: 'running' }),
      message({
        type: 'tool_result',
        toolCallId: 'tool',
        output: 'ok',
        isError: false,
      }),
    ])
    expect(items).toEqual([
      {
        kind: 'tool',
        id: 'i',
        name: 'shell',
        state: 'done',
        input: 'ls',
        output: 'ok',
      },
    ])
  })
  it('makes interruption and recap visible system rows', () => {
    expect(
      toRenderModel(
        [message({ type: 'turn_interrupted', reason: 'cancelled' })],
        true,
      ),
    ).toEqual([
      { kind: 'system', id: 'resumed-recap', text: 'Resumed with recap' },
      { kind: 'system', id: 'i', text: 'Turn interrupted: cancelled' },
    ])
  })
})
