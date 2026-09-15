import { describe, expect, it } from 'vitest'
import type { Message } from '@forge/protocol/message'
import { groupActivity, toRenderModel } from './render-model'

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
  it('renders an answered question with the labels the user clicked', () => {
    const items = toRenderModel([
      message(
        {
          type: 'ask_user_question',
          questionId: 'q1',
          question: 'Pick one',
          options: ['First', 'Second'],
        },
        { itemId: 'ask' },
      ),
      message(
        {
          type: 'user_answer',
          questionId: 'q1',
          answers: { 'q1-1': 'q1-1-1' },
        },
        { itemId: 'answer', seq: 2, role: 'user' },
      ),
    ])
    expect(items.at(-1)).toMatchObject({
      kind: 'answered-question',
      question: 'Pick one',
      answer: { 'q1-1': 'First' },
    })
  })

  it('resolves a reused option ID against its own question', () => {
    const items = toRenderModel([
      message(
        {
          type: 'ask_user_question',
          questionId: 'q3',
          questions: [
            {
              id: 'keep',
              question: 'Keep it?',
              options: [{ id: 'yes', label: 'Yes' }],
            },
            {
              id: 'ship',
              question: 'Ship it?',
              options: [{ id: 'yes', label: 'Yes, ship now' }],
            },
          ],
        },
        { itemId: 'ask' },
      ),
      message(
        {
          type: 'user_answer',
          questionId: 'q3',
          answers: { keep: 'yes', ship: 'yes' },
        },
        { itemId: 'answer', seq: 2, role: 'user' },
      ),
    ])
    expect(items.at(-1)).toMatchObject({
      answer: { keep: 'Yes', ship: 'Yes, ship now' },
    })
  })

  it('keeps free text beside the selected option labels', () => {
    const items = toRenderModel([
      message(
        {
          type: 'ask_user_question',
          questionId: 'q2',
          questions: [
            {
              id: 'toppings',
              question: 'Choose toppings',
              options: [
                { id: 'cheese', label: 'Cheese' },
                { id: 'mushrooms', label: 'Mushrooms' },
              ],
              multiSelect: true,
              allowFreeInput: true,
            },
          ],
        },
        { itemId: 'ask' },
      ),
      message(
        {
          type: 'user_answer',
          questionId: 'q2',
          answers: {
            toppings: {
              type: 'selected_with_text',
              optionIds: ['cheese', 'mushrooms'],
              text: 'extra basil',
            },
          },
        },
        { itemId: 'answer', seq: 2, role: 'user' },
      ),
    ])
    expect(items.at(-1)).toMatchObject({
      kind: 'answered-question',
      answer: { toppings: ['Cheese', 'Mushrooms', 'extra basil'] },
    })
  })

  it('groups adjacent tools and agents within one turn', () => {
    const tool = {
      kind: 'tool' as const,
      id: 'tool-1',
      name: 'shell',
      state: 'done' as const,
      input: 'pwd',
      output: '/tmp',
    }
    const agent = {
      kind: 'subagent' as const,
      id: 'subagent-child',
      child: { id: 'child', title: 'Research', status: 'completed' },
    }
    expect(
      groupActivity(
        [tool, agent],
        new Map([['tool-1', 'turn-1']]),
        new Map([['child', 'turn-1']]),
      ),
    ).toEqual([
      {
        kind: 'activity',
        id: 'activity-tool-1',
        turnId: 'turn-1',
        tools: [tool],
        agents: [agent.child],
        state: 'done',
      },
    ])
  })
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
  it('appends pending user messages after server items', () => {
    const items = toRenderModel(
      [message({ type: 'text_delta', text: 'reply' })],
      false,
      [],
      [
        {
          sessionId: 's',
          itemId: 'client_1234567890abcdef1234567890abcdef',
          text: 'hello',
          createdAt: 'now',
        },
      ],
    )
    expect(items.at(-1)).toMatchObject({
      kind: 'message',
      role: 'user',
      text: 'hello',
      pending: true,
    })
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

  it('folds lifecycle events by toolCallId when itemIds differ', () => {
    const items = toRenderModel([
      message(
        {
          type: 'tool_call',
          toolCallId: 'tool-legacy',
          name: 'shell',
          input: 'pwd',
        },
        { itemId: 'call-item' },
      ),
      message(
        { type: 'tool_update', toolCallId: 'tool-legacy', status: 'running' },
        { itemId: 'update-item', seq: 2 },
      ),
      message(
        {
          type: 'tool_result',
          toolCallId: 'tool-legacy',
          output: 'done',
          isError: false,
        },
        { itemId: 'result-item', seq: 3 },
      ),
    ])
    expect(items).toEqual([
      {
        kind: 'tool',
        id: 'call-item',
        name: 'shell',
        state: 'done',
        input: 'pwd',
        output: 'done',
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
      { kind: 'system', id: 'i', text: 'You stopped this turn.' },
    ])
  })
  it('keeps process details available without crowding the error row', () => {
    expect(
      toRenderModel([
        message({
          type: 'error',
          message: 'ACP agent exited with code 1',
          code: 'command not found',
        }),
      ]),
    ).toEqual([
      {
        kind: 'system',
        id: 'i',
        text: 'ACP agent exited with code 1',
        alert: true,
        code: 'command not found',
      },
    ])
  })
  it('keeps epic triage cards in the replay model', () => {
    const items = toRenderModel([
      message({
        type: 'epic_triage',
        runId: 'run-1',
        beadId: 'bead-1',
        attempts: 2,
        classification: 'unknown',
        failureChain: [
          { attempt: 1, signature: 'signature-1', excerpt: 'first failure' },
          { attempt: 2, signature: 'signature-2', excerpt: 'second failure' },
        ],
      }),
    ])
    expect(items).toEqual([
      {
        kind: 'epic-triage',
        id: 'i',
        card: expect.objectContaining({
          runId: 'run-1',
          attempts: 2,
          failureChain: expect.arrayContaining([
            expect.objectContaining({ excerpt: 'second failure' }),
          ]),
        }),
      },
    ])
  })

  it('separates an expired request from a cancelled one', () => {
    const ask = message(
      {
        type: 'ask_user_question',
        questionId: 'q9',
        question: 'Pick one',
        options: ['First'],
      },
      { itemId: 'ask' },
    )
    const expired = toRenderModel([
      ask,
      message(
        { type: 'user_answer', questionId: 'q9', expired: true },
        { itemId: 'answer', seq: 2, role: 'user' },
      ),
    ])
    expect(expired.at(-1)).toMatchObject({
      kind: 'answered-question',
      question: 'Pick one',
      answer: 'Expired',
    })
    const cancelled = toRenderModel([
      ask,
      message(
        { type: 'user_answer', questionId: 'q9', cancelled: true },
        { itemId: 'answer', seq: 2, role: 'user' },
      ),
    ])
    expect(cancelled.at(-1)).toMatchObject({ answer: 'Cancelled' })
  })
})
