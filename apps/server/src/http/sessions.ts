import { Hono, type Context } from 'hono'
import {
  createSession as schema,
  prompt as promptSchema,
  promoteDraft as promoteDraftSchema,
  answerQuestion as answerSchema,
  setSessionWorkspace as workspaceSchema,
} from '@forge/protocol/commands'
import type { SessionManager } from '../sessions/manager.js'
import type { UploadStore } from '../uploads/store.js'
import { errorMessage } from '../error-message.js'
import { sessionResponse, sessionResponses } from './session-response.js'
import { gitStatus } from '../git/repo.js'
import { runGit } from '../git/exec.js'
import { readAccountModels } from '../accounts/models.js'

export function sessionRoutes(manager: SessionManager, uploads?: UploadStore) {
  const app = new Hono()
  app.post('/api/sessions', async (c) => {
    const value = schema.safeParse(await c.req.json())
    if (!value.success) return c.json({ error: value.error.message }, 400)
    try {
      const project = manager.database
        .prepare(
          'SELECT path FROM projects WHERE id = ? AND archived_at IS NULL',
        )
        .get(value.data.projectId) as { path: string } | undefined
      if (!project) return c.json({ error: 'Project not found' }, 404)
      const workspace = await manager.resolveWorkspace(
        value.data.projectId,
        project.path,
        value.data.workspace,
      )
      return c.json(manager.create({ ...value.data, ...workspace }), 201)
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400)
    }
  })
  app.post('/api/drafts/:id/promote', async (c) => {
    const value = promoteDraftSchema.safeParse({
      ...(await c.req.json()),
      draftId: c.req.param('id'),
    })
    const requestId = c.req.header('Idempotency-Key')
    if (!value.success) return c.json({ error: value.error.message }, 400)
    if (!requestId) return c.json({ error: 'Idempotency-Key is required' }, 400)
    try {
      return c.json(
        await manager.promoteDraft(value.data, requestId, uploads),
        201,
      )
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400)
    }
  })
  app.get('/api/sessions', (c) =>
    c.json(
      sessionResponses(
        manager.list(
          c.req.query('projectId'),
          c.req.query('parentSessionId'),
        ) as Array<Record<string, unknown>>,
      ),
    ),
  )
  app.get('/api/sessions/:id', (c) => {
    const row = manager.database
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(c.req.param('id'))
    return row
      ? c.json(sessionResponse(row as Record<string, unknown>))
      : c.json({ error: 'Session not found' }, 404)
  })
  app.get('/api/sessions/:id/messages', (c) => {
    const rows = manager.database
      .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY seq')
      .all(c.req.param('id')) as Array<Record<string, unknown>>
    return c.json(
      rows.map((row) => ({
        seq: row.seq,
        sessionId: row.session_id,
        turnId: row.turn_id,
        itemId: row.item_id,
        role: row.role,
        type: row.type,
        content:
          typeof row.content === 'string'
            ? JSON.parse(row.content)
            : row.content,
        createdAt: new Date(Number(row.created_at)).toISOString(),
      })),
    )
  })
  app.post('/api/sessions/:id/prompt', async (c) => {
    const value = promptSchema.safeParse({
      ...(await c.req.json()),
      sessionId: c.req.param('id'),
    })
    if (!value.success) return c.json({ error: value.error.message }, 400)
    try {
      await manager.prompt(
        value.data.sessionId,
        value.data.text,
        c.req.header('Idempotency-Key'),
        value.data.attachmentIds,
        value.data.harness,
        value.data.accountId,
        value.data.model,
        value.data.clientItemId,
        value.data.configOptions,
      )
      return c.json({ ok: true })
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 404)
    }
  })
  app.get('/api/sessions/:id/models', (c) => {
    const row = manager.database
      .prepare('SELECT id, account_id FROM sessions WHERE id = ?')
      .get(c.req.param('id'))
    return row
      ? c.json({
          models: manager.models(c.req.param('id')).length
            ? manager.models(c.req.param('id'))
            : (readAccountModels(
                manager.database,
                String((row as { account_id?: string | null }).account_id),
              )?.models ?? []),
        })
      : c.json({ error: 'Session not found' }, 404)
  })
  app.get('/api/sessions/:id/config-options', (c) => {
    const row = manager.database
      .prepare('SELECT id FROM sessions WHERE id = ?')
      .get(c.req.param('id'))
    return row
      ? c.json({ configOptions: manager.configOptions(c.req.param('id')) })
      : c.json({ error: 'Session not found' }, 404)
  })
  app.patch('/api/sessions/:id/workspace', async (c) => {
    const value = workspaceSchema.safeParse({
      ...(await c.req.json()),
      sessionId: c.req.param('id'),
    })
    if (!value.success) return c.json({ error: value.error.message }, 400)
    const row = manager.database
      .prepare(
        `SELECT sessions.*, projects.path AS project_path
         FROM sessions JOIN projects ON projects.id = sessions.project_id
         WHERE sessions.id = ? AND sessions.deleted_at IS NULL`,
      )
      .get(value.data.sessionId) as
      (Record<string, unknown> & { project_path: string }) | undefined
    if (!row) return c.json({ error: 'Session not found' }, 404)
    if (row.status === 'running')
      return c.json({ error: 'Session is running' }, 409)
    try {
      if (value.data.mode === 'local' && value.data.branch) {
        const status = await gitStatus(row.project_path)
        if (status.dirty)
          return c.json(
            { error: 'The working tree has uncommitted changes' },
            409,
          )
        await runGit(row.project_path, ['checkout', value.data.branch])
      }
      const workspace = await manager.resolveWorkspace(
        row.project_id as string,
        row.project_path,
        value.data,
      )
      manager.database
        .prepare(
          'UPDATE sessions SET cwd = ?, worktree_path = ?, branch = ? WHERE id = ?',
        )
        .run(
          workspace.cwd,
          workspace.worktreePath,
          workspace.branch,
          value.data.sessionId,
        )
      if (workspace.cwd !== row.cwd)
        await manager.releaseHandle(value.data.sessionId)
      const updated = manager.database
        .prepare('SELECT * FROM sessions WHERE id = ?')
        .get(value.data.sessionId) as Record<string, unknown>
      return c.json(sessionResponse(updated))
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400)
    }
  })
  app.post('/api/sessions/:id/interrupt', async (c) => {
    await manager.interrupt(c.req.param('id'))
    return c.json({ ok: true })
  })
  app.post('/api/sessions/:id/answer', async (c) => {
    const value = answerSchema.safeParse({
      ...(await c.req.json()),
      sessionId: c.req.param('id'),
    })
    if (!value.success) return c.json({ error: value.error.message }, 400)
    // The structured `answers` shape has its own route in http/questions.ts.
    // This route only carries the plain-string form.
    if (value.data.answer === undefined)
      return c.json({ error: 'answer is required' }, 400)
    await manager.answer(
      value.data.sessionId,
      value.data.questionId,
      value.data.answer,
    )
    return c.json({ ok: true })
  })
  const remove = async (c: Context) => {
    const removed = uploads
      ? await uploads.deleteSession(c.req.param('id') ?? '')
      : false
    return removed
      ? c.json({ ok: true })
      : c.json({ error: 'Session not found' }, 404)
  }
  app.delete('/api/sessions/:id', remove)
  return app
}
