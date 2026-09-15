import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { migrate } from '../db/migrate.js'
import { createProject, createSession } from '../db/queries.js'
import { EventBus } from '../events/bus.js'
import { NativeInteractions } from './native-interactions.js'
import type { HarnessEvent } from '../harnesses/types.js'

const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})
function fixture(send = async () => {}) {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  migrate(db)
  const project = createProject(db, { name: 'native', path: '/tmp' })
  const session = createSession(db, {
    projectId: project.id,
    harness: 'claude',
    cwd: '/tmp',
    title: 'native',
  })
  const service = new NativeInteractions(db, new EventBus())
  const callback = vi.fn(send)
  const event = {
    type: 'permission_requested',
    runtimeGeneration: 'original-generation',
    runId: 'run',
    turnId: 'turn',
    itemId: 'item',
    request: {
      requestId: 'original-request',
      toolCallId: null,
      title: 'Allow?',
      options: [{ id: 'allow', label: 'Allow' }],
    },
  } as Extract<HarnessEvent, { type: 'permission_requested' }>
  service.register(
    session.id,
    event,
    {
      type: 'ask_user_question',
      questionId: 'original-request',
      questions: [],
    },
    (answer) => {
      if (answer !== 'allow') throw Error('invalid answer')
      return callback
    },
  )
  return {
    db,
    service,
    callback,
    session: session.id,
    event,
    status: () =>
      db.prepare('SELECT status FROM native_interactions').get()?.status,
  }
}
it('joins the original reply and rejects duplicate or foreign answers', async () => {
  let release!: () => void
  const f = fixture(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      }),
  )
  const reply = f.service.answerQuestion(f.session, 'original-request', {
    answer: 'allow',
  })
  expect(f.status()).toBe('replying')
  await expect(
    f.service.answerQuestion(f.session, 'original-request', {
      answer: 'allow',
    }),
  ).rejects.toMatchObject({ status: 409 })
  await expect(
    f.service.answerQuestion('foreign', 'original-request', {
      answer: 'allow',
    }),
  ).rejects.toMatchObject({ status: 410 })
  f.service.retire('original-generation')
  expect(f.status()).toBe('replying')
  release()
  await reply
  expect(f.status()).toBe('submitted')
  expect(f.callback).toHaveBeenCalledTimes(1)
  await expect(
    f.service.answerQuestion(f.session, 'original-request', {
      answer: 'allow',
    }),
  ).rejects.toMatchObject({ status: 410 })
})
it('persists reply admission before invoking the original callback', async () => {
  const f = fixture()
  f.db.exec(
    "CREATE TRIGGER fail_reply BEFORE UPDATE ON native_interactions WHEN NEW.status='replying' BEGIN SELECT RAISE(ABORT,'disk failed'); END",
  )
  await expect(
    f.service.answerQuestion(f.session, 'original-request', {
      answer: 'allow',
    }),
  ).rejects.toThrow('disk failed')
  expect(f.callback).not.toHaveBeenCalled()
  expect(f.status()).toBe('pending')
  f.db.exec('DROP TRIGGER fail_reply')
  await f.service.answerQuestion(f.session, 'original-request', {
    answer: 'allow',
  })
  expect(f.callback).toHaveBeenCalledTimes(1)
})
it('never resends after successful delivery with failed persistence', async () => {
  const f = fixture()
  f.db.exec(
    "CREATE TRIGGER fail_reply BEFORE UPDATE ON native_interactions WHEN NEW.status='submitted' BEGIN SELECT RAISE(ABORT,'disk failed'); END",
  )
  await expect(
    f.service.answerQuestion(f.session, 'original-request', {
      answer: 'allow',
    }),
  ).rejects.toThrow('disk failed')
  expect(f.status()).toBe('replying')
  expect(f.callback).toHaveBeenCalledTimes(1)
  await expect(
    f.service.answerQuestion(f.session, 'original-request', {
      answer: 'allow',
    }),
  ).rejects.toMatchObject({ status: 410 })
})
it('retains captured generation and expires only the original pending request', async () => {
  const f = fixture()
  f.event.runtimeGeneration = 'mutated'
  f.service.retire('mutated')
  expect(f.status()).toBe('pending')
  f.service.retire('original-generation')
  expect(f.status()).toBe('expired')
  await expect(
    f.service.answerQuestion(f.session, 'original-request', {
      answer: 'allow',
    }),
  ).rejects.toMatchObject({ status: 410 })
  expect(f.callback).not.toHaveBeenCalled()
})
it('rejects invalid answers without consuming the original request', async () => {
  const f = fixture()
  await expect(
    f.service.answerQuestion(f.session, 'original-request', {
      answer: 'foreign',
    }),
  ).rejects.toMatchObject({ status: 400 })
  expect(f.status()).toBe('pending')
  expect(f.callback).not.toHaveBeenCalled()
})

it('lists durable request states and expires restart requests without restoring callbacks', async () => {
  const f = fixture()
  expect(f.service.listPending(f.session)).toMatchObject([
    {
      questionId: 'original-request',
      status: 'pending',
      runtimeGeneration: 'original-generation',
    },
  ])
  expect(f.service.listPending('foreign')).toEqual([])
  const restarted = new NativeInteractions(f.db, new EventBus())
  expect(restarted.listPending(f.session)).toMatchObject([
    { questionId: 'original-request', status: 'expired' },
  ])
  await expect(
    restarted.answerQuestion(f.session, 'original-request', {
      answer: 'allow',
    }),
  ).rejects.toMatchObject({ status: 410 })
  expect(f.callback).not.toHaveBeenCalled()
  expect(
    f.db
      .prepare("SELECT turn_id,content FROM messages WHERE type='user_answer'")
      .all(),
  ).toEqual([
    {
      turn_id: 'turn',
      content: JSON.stringify({
        type: 'user_answer',
        questionId: 'original-request',
        expired: true,
      }),
    },
  ])
  new NativeInteractions(f.db, new EventBus())
  expect(
    f.db
      .prepare("SELECT count(*) AS n FROM messages WHERE type='user_answer'")
      .get(),
  ).toEqual({ n: 1 })
})
