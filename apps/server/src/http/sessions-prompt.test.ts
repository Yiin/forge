import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { migrate } from '../db/migrate.js'
import { EventBus } from '../events/bus.js'
import { createProject, createSession } from '../db/queries.js'
import { SessionManager } from '../sessions/manager.js'
import { sessionRoutes } from './sessions.js'
import { UploadStore } from '../uploads/store.js'

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

    const malformed = await app.request(`/api/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello', clientItemId: 'client_bad' }),
    })
    expect(malformed.status).toBe(400)
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

  it('only removes a worktree when the explicit delete option is set', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const project = createProject(db, { name: 'test', path: '/tmp' })
    const session = createSession(db, {
      projectId: project.id,
      harness: 'mock',
      title: 'Chat',
      cwd: '/tmp/worktree',
      worktreePath: '/tmp/worktree',
    })
    const calls: string[] = []
    const manager = {
      database: db,
      removeSessionWorktree: async (id: string) => {
        calls.push(id)
        return true
      },
    } as unknown as SessionManager
    const store = new UploadStore(db, { dataDir: '/tmp/forge-test-delete' })
    const app = sessionRoutes(manager, store)

    expect(
      (await app.request(`/api/sessions/${session.id}`, { method: 'DELETE' }))
        .status,
    ).toBe(200)
    expect(calls).toEqual([])
    const second = createSession(db, {
      projectId: project.id,
      harness: 'mock',
      title: 'Chat 2',
      cwd: '/tmp/worktree',
      worktreePath: '/tmp/worktree',
    })
    expect(
      (
        await app.request(`/api/sessions/${second.id}?removeWorktree=true`, {
          method: 'DELETE',
        })
      ).status,
    ).toBe(200)
    expect(calls).toEqual([second.id])
    store.close()
    db.close()
  })
})
