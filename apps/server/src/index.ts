import { serve, type ServerType } from '@hono/node-server'
import { Hono } from 'hono'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { UploadStore } from './uploads/store.js'
import { uploadRoutes } from './http/uploads.js'

const require = createRequire(import.meta.url)
const { version } = require('../package.json') as { version: string }

export function createApp(uploadStore?: UploadStore) {
  const app = new Hono()

  app.get('/api/health', (c) => c.json({ ok: true, version }))
  if (uploadStore) app.route('/', uploadRoutes(uploadStore))

  return app
}

export function startServer(
  port = Number(process.env.FORGE_PORT ?? 3900),
): ServerType {
  const db = new DatabaseSync(process.env.FORGE_DB ?? ':memory:')
  const dataDir = process.env.FORGE_DATA_DIR ?? 'data'
  return serve({
    fetch: createApp(new UploadStore(db, { dataDir })).fetch,
    port,
  })
}

if (process.env.NODE_ENV !== 'test') {
  startServer()
}
