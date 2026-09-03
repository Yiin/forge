import { Hono } from 'hono'
import { listSkills } from '../skills/registry.js'
import type { DatabaseSync } from 'node:sqlite'

export function skillRoutes(db: DatabaseSync, globalRoot?: string) {
  const app = new Hono()
  app.get('/api/sessions/:id/skills', async (c) => {
    const row = db
      .prepare('SELECT cwd FROM sessions WHERE id = ?')
      .get(c.req.param('id')) as { cwd: string } | undefined
    if (!row) return c.json({ error: 'Session not found' }, 404)
    return c.json({ skills: await listSkills(row.cwd, globalRoot) })
  })
  app.get('/api/projects/:id/skills', async (c) => {
    const row = db
      .prepare('SELECT path FROM projects WHERE id = ?')
      .get(c.req.param('id')) as { path: string } | undefined
    if (!row) return c.json({ error: 'Project not found' }, 404)
    return c.json({ skills: await listSkills(row.path, globalRoot) })
  })
  return app
}
