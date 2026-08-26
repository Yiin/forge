import { describe, expect, test } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { createApp } from '../src/index.js'
import { migrate } from '../src/db/migrate.js'
import { EventBus } from '../src/events/bus.js'
import { UploadStore } from '../src/uploads/store.js'
import { SessionManager } from '../src/sessions/manager.js'
import { QuestionManager } from '../src/acp/questions.js'

describe('app wiring', () => {
  test('serves project, session and question routes together', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const bus = new EventBus()
    const store = new UploadStore(db, { dataDir: '/tmp/forge-app-wiring', bus })
    const questions = new QuestionManager({ db, bus })
    const manager = new SessionManager(db, bus, () => ({
      spawn: async (_s, _i, onExit) => ({
        prompt: async () => onExit(new Error('none')),
        cancel: () => undefined,
        kill: () => undefined,
      }),
    }))
    const app = createApp(
      store,
      { db, bus, version: 'x', dataDir: '/tmp/forge-app-wiring' },
      questions,
      manager,
    )

    const created = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'p', path: '/tmp' }),
    })
    expect(created.status).toBe(201)
    const project = (await created.json()) as { id: string }

    const session = await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        kind: 'chat',
        harness: 'claude',
        cwd: '/tmp',
      }),
    })
    expect(session.status).toBe(201)
    const { id } = (await session.json()) as { id: string }

    // questions route is mounted (unknown question -> not 404-from-missing-route)
    const answer = await app.request(
      `/api/sessions/${id}/questions/q_1/answer`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answer: 'yes' }),
      },
    )
    expect(answer.status).not.toBe(404)

    // legacy session answer route rejects a body with no plain answer
    const bad = await app.request(`/api/sessions/${id}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ questionId: 'q_1', answers: ['a'] }),
    })
    expect(bad.status).toBe(400)
    manager.close()
  })
})
