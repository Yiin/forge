import { Hono } from 'hono'
import type { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import { gitStatus, listRefs } from '../git/repo.js'
import {
  deleteMergedTemporaryBranch,
  listWorktrees,
  provisionWorktree,
  removeWorktree,
  WorktreeLimitError,
} from '../git/worktrees.js'
import { runGit } from '../git/exec.js'
import {
  createWorktreeRequestSchema,
  createWorktreeResponseSchema,
  gitRefsPageSchema,
  gitStatusSchema,
  removeWorktreeRequestSchema,
  worktreeListResponseSchema,
} from '@forge/protocol/git'

export function gitRoutes(options: { db: DatabaseSync; dataDir: string }) {
  const { db, dataDir } = options
  const app = new Hono()
  const project = (id: string) =>
    db
      .prepare('SELECT path FROM projects WHERE id = ? AND archived_at IS NULL')
      .get(id) as { path: string } | undefined
  const cwdFor = async (id: string, requested: string | undefined) => {
    const row = project(id)
    if (!row)
      return { error: 'Project not found' as const, status: 404 as const }
    const root = resolve(row.path)
    const cwd = resolve(requested || root)
    if (cwd === root) return { cwd }
    const listed = await runGit(
      root,
      ['worktree', 'list', '--porcelain'],
      false,
    )
    const allowed = listed.output
      .split(/\r?\n/)
      .filter((line) => line.startsWith('worktree '))
      .map((line) => resolve(line.slice('worktree '.length)))
    return allowed.includes(cwd)
      ? { cwd }
      : {
          error: 'cwd is not part of this project' as const,
          status: 400 as const,
        }
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
  app.get('/api/projects/:id/git/worktrees', async (c) => {
    const row = project(c.req.param('id'))
    if (!row) return c.json({ error: 'Project not found' }, 404)
    try {
      const worktrees = await listWorktrees(row.path)
      const enriched = await Promise.all(
        worktrees.map(async (worktree) => ({
          ...worktree,
          dirty: (await gitStatus(worktree.path)).dirty,
          activeSession: Boolean(
            db
              .prepare(
                "SELECT 1 FROM sessions WHERE cwd = ? AND status NOT IN ('archived', 'deleted') LIMIT 1",
              )
              .get(worktree.path),
          ),
        })),
      )
      return c.json(worktreeListResponseSchema.parse({ worktrees: enriched }))
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        400,
      )
    }
  })
  app.post('/api/projects/:id/git/worktrees', async (c) => {
    const row = project(c.req.param('id'))
    if (!row) return c.json({ error: 'Project not found' }, 404)
    try {
      const body = createWorktreeRequestSchema.parse(await c.req.json())
      return c.json(
        createWorktreeResponseSchema.parse(
          await provisionWorktree({
            ...body,
            repoPath: row.path,
            dataDir,
            projectId: c.req.param('id'),
          }),
        ),
        201,
      )
    } catch (error) {
      const status = error instanceof WorktreeLimitError ? error.status : 400
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        status,
      )
    }
  })
  app.delete('/api/projects/:id/git/worktrees', async (c) => {
    const row = project(c.req.param('id'))
    if (!row) return c.json({ error: 'Project not found' }, 404)
    try {
      const body = removeWorktreeRequestSchema.parse(await c.req.json())
      const worktrees = await listWorktrees(row.path)
      if (!worktrees.some((worktree) => worktree.path === body.path))
        return c.json(
          { error: 'path is not a registered worktree of this project' },
          400,
        )
      const target = worktrees.find((worktree) => worktree.path === body.path)!
      const dirty = (await gitStatus(body.path)).dirty
      const activeSession = db
        .prepare(
          "SELECT 1 FROM sessions WHERE cwd = ? AND status != 'archived' LIMIT 1",
        )
        .get(body.path)
      if (activeSession)
        return c.json({ error: 'A session is using this worktree' }, 409)
      await removeWorktree(row.path, body.path, body.force)
      const hasSessionReference = Boolean(
        db
          .prepare(
            "SELECT 1 FROM sessions WHERE status != 'archived' AND (cwd = ? OR worktree_path = ?) LIMIT 1",
          )
          .get(body.path, body.path),
      )
      if (!dirty) {
        const status = await gitStatus(row.path)
        await deleteMergedTemporaryBranch({
          repoPath: row.path,
          branch: target.branch ?? '',
          defaultBranch: status.defaultBranch ?? status.branch,
          hasSessionReference,
        })
      }
      return c.json({ ok: true })
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        400,
      )
    }
  })
  return app
}
