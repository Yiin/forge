import { Hono } from 'hono'
import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export function fsBrowseRoutes() {
  const app = new Hono()
  app.get('/api/fs', async (c) => {
    try {
      const dir = await realpath(c.req.query('path') ?? homedir())
      const info = await stat(dir)
      if (!info.isDirectory()) throw new Error('Invalid path')
      const entries = await readdir(dir, { withFileTypes: true })
      const result = entries
        .filter((entry) => entry.isDirectory() && entry.name !== '.git')
        .map((entry) => ({ name: entry.name, path: join(dir, entry.name) }))
      result.sort((a, b) => a.name.localeCompare(b.name))
      const parent = dirname(dir)
      return c.json({
        path: dir,
        parent: parent === dir ? null : parent,
        entries: result,
      })
    } catch {
      return c.json({ error: 'Invalid path' }, 400)
    }
  })
  return app
}
