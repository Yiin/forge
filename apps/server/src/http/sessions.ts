import { Hono, type Context } from 'hono'
import {
  createSession as schema,
  prompt as promptSchema,
  promoteDraft as promoteDraftSchema,
  answerQuestion as answerSchema,
} from '@forge/protocol/commands'
import type { SessionManager } from '../sessions/manager.js'
import type { UploadStore } from '../uploads/store.js'

export function sessionRoutes(manager: SessionManager, uploads?: UploadStore) {
  const app = new Hono()
  app.post('/api/sessions', async (c) => {
    const value = schema.safeParse(await c.req.json())
    if (!value.success) return c.json({ error: value.error.message }, 400)
    try {
      return c.json(manager.create(value.data), 201)
    } catch (error) {
      return c.json({ error: String(error) }, 400)
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
      return c.json({ error: String(error) }, 400)
    }
  })
  app.get('/api/sessions', (c) =>
    c.json(
      manager.list(c.req.query('projectId'), c.req.query('parentSessionId')),
    ),
  )
  app.get('/api/sessions/:id', (c) => {
    const row = manager.database
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(c.req.param('id'))
    return row ? c.json(row) : c.json({ error: 'Session not found' }, 404)
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
      )
      return c.json({ ok: true })
    } catch (error) {
      return c.json({ error: String(error) }, 404)
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
