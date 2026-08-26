import { Hono } from 'hono'
import type { DatabaseSync } from 'node:sqlite'
import { createProject, listSessions } from '../db/queries.js'

export function workspaceRoutes(db: DatabaseSync) {
  const app = new Hono()
  app.get('/api/projects', (c) => {
    const projects = db
      .prepare(
        'SELECT id, name, path FROM projects WHERE archived_at IS NULL ORDER BY name',
      )
      .all()
    return c.json({ projects })
  })
  app.post('/api/projects', async (c) => {
    const body = (await c.req.json()) as { name?: string; path?: string }
    if (!body.name?.trim() || !body.path?.startsWith('/'))
      return c.json({ error: 'name and absolute path are required' }, 400)
    return c.json(
      createProject(db, { name: body.name.trim(), path: body.path }),
    )
  })
  app.get('/api/sessions', (c) => {
    const projectId = c.req.query('projectId')
    return c.json({ sessions: listSessions(db, projectId) })
  })
  app.post('/api/sessions/:id', async (c) => {
    const body = (await c.req.json()) as { title?: string }
    if (!body.title?.trim()) return c.json({ error: 'title is required' }, 400)
    let result
    try {
      result = db
        .prepare('UPDATE sessions SET title = ?, user_titled = 1 WHERE id = ?')
        .run(body.title.trim(), c.req.param('id'))
    } catch {
      result = db
        .prepare('UPDATE sessions SET title = ? WHERE id = ?')
        .run(body.title.trim(), c.req.param('id'))
    }
    if (!result.changes) return c.json({ error: 'Session not found' }, 404)
    return c.json({ ok: true })
  })
  app.post('/api/sessions/:id/settle', async (c) => {
    const body = (await c.req.json()) as { settled?: boolean }
    const status = body.settled ? 'archived' : 'idle'
    const result = db
      .prepare('UPDATE sessions SET status = ? WHERE id = ?')
      .run(status, c.req.param('id'))
    if (!result.changes) return c.json({ error: 'Session not found' }, 404)
    return c.json({ ok: true, status })
  })
  app.post('/api/sessions/:id/delete', (c) => {
    const id = c.req.param('id')
    const session = db.prepare('SELECT id FROM sessions WHERE id = ?').get(id)
    if (!session) return c.json({ error: 'Session not found' }, 404)
    db.prepare(
      'UPDATE sessions SET deleted_at = ?, status = ? WHERE id = ?',
    ).run(Date.now(), 'archived', id)
    return c.json({ ok: true })
  })
  return app
}
