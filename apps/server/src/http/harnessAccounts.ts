import { Hono } from 'hono'
import {
  createHarnessAccountSchema,
  patchHarnessAccountSchema,
} from '@forge/protocol/accounts'
import { HarnessAccountStore } from '../accounts/store.js'

export function harnessAccountRoutes(db: { prepare(sql: string): any }) {
  const store = new HarnessAccountStore(db)
  const app = new Hono()
  app.get('/api/harness-accounts', (c) =>
    c.json(store.list(c.req.query('harness'))),
  )
  app.post('/api/harness-accounts', async (c) => {
    const parsed = createHarnessAccountSchema.safeParse(await c.req.json())
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400)
    return c.json(store.create(parsed.data), 201)
  })
  app.patch('/api/harness-accounts/:id', async (c) => {
    const parsed = patchHarnessAccountSchema.safeParse(await c.req.json())
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400)
    const account = store.patch(c.req.param('id'), parsed.data)
    return account
      ? c.json(account)
      : c.json({ error: 'Account not found' }, 404)
  })
  app.delete('/api/harness-accounts/:id', async (c) => {
    let removeHome =
      c.req.query('removeHome') === '1' || c.req.query('removeHome') === 'true'
    try {
      const body = await c.req.json<{ removeHome?: boolean }>()
      removeHome ||= body.removeHome === true
    } catch {
      // An empty DELETE body is valid.
    }
    return store.delete(c.req.param('id'), removeHome)
      ? c.json({ ok: true })
      : c.json({ error: 'Account not found' }, 404)
  })
  return app
}
