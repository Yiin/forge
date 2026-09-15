import { Hono } from 'hono'
import { readdir, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { MIME, safePath } from '../workspace/paths.js'
import { fileResponse } from './rangeStream.js'

export function projectFileRoutes(db: DatabaseSync) {
  const app = new Hono()
  const root = (id: string) => {
    const row = db
      .prepare('SELECT path FROM projects WHERE id = ? AND deleted_at IS NULL')
      .get(id) as { path: string } | undefined
    if (!row) throw new Error('Project not found')
    return row.path
  }
  app.get('/api/projects/:id/files', async (c) => {
    try {
      const dir = await safePath(
        root(c.req.param('id')),
        c.req.query('path') ?? '',
        true,
      )
      const entries = await readdir(dir.path, { withFileTypes: true })
      const result = await Promise.all(
        entries
          .filter((entry) => entry.name !== '.git')
          .map(async (entry) => {
            const info = await stat(join(dir.path, entry.name))
            return {
              name: entry.name,
              type: entry.isDirectory() ? ('dir' as const) : ('file' as const),
              sizeBytes: info.size,
              mtimeMs: info.mtimeMs,
            }
          }),
      )
      result.sort(
        (a, b) =>
          Number(b.type === 'dir') - Number(a.type === 'dir') ||
          a.name.localeCompare(b.name),
      )
      return c.json(result)
    } catch (error) {
      const notFound =
        error instanceof Error && error.message === 'Project not found'
      return c.json(
        { error: notFound ? 'Project not found' : 'Invalid path' },
        notFound ? 404 : 400,
      )
    }
  })
  app.get('/api/projects/:id/file', async (c) => {
    try {
      const file = await safePath(
        root(c.req.param('id')),
        c.req.query('path') ?? '',
      )
      if (!file.info.isFile()) return c.json({ error: 'File not found' }, 404)
      const filename = file.path.split('/').pop() ?? 'file'
      return fileResponse(c.req.raw, {
        path: file.path,
        size: file.info.size,
        mime:
          MIME[extname(file.path).toLowerCase()] ?? 'application/octet-stream',
        filename,
      })
    } catch (error) {
      const notFound =
        error instanceof Error && error.message === 'Project not found'
      return c.json(
        { error: notFound ? 'Project not found' : 'Invalid path' },
        notFound ? 404 : 400,
      )
    }
  })
  return app
}
