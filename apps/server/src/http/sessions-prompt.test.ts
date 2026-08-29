import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { migrate } from '../db/migrate.js'
import { EventBus } from '../events/bus.js'
import { createProject, createSession } from '../db/queries.js'
import { SessionManager } from '../sessions/manager.js'
import { sessionRoutes } from './sessions.js'

describe('prompt REST lifecycle', () => {
  it('returns after acceptance and keeps request idempotency synchronous', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const project = createProject(db, { name: 'test', path: '/tmp' })
    const session = createSession(db, {
      projectId: project.id,
      harness: 'mock',
      title: 'Chat',
      cwd: '/tmp',
    })
    let resolvePrompt!: () => void
    const promptStarted = new Promise<void>((resolve) => {
      resolvePrompt = resolve
    })
    let promptCalls = 0
    const manager = new SessionManager(
      db,
      new EventBus(),
      () => ({
        spawn: async () => ({
          prompt: () => {
            promptCalls += 1
            return promptStarted
          },
          cancel: () => undefined,
          kill: () => undefined,
        }),
      }),
      undefined,
      () => false,
    )
    const app = sessionRoutes(manager)

    const response = await app.request(`/api/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': 'request-1',
      },
      body: JSON.stringify({ text: 'hello' }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(promptCalls).toBe(1)
    expect(
      db
        .prepare(
          "SELECT type FROM messages WHERE session_id = ? AND type = 'turn_end'",
        )
        .get(session.id),
    ).toBeUndefined()

    const duplicate = await app.request(`/api/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': 'request-1',
      },
      body: JSON.stringify({ text: 'hello again' }),
    })
    expect(duplicate.status).toBe(200)
    expect(promptCalls).toBe(1)

    resolvePrompt()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(
      db
        .prepare(
          "SELECT type FROM messages WHERE session_id = ? AND type = 'turn_end'",
        )
        .get(session.id),
    ).toEqual({ type: 'turn_end' })
    manager.close()
  })
})
