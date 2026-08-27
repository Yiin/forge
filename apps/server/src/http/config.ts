import { Hono } from 'hono'
import { accountRoot } from '../accounts/store.js'

export function serverConfigRoutes() {
  const app = new Hono()
  app.get('/api/config', (c) => c.json({ accountsDir: accountRoot() }))
  return app
}
