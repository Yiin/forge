import { Hono } from 'hono'
import { createProject, getProject } from '../db/queries.js'
import { createProject as createProjectSchema } from '@forge/protocol/commands'
import type { DatabaseSync } from 'node:sqlite'

export function projectRoutes(db: DatabaseSync) {
  const app = new Hono()
  app.post('/api/projects', async (c) => {
    const value = createProjectSchema.safeParse(await c.req.json())
    if (!value.success) return c.json({ error: value.error.message }, 400)
    return c.json(createProject(db, value.data), 201)
  })
  app.get('/api/projects', (c) =>
    c.json(
      db
        .prepare(
          'SELECT * FROM projects WHERE archived_at IS NULL ORDER BY created_at DESC',
        )
        .all(),
    ),
  )
  app.post('/api/projects/:id/archive', (c) => {
    if (!getProject(db, c.req.param('id')))
      return c.json({ error: 'Project not found' }, 404)
    db.prepare('UPDATE projects SET archived_at = ? WHERE id = ?').run(
      Date.now(),
      c.req.param('id'),
    )
    return c.json({ ok: true })
  })
  app.delete('/api/projects/:id', (c) => {
    if (!getProject(db, c.req.param('id')))
      return c.json({ error: 'Project not found' }, 404)
    db.prepare('DELETE FROM projects WHERE id = ?').run(c.req.param('id'))
    return c.json({ ok: true })
  })
  return app
}
