import { Hono } from 'hono'
import { btw as btwSchema } from '@forge/protocol/commands'
import type { SessionManager } from '../sessions/manager.js'

export function sideChatRoutes(manager: SessionManager) {
  const app = new Hono()
  app.post('/api/sessions/:id/btw', async (c) => {
    const value = btwSchema.safeParse({
      ...(await c.req.json()),
      sessionId: c.req.param('id'),
    })
    if (!value.success) return c.json({ error: value.error.message }, 400)
    try {
      return c.json(
        await manager.btw({
          ...value.data,
          requestId:
            c.req.header('Idempotency-Key') ?? c.req.header('X-Request-Id'),
        }),
        201,
      )
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        400,
      )
    }
  })
  app.post('/api/sessions/:id/keep', (c) =>
    manager.keep(c.req.param('id'))
      ? c.json({ ok: true })
      : c.json({ error: 'Side chat not found' }, 404),
  )
  app.post('/api/sessions/:id/discard', async (c) =>
    (await manager.discard(c.req.param('id')))
      ? c.json({ ok: true })
      : c.json({ error: 'Side chat not found' }, 404),
  )
  return app
}
