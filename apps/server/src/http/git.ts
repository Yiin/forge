import { Hono } from 'hono'
import type { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import { gitStatus, listRefs } from '../git/repo.js'
import { runGit } from '../git/exec.js'
import { gitRefsPageSchema, gitStatusSchema } from '@forge/protocol/git'

export function gitRoutes(db: DatabaseSync) {
  const app = new Hono()
  const project = (id: string) => db.prepare('SELECT path FROM projects WHERE id = ? AND archived_at IS NULL').get(id) as { path: string } | undefined
  const cwdFor = async (id: string, requested: string | undefined) => {
    const row = project(id)
    if (!row) return { error: 'Project not found' as const, status: 404 as const }
    const root = resolve(row.path)
    const cwd = resolve(requested || root)
    if (cwd === root) return { cwd }
    const listed = await runGit(root, ['worktree', 'list', '--porcelain'], false)
    const allowed = listed.output.split(/\r?\n/).filter((line) => line.startsWith('worktree ')).map((line) => resolve(line.slice('worktree '.length)))
    return allowed.includes(cwd) ? { cwd } : { error: 'cwd is not part of this project' as const, status: 400 as const }
  }
  app.get('/api/projects/:id/git/status', async (c) => {
    const result = await cwdFor(c.req.param('id'), c.req.query('cwd'))
    if ('error' in result) return c.json({ error: result.error }, result.status)
    return c.json(gitStatusSchema.parse(await gitStatus(result.cwd)))
  })
  app.get('/api/projects/:id/git/branches', async (c) => {
    const result = await cwdFor(c.req.param('id'), c.req.query('cwd'))
    if ('error' in result) return c.json({ error: result.error }, result.status)
    const page = await listRefs(result.cwd, {
      query: c.req.query('query'),
      limit: Number(c.req.query('limit') ?? 50),
      cursor: Number(c.req.query('cursor') ?? 0),
    })
    return c.json(gitRefsPageSchema.parse(page))
  })
  return app
}
