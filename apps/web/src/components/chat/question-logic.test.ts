import type { Message } from '@forge/protocol/message'
import { describe, expect, it } from 'vitest'
import { pendingQuestions } from './question-logic'

const question = (
  type: Message['type'],
  content: Message['content'],
  seq: number,
): Message => ({
  seq,
  sessionId: 's',
  turnId: 't',
  itemId: `i-${seq}`,
  role: type === 'user_answer' ? 'user' : 'agent',
  type,
  content,
  createdAt: new Date(0).toISOString(),
})

describe('pendingQuestions', () => {
  it('reconstructs pending questions from replay rows', () => {
    const ask = question(
      'ask_user_question',
      {
        type: 'ask_user_question',
        questionId: 'q',
        questions: [{ question: 'Ready?', options: [{ label: 'Yes' }] }],
      },
      1,
    )
    expect(pendingQuestions([ask])).toHaveLength(1)
    expect(
      pendingQuestions([
        ask,
        question(
          'user_answer',
          { type: 'user_answer', questionId: 'q', answer: 'Yes' },
          2,
        ),
      ]),
    ).toEqual([])
  })

  it('treats a cancelled answer as answered after reconnect', () => {
    const ask = question(
      'ask_user_question',
      {
        type: 'ask_user_question',
        questionId: 'q',
        questions: [{ question: 'Ready?', options: [] }],
      },
      1,
    )
    const cancelled = question(
      'user_answer',
      { type: 'user_answer', questionId: 'q', cancelled: true },
      2,
    )
    expect(pendingQuestions([ask, cancelled])).toEqual([])
  })
})
