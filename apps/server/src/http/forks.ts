import { Hono } from 'hono'
import { fork as forkSchema } from '@forge/protocol/commands'
import type { SessionManager } from '../sessions/manager.js'
import { errorMessage } from '../error-message.js'

export function forkRoutes(manager: SessionManager) {
  const app = new Hono()
  app.post('/api/sessions/:id/fork', async (c) => {
    const value = forkSchema.safeParse({
      ...(await c.req.json()),
      sessionId: c.req.param('id'),
    })
    if (!value.success) return c.json({ error: value.error.message }, 400)
    try {
      const result = await manager.fork(
        value.data,
        c.req.header('Idempotency-Key'),
      )
      return c.json(result, 201)
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400)
    }
  })
  return app
}
