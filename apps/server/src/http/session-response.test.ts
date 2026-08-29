import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { sessionRoutes } from './sessions.js'

describe('session REST responses', () => {
  it('returns accountId in camelCase for session reads and lists', async () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, project_id TEXT, harness TEXT, title TEXT, cwd TEXT,
        worktree_path TEXT, provider_session_id TEXT, kind TEXT, retention TEXT,
        parent_session_id TEXT, forked_at_seq INTEGER, spawned_by_seq INTEGER,
        epic_run_id TEXT, account_id TEXT, model TEXT, status TEXT, auto_resume INTEGER,
        created_at INTEGER, last_activity_at INTEGER, deleted_at INTEGER
      );
      INSERT INTO sessions VALUES
        ('session', 'project', 'claude', 'Chat', '/tmp', NULL, NULL, 'chat',
         'permanent', NULL, NULL, NULL, NULL, 'account-2', 'model-2', 'idle', 0, 10, 20, NULL);
    `)
    const manager = {
      database: db,
      list: () => db.prepare('SELECT * FROM sessions').all(),
      models: () => [],
    } as never
    const app = sessionRoutes(manager)

    expect(
      await (await app.request('/api/sessions/session')).json(),
    ).toMatchObject({
      accountId: 'account-2',
      projectId: 'project',
      model: 'model-2',
    })
    expect(await (await app.request('/api/sessions')).json()).toEqual([
      expect.objectContaining({ accountId: 'account-2' }),
    ])
    expect(
      await (await app.request('/api/sessions/session/models')).json(),
    ).toEqual({ models: [] })
    db.close()
  })
})
