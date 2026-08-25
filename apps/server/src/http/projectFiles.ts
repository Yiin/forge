import { Hono } from 'hono'
import { readdir, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { fileResponse } from './rangeStream.js'

const MIME: Record<string, string> = {
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.gif': 'image/gif',
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ts': 'text/typescript',
  '.txt': 'text/plain',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
}

async function safePath(rootInput: string, input: string, directory?: boolean) {
  if (isAbsolute(input) || input.includes('\0')) throw new Error('Invalid path')
  const root = await realpath(rootInput)
  const path = await realpath(resolve(root, input || '.'))
  if (path !== root && !path.startsWith(`${root}/`))
    throw new Error('Invalid path')
  const info = await stat(path)
  if (directory !== undefined && info.isDirectory() !== directory)
    throw new Error('Invalid path')
  return { path, info }
}

export function projectFileRoutes(db: DatabaseSync) {
  const app = new Hono()
  const root = (id: string) => {
    const row = db.prepare('SELECT path FROM projects WHERE id = ?').get(id) as
      { path: string } | undefined
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
