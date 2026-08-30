import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { createProject, createSession } from '../db/queries.js'
import { migrate } from '../db/migrate.js'
import { sessionRoutes } from './sessions.js'

describe('session REST responses', () => {
  it('returns accountId in camelCase for session reads and lists', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const project = createProject(db, { name: 'Project', path: '/tmp' })
    const session = createSession(db, {
      projectId: project.id,
      harness: 'claude',
      title: 'Chat',
      cwd: '/tmp',
      accountId: 'account-2',
    })
    db.prepare('UPDATE sessions SET model = ? WHERE id = ?').run(
      'model-2',
      session.id,
    )
    const manager = {
      database: db,
      list: () => db.prepare('SELECT * FROM sessions').all(),
      models: () => [],
    } as never
    const app = sessionRoutes(manager)

    expect(
      await (await app.request(`/api/sessions/${session.id}`)).json(),
    ).toMatchObject({
      accountId: 'account-2',
      projectId: project.id,
      model: 'model-2',
    })
    expect(await (await app.request('/api/sessions')).json()).toEqual([
      expect.objectContaining({ accountId: 'account-2' }),
    ])
    expect(
      await (await app.request(`/api/sessions/${session.id}/models`)).json(),
    ).toEqual({ models: [] })
    db.close()
  })
})
