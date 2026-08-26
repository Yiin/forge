import { DatabaseSync } from 'node:sqlite'
import { describe, expect, test } from 'vitest'
import { QuestionError, QuestionManager } from '../src/acp/questions.js'
import { migrate } from '../src/db/migrate.js'

describe('QuestionManager cancellation', () => {
  test('resolves the held question, appends cancellation, and rejects repeats', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const manager = new QuestionManager({ db })
    const response = manager.handleExtension('cursor/ask_question', {
      sessionId: 'session-1',
      toolCallId: 'question-1',
      questions: [{ question: 'Continue?', options: [] }],
    })
    expect(manager.cancelQuestion('session-1', 'question-1')).toEqual({
      cancelled: true,
    })
    await expect(response).resolves.toEqual({ outcome: 'cancelled' })
    expect(
      db
        .prepare("SELECT content FROM messages WHERE type = 'user_answer'")
        .get(),
    ).toMatchObject({ content: expect.stringContaining('"cancelled":true') })
    expect(() => manager.cancelQuestion('session-1', 'question-1')).toThrow(
      new QuestionError(409, 'Question was already answered'),
    )
    expect(() =>
      manager.answerQuestion('session-1', 'question-1', { answer: 'yes' }),
    ).toThrow('Question was already answered')
  })
})
