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
      answers: { 'question-0': ['name'], 'question-1': 'hidden' },
    })
    await pending
    expect(manager.listPending(session.id)[0]).toMatchObject({
      status: 'submitted',
      answer: { 'question-0': ['name'], 'question-1': '[redacted]' },
    })
    expect(db.prepare('SELECT answer FROM native_interactions').get()).toEqual({
      answer: JSON.stringify({
        'question-0': ['name'],
        'question-1': '[redacted]',
      }),
    })
    expect(
      db
        .prepare("SELECT content FROM messages WHERE type = 'user_answer'")
        .get(),
    ).toEqual({
      content: JSON.stringify({
        type: 'user_answer',
        questionId: 'request-1',
        answers: { 'question-0': ['name'], 'question-1': '[redacted]' },
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
    void first.handleExtension('cursor/ask_question', {
      sessionId: session.id,
      toolCallId: 'request-4',
      questions: [{ prompt: 'Continue again?', options: [] }],
    })
    db.prepare(
      `UPDATE native_interactions SET status = 'replying' WHERE request_id = ?`,
    ).run('request-4')
    const second = new QuestionManager({ db, now: () => 1001 })
    expect(second.listPending(session.id)[0].status).toBe('expired')
    expect(
      db
        .prepare("SELECT content FROM messages WHERE type = 'user_answer'")
        .all(),
    ).toEqual([
      {
        content: JSON.stringify({
          type: 'user_answer',
          questionId: 'request-3',
          expired: true,
        }),
      },
      {
        content: JSON.stringify({
          type: 'user_answer',
          questionId: 'request-4',
          expired: true,
        }),
      },
    ])
    new QuestionManager({ db, now: () => 1002 })
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM messages WHERE type = 'user_answer'",
        )
        .get(),
    ).toEqual({ count: 2 })
    db.close()
  })
})

describe('ACP permission requests', () => {
  const permission = (
    sessionId: string,
    rawInput: unknown,
    title = 'Run command',
  ) =>
    ({
      sessionId,
      toolCall: { toolCallId: 'tool-1', title, rawInput },
      options: [
        { kind: 'allow_once', name: 'Allow once', optionId: 'allow-once' },
        {
          kind: 'allow_always',
          name: 'Allow always',
          optionId: 'allow-always',
        },
        { kind: 'reject_once', name: 'Reject once', optionId: 'reject-once' },
      ],
    }) as unknown as Parameters<QuestionManager['handlePermission']>[0]

  it('keeps a question that arrived on the permission method a question', async () => {
    const { db, session } = fixture()
    const manager = new QuestionManager({ db, now: () => 1000 })
    const pending = manager.handlePermission(
      permission(
        session.id,
        {
          questions: [
            {
              question: 'Pick one',
              options: [{ label: 'First' }, { label: 'Second' }],
            },
          ],
        },
        'AskUserQuestion',
      ),
    )
    const request = manager.listPending(session.id)[0]
    expect(request).toMatchObject({ source: 'permission' })
    expect(request.toolName).toBeUndefined()
    expect(request.toolContext).toBeUndefined()
    expect(request.permissionScope).toBeUndefined()
    expect(request.questions[0].question).toBe('Pick one')

    // The wire only accepts an option the agent offered, never a Forge id.
    const optionId = request.questions[0].options[1].id!
    expect(optionId).not.toBe('allow-once')
    manager.answerQuestion(session.id, request.questionId, {
      answers: { [request.questions[0].id ?? 'question-0']: [optionId] },
    })
    expect(await pending).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    })
    db.close()
  })

  it('keeps a bare tool approval a tool approval and replays its own option', async () => {
    const { db, session } = fixture()
    const manager = new QuestionManager({ db, now: () => 1000 })
    const pending = manager.handlePermission(
      permission(session.id, { command: 'rm -rf /' }),
    )
    const request = manager.listPending(session.id)[0]
    expect(request).toMatchObject({
      source: 'permission',
      toolName: 'Run command',
      toolContext: JSON.stringify({ command: 'rm -rf /' }),
      permissionScope: 'session',
    })
    manager.answerQuestion(session.id, request.questionId, {
      answers: { permission: ['reject-once'] },
    })
    expect(await pending).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject-once' },
    })
    db.close()
  })

  it('cancels when the agent offered nothing to allow', async () => {
    const { db, session } = fixture()
    const manager = new QuestionManager({ db, now: () => 1000 })
    const request = permission(session.id, {
      questions: [
        {
          question: 'Pick one',
          options: [{ label: 'First' }, { label: 'Second' }],
        },
      ],
    })
    // One option, named for neither answer: nothing maps and nothing allows.
    request.options = [
      { kind: 'reject_once', name: 'Reject once', optionId: 'reject-once' },
    ]
    const pending = manager.handlePermission(request)
    const held = manager.listPending(session.id)[0]
    manager.answerQuestion(session.id, held.questionId, {
      answers: {
        [held.questions[0].id ?? 'question-0']: [
          held.questions[0].options[0].id!,
        ],
      },
    })
    expect(await pending).toEqual({ outcome: { outcome: 'cancelled' } })
    db.close()
  })
})

describe('Kimi-shaped permission questions', () => {
  // Kimi sends toolCall.title AskUserQuestion with one allow_once option per
  // answer. See docs/research/acp-capability-matrix.md.
  const kimi = (sessionId: string) =>
    ({
      sessionId,
      toolCall: {
        toolCallId: 'tool-1',
        title: 'AskUserQuestion',
        rawInput: {
          questions: [
            {
              header: 'Task',
              question: 'What should I work on?',
              options: [
                { label: 'A demo task' },
                { label: 'Nothing, just testing' },
                { label: 'Pick ready beads work' },
              ],
            },
          ],
        },
      },
      options: [
        { kind: 'allow_once', name: 'A demo task', optionId: 'answer-1' },
        {
          kind: 'allow_once',
          name: 'Nothing, just testing',
          optionId: 'answer-2',
        },
        {
          kind: 'allow_once',
          name: 'Pick ready beads work',
          optionId: 'answer-3',
        },
      ],
    }) as unknown as Parameters<QuestionManager['handlePermission']>[0]

  it('returns the answer the user chose, not the first allow', async () => {
    const { db, session } = fixture()
    const manager = new QuestionManager({ db, now: () => 1000 })
    const pending = manager.handlePermission(kimi(session.id))
    const held = manager.listPending(session.id)[0]
    manager.answerQuestion(session.id, held.questionId, {
      answers: {
        [held.questions[0].id ?? 'question-0']: [
          held.questions[0].options[1].id!,
        ],
      },
    })
    expect(await pending).toEqual({
      outcome: { outcome: 'selected', optionId: 'answer-2' },
    })
    db.close()
  })

  it('falls back to position when the agent names its options differently', async () => {
    const { db, session } = fixture()
    const manager = new QuestionManager({ db, now: () => 1000 })
    const request = kimi(session.id)
    request.options = request.options.map((option, index) => ({
      ...option,
      name: `Option ${index + 1}`,
    }))
    const pending = manager.handlePermission(request)
    const held = manager.listPending(session.id)[0]
    manager.answerQuestion(session.id, held.questionId, {
      answers: {
        [held.questions[0].id ?? 'question-0']: [
          held.questions[0].options[2].id!,
        ],
      },
    })
    expect(await pending).toEqual({
      outcome: { outcome: 'selected', optionId: 'answer-3' },
    })
    db.close()
  })
})

describe('questions against a plain approval triple', () => {
  it('never answers a third choice with the agent reject option', async () => {
    const { db, session } = fixture()
    const manager = new QuestionManager({ db, now: () => 1000 })
    const request = {
      sessionId: session.id,
      toolCall: {
        toolCallId: 'tool-1',
        title: 'AskUserQuestion',
        rawInput: {
          questions: [
            {
              question: 'Pick one',
              options: [
                { label: 'First' },
                { label: 'Second' },
                { label: 'Third' },
              ],
            },
          ],
        },
      },
      options: [
        { kind: 'allow_once', name: 'Allow once', optionId: 'allow-once' },
        {
          kind: 'allow_always',
          name: 'Allow always',
          optionId: 'allow-always',
        },
        { kind: 'reject_once', name: 'Reject once', optionId: 'reject-once' },
      ],
    } as unknown as Parameters<QuestionManager['handlePermission']>[0]
    const pending = manager.handlePermission(request)
    const held = manager.listPending(session.id)[0]
    manager.answerQuestion(session.id, held.questionId, {
      answers: {
        [held.questions[0].id ?? 'question-0']: [
          held.questions[0].options[2].id!,
        ],
      },
    })
    expect(await pending).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    })
    db.close()
  })
})
