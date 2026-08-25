import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/index.js'
import { EventBus } from '../src/events/bus.js'
import { UploadStore } from '../src/uploads/store.js'

const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'forge-app-routes-'))
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE epic_runs (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    INSERT INTO projects VALUES ('project', '${dataDir}');
    INSERT INTO sessions VALUES ('session', 'project', 'idle');
  `)
  const store = new UploadStore(db, { dataDir, bus: new EventBus() })
  cleanups.push(() => store.close())
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }))
  return { db, store, dataDir }
}

describe('createApp route composition', () => {
  it('serves status, upload, attachment and project file routes together', async () => {
    const { db, store } = await fixture()
    const app = createApp(store, {
      db,
      bus: store.eventBus,
      version: 'dev',
      bootId: 'boot',
    })

    const health = await app.request('/api/health')
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ ok: true, version: 'dev', db: 'ok' })

    const status = await app.request('/api/status')
    expect(status.status).toBe(200)

    // Attachment and project-file routes are mounted: they answer with their
    // own errors, not the Hono 404 for an unmounted path.
    const attachment = await app.request('/api/attachments/att_missing')
    expect(attachment.status).toBe(404)
    expect(await attachment.json()).toEqual({ error: 'Attachment not found' })

    const files = await app.request('/api/projects/project/files')
    expect(files.status).toBe(200)
    expect(await files.json()).toEqual([])
  })

  it('falls back to a plain health route with no status options', async () => {
    const app = createApp()
    const health = await app.request('/api/health')
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ ok: true, version: '0.1.0' })
  })
})
