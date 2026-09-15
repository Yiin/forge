import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { migrate } from '../db/migrate.js'
import { createProject, createSession } from '../db/queries.js'
import { QuestionManager } from './questions.js'

function fixture() {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  const project = createProject(db, { name: 'Forge', path: '/tmp/forge' })
  const session = createSession(db, {
    projectId: project.id,
    harness: 'native',
    title: 'Native',
    cwd: '/tmp',
  })
  return { db, session }
}

describe('durable native interactions', () => {
  it('hydrates a pending grouped form and redacts secret answers', async () => {
    const { db, session } = fixture()
    const manager = new QuestionManager({
      db,
      now: () => 1000,
      runtimeGeneration: 'gen-1',
    })
    const pending = manager.handleExtension('cursor/ask_question', {
      sessionId: session.id,
      toolCallId: 'request-1',
      questions: [
        { prompt: 'Name?', options: [{ id: 'name', label: 'Name' }] },
        { prompt: 'Secret?', options: [], isSecret: true },
      ],
    })
    const hydrated = manager.listPending(session.id)
    expect(hydrated).toHaveLength(1)
    expect(hydrated[0]).toMatchObject({
      questionId: 'request-1',
      runtimeGeneration: 'gen-1',
      status: 'pending',
    })
    expect(() =>
      manager.answerQuestion(session.id, 'request-1', {
        answers: { Unknown: ['value'] },
      }),
    ).toThrow('Unknown answer key')
    manager.answerQuestion(session.id, 'request-1', {
      answers: { 'Name?': ['Ada'], 'Secret?': 'hidden' },
    })
    await pending
    expect(manager.listPending(session.id)[0]).toMatchObject({
      status: 'submitted',
      answer: { 'Name?': ['Ada'], 'Secret?': '[redacted]' },
    })
    expect(db.prepare('SELECT answer FROM native_interactions').get()).toEqual({
      answer: JSON.stringify({ 'Name?': ['Ada'], 'Secret?': '[redacted]' }),
    })
    expect(
      db
        .prepare("SELECT content FROM messages WHERE type = 'user_answer'")
        .get(),
    ).toEqual({
      content: JSON.stringify({
        type: 'user_answer',
        questionId: 'request-1',
        answers: { 'Name?': ['Ada'], 'Secret?': '[redacted]' },
      }),
    })
    db.close()
  })

  it('expires a held request and records the expiry for reload views', async () => {
    const { db, session } = fixture()
    const manager = new QuestionManager({ db, now: () => 1000, expiryMs: 1 })
    const pending = manager.handleExtension('cursor/ask_question', {
      sessionId: session.id,
      toolCallId: 'request-2',
      questions: [{ prompt: 'Continue?', options: [] }],
    })
    await pending
    expect(manager.listPending(session.id)[0].status).toBe('expired')
    expect(db.prepare('SELECT status FROM native_interactions').get()).toEqual({
      status: 'expired',
    })
    db.close()
  })

  it('marks requests from a previous manager as expired', () => {
    const { db, session } = fixture()
    const first = new QuestionManager({ db, now: () => 1000, expiryMs: 60_000 })
    void first.handleExtension('cursor/ask_question', {
      sessionId: session.id,
      toolCallId: 'request-3',
      questions: [{ prompt: 'Continue?', options: [] }],
    })
    const second = new QuestionManager({ db, now: () => 1001 })
    expect(second.listPending(session.id)[0].status).toBe('expired')
    db.close()
  })
})
