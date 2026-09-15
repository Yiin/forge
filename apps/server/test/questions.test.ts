import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { NativeInteractions } from '../src/sessions/native-interactions.js'
import { questionRoutes } from '../src/http/questions.js'
import { EventBus } from '../src/events/bus.js'
import { migrate } from '../src/db/migrate.js'
import { createProject, createSession } from '../src/db/queries.js'

test('routes cancellation to the original request and lists its durable outcome', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    migrate(db)
    const project = createProject(db, { name: 'Forge', path: '/tmp/forge' })
    const session = createSession(db, {
      projectId: project.id,
      harness: 'custom',
      title: 'Chat',
      cwd: '/tmp',
    })
    const interactions = new NativeInteractions(db, new EventBus())
    const callback = vi.fn(async () => {})
    const prepare = vi.fn((_answer: unknown, cancelled: boolean) => {
      expect(cancelled).toBe(true)
      return callback
    })
    interactions.register(
      session.id,
      {
        type: 'permission_requested',
        runtimeGeneration: 'generation',
        deliveryId: 'delivery',
        runId: 'run',
        turnId: 'turn',
        itemId: 'item',
        request: {
          requestId: 'request',
          toolCallId: null,
          title: 'Allow?',
          options: [{ id: 'allow', label: 'Allow' }],
        },
      },
      { type: 'ask_user_question', questionId: 'request', questions: [] },
      prepare,
    )
    const app = questionRoutes(interactions)
    const path = `/api/sessions/${session.id}/questions`
    expect(await (await app.request(path)).json()).toMatchObject({
      questions: [{ questionId: 'request', status: 'pending' }],
    })
    const response = await app.request(`${path}/request/cancel`, {
      method: 'POST',
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ cancelled: true })
    expect(callback).toHaveBeenCalledTimes(1)
    expect(
      (await app.request(`${path}/request/cancel`, { method: 'POST' })).status,
    ).toBe(410)
    expect(await (await app.request(path)).json()).toMatchObject({
      questions: [{ questionId: 'request', status: 'cancelled' }],
    })
    expect(
      db.prepare("SELECT content FROM messages WHERE type='user_answer'").get(),
    ).toMatchObject({ content: expect.stringContaining('"cancelled":true') })
  } finally {
    db.close()
  }
})
