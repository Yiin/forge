import { Hono } from 'hono'
import {
  createSession as schema,
  prompt as promptSchema,
  answerQuestion as answerSchema,
} from '@forge/protocol/commands'
import type { SessionManager } from '../sessions/manager.js'

export function sessionRoutes(manager: SessionManager) {
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
  app.get('/api/sessions', (c) =>
    c.json(manager.list(c.req.query('projectId'))),
  )
  app.get('/api/sessions/:id', (c) => {
    const row = manager.database
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(c.req.param('id'))
    return row ? c.json(row) : c.json({ error: 'Session not found' }, 404)
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
  return app
}
