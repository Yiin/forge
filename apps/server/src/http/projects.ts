import { Hono } from 'hono'
import { createProject, getProject } from '../db/queries.js'
import { createProject as createProjectSchema } from '@forge/protocol/commands'
import type { DatabaseSync } from 'node:sqlite'
import type { UploadStore } from '../uploads/store.js'

export function projectRoutes(db: DatabaseSync, uploads?: UploadStore) {
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
          c.req.query('includeArchived') === '1'
            ? 'SELECT * FROM projects ORDER BY created_at DESC'
            : 'SELECT * FROM projects WHERE archived_at IS NULL ORDER BY created_at DESC',
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
  app.post('/api/projects/:id/rename', async (c) => {
    const body = (await c.req.json()) as { name?: string }
    if (!body.name?.trim()) return c.json({ error: 'name is required' }, 400)
    const result = db
      .prepare('UPDATE projects SET name = ? WHERE id = ?')
      .run(body.name.trim(), c.req.param('id')) as { changes?: number }
    if (!result.changes) return c.json({ error: 'Project not found' }, 404)
    return c.json({ ok: true })
  })
  app.delete('/api/projects/:id', async (c) => {
    if (!getProject(db, c.req.param('id')))
      return c.json({ error: 'Project not found' }, 404)
    if (uploads) await uploads.deleteProject(c.req.param('id') ?? '')
    else db.prepare('DELETE FROM projects WHERE id = ?').run(c.req.param('id'))
    return c.json({ ok: true })
  })
  app.get('/api/projects/:id/usage', (c) => {
    if (!uploads || !getProject(db, c.req.param('id')))
      return c.json({ error: 'Project not found' }, 404)
    return c.json(uploads.usage(c.req.param('id')))
  })
  return app
}
