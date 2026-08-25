import { serve, type ServerType } from '@hono/node-server'
import { Hono } from 'hono'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { version } = require('../package.json') as { version: string }

export function createApp() {
  const app = new Hono()

  app.get('/api/health', (c) => c.json({ ok: true, version }))

  return app
}

export function startServer(
  port = Number(process.env.FORGE_PORT ?? 3900),
): ServerType {
  return serve({ fetch: createApp().fetch, port })
}

if (process.env.NODE_ENV !== 'test') {
  startServer()
}
