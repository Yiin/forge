import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { Hono } from 'hono'
import { fileResponse } from './rangeStream.js'
import { UploadStore } from '../uploads/store.js'

export function attachmentRoutes(store: UploadStore) {
  const app = new Hono()
  app.get('/api/attachments/:id', async (c) => {
    const row = store.attachment(c.req.param('id'))
    if (!row || row.status !== 'complete' || !row.rel_path)
      return c.json({ error: 'Attachment not found' }, 404)
    const path = join(store.dataDir, row.rel_path)
    try {
      await access(path)
      return fileResponse(c.req.raw, {
        path,
        size: row.size_bytes,
        mime: row.mime,
        filename: row.filename,
        etag: row.sha256 ?? undefined,
      })
    } catch {
      return c.json({ error: 'Attachment not found' }, 404)
    }
  })
  return app
}
