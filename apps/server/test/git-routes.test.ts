import { describe, expect, test } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createApp } from '../src/index.js'
import { migrate } from '../src/db/migrate.js'
import { UploadStore } from '../src/uploads/store.js'

describe('git routes', () => {
  test('returns status and refs, and rejects outside cwd', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const projectPath = await mkdtemp(`${tmpdir()}/forge-project-`)
    const outside = await mkdtemp(`${tmpdir()}/forge-outside-`)
    try {
      await mkdir(`${projectPath}/.git`)
      db.prepare('INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)').run('p1', 'Project', projectPath, 1)
      const app = createApp(new UploadStore(db, { dataDir: projectPath }))
      const status = await app.request('/api/projects/p1/git/status')
      expect(status.status).toBe(200)
      expect(await status.json()).toMatchObject({ isRepo: false })
      expect((await app.request('/api/projects/p1/git/branches')).status).toBe(200)
      expect((await app.request(`/api/projects/p1/git/status?cwd=${encodeURIComponent(outside)}`)).status).toBe(400)
      expect((await app.request('/api/projects/missing/git/status')).status).toBe(404)
    } finally {
      await rm(projectPath, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})
