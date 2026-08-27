import { Hono } from 'hono'
import {
  createHarnessAccountSchema,
  patchHarnessAccountSchema,
} from '@forge/protocol/accounts'
import {
  accountAuthenticated,
  clearAccountCredentials,
  HarnessAccountStore,
} from '../accounts/store.js'
import { clearAccountLimits } from '../accounts/limits.js'
import { LoginManager } from '../accounts/login.js'
import type { UsagePoller } from '../accounts/usagePoller.js'
import type { EventBus } from '../events/bus.js'
import type { ConfigState } from '../config.js'

export function harnessAccountRoutes(
  db: { prepare(sql: string): any },
  options?: {
    bus?: EventBus
    configState?: ConfigState
    loginManager?: LoginManager
    usagePoller?: UsagePoller
  },
) {
  const store = new HarnessAccountStore(db)
  const login =
    options?.loginManager ??
    (options?.bus && options.configState
      ? new LoginManager(
          store,
          options.bus,
          (key) => options.configState!.current.harness[key],
        )
      : undefined)
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
  app.post('/api/harness-accounts/:id/logout', async (c) => {
    const account = store.get(c.req.param('id'))
    if (!account) return c.json({ error: 'Account not found' }, 404)
    let deleteAccountHome = false
    try {
      const body = await c.req.json<{ deleteAccountHome?: boolean }>()
      deleteAccountHome = body.deleteAccountHome === true
    } catch {
      // An empty POST body is valid.
    }
    try {
      if (deleteAccountHome) store.resetHome(account.id)
      else clearAccountCredentials(account.kind, account.homePath)
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        400,
      )
    }
    return c.json({
      authenticated: accountAuthenticated(account.kind, account.homePath),
    })
  })
  app.post('/api/harness-accounts/:id/clear-cooldown', (c) => {
    const account = store.get(c.req.param('id'))
    if (!account) return c.json({ error: 'Account not found' }, 404)
    clearAccountLimits(db, account.id)
    return c.json({ ok: true })
  })
  app.post('/api/harnesses/accounts/:id/usage/refresh', async (c) => {
    if (!options?.usagePoller)
      return c.json({ error: 'Usage polling is unavailable' }, 503)
    if (!store.get(c.req.param('id')))
      return c.json({ error: 'Account not found' }, 404)
    await options.usagePoller.refresh(c.req.param('id'))
    return c.json({ ok: true })
  })
  app.post('/api/harness-accounts/:id/login', async (c) => {
    if (!login) return c.json({ error: 'Login is unavailable' }, 503)
    let body: { provider?: string; method?: string } = {}
    try {
      body = await c.req.json()
    } catch {}
    try {
      return c.json({ loginId: login.start(c.req.param('id'), body) }, 202)
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        400,
      )
    }
  })
  app.get('/api/harness-accounts/logins/:loginId', (c) => {
    const state = login?.get(c.req.param('loginId'))
    return state ? c.json(state) : c.json({ error: 'Login not found' }, 404)
  })
  app.post('/api/harness-accounts/logins/:loginId/respond', async (c) => {
    if (!login) return c.json({ error: 'Login is unavailable' }, 503)
    const body = await c.req.json<{ data?: unknown }>()
    if (typeof body.data !== 'string')
      return c.json({ error: 'data is required' }, 400)
    try {
      login.respond(c.req.param('loginId'), body.data)
      return c.json({ ok: true })
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        400,
      )
    }
  })
  app.post('/api/harness-accounts/logins/:loginId/cancel', (c) => {
    if (!login) return c.json({ error: 'Login is unavailable' }, 503)
    try {
      login.cancel(c.req.param('loginId'))
      return c.json({ ok: true })
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        400,
      )
    }
  })
  ;(app as Hono & { loginManager?: LoginManager }).loginManager = login
  return app
}
