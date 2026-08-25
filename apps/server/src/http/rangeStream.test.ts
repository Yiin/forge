import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../index.js'
import { UploadStore } from '../uploads/store.js'

const resources: Array<{ db: DatabaseSync; store: UploadStore; dir: string }> =
  []

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    resource.store.close()
    resource.db.close()
    await rm(resource.dir, { recursive: true, force: true })
  }
})

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'forge-files-'))
  const project = join(dir, 'project')
  await mkdir(project, { recursive: true })
  const db = new DatabaseSync(':memory:')
  db.exec(
    'CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL); CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL)',
  )
  db.prepare('INSERT INTO projects VALUES (?, ?)').run('project-one', project)
  db.prepare('INSERT INTO sessions VALUES (?, ?)').run(
    'session-one',
    'project-one',
  )
  const store = new UploadStore(db, { dataDir: dir })
  resources.push({ db, store, dir })
  return { db, store, dir, project }
}

describe('range and project file routes', () => {
  it('serves byte ranges, suffix ranges, etags, and dispositions', async () => {
    const { db, store, dir } = await fixture()
    const path = join(dir, 'attachment.bin')
    await writeFile(path, '0123456789')
    db.prepare(
      'INSERT INTO attachments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'att_one',
      'session-one',
      'clip.bin',
      'application/octet-stream',
      10,
      'hash',
      'attachment.bin',
      'complete',
      Date.now(),
    )
    const app = createApp(store)
    const partial = await app.request('/api/attachments/att_one', {
      headers: { Range: 'bytes=2-5' },
    })
    expect(partial.status).toBe(206)
    expect(partial.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(await partial.text()).toBe('2345')
    expect(partial.headers.get('content-disposition')).toMatch(/^attachment/)
    const suffix = await app.request('/api/attachments/att_one', {
      headers: { Range: 'bytes=-3' },
    })
    expect(await suffix.text()).toBe('789')
    const cached = await app.request('/api/attachments/att_one', {
      headers: { 'If-None-Match': '"hash"' },
    })
    expect(cached.status).toBe(304)
  })

  it('lists directories and rejects traversal and symlink escapes', async () => {
    const { store, project, dir } = await fixture()
    await mkdir(join(project, 'z-dir'))
    await writeFile(join(project, 'a.txt'), 'hello')
    await writeFile(join(dir, 'outside.txt'), 'secret')
    await symlink(join(dir, 'outside.txt'), join(project, 'escape.txt'))
    const app = createApp(store)
    const listing = await app.request('/api/projects/project-one/files')
    expect(listing.status).toBe(200)
    expect(await listing.json()).toEqual([
      {
        name: 'z-dir',
        type: 'dir',
        sizeBytes: expect.any(Number),
        mtimeMs: expect.any(Number),
      },
      {
        name: 'a.txt',
        type: 'file',
        sizeBytes: 5,
        mtimeMs: expect.any(Number),
      },
      {
        name: 'escape.txt',
        type: 'file',
        sizeBytes: 6,
        mtimeMs: expect.any(Number),
      },
    ])
    expect(
      (
        await app.request(
          '/api/projects/project-one/file?path=../../etc/passwd',
        )
      ).status,
    ).toBe(400)
    expect(
      (await app.request('/api/projects/project-one/file?path=escape.txt'))
        .status,
    ).toBe(400)
  })

  it('returns invalid ranges without reading the file', async () => {
    const { db, store, dir } = await fixture()
    await writeFile(join(dir, 'attachment.txt'), 'hello')
    db.prepare(
      'INSERT INTO attachments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'att_two',
      'session-one',
      'note.txt',
      'text/plain',
      5,
      null,
      'attachment.txt',
      'complete',
      Date.now(),
    )
    const response = await createApp(store).request(
      '/api/attachments/att_two',
      { headers: { Range: 'bytes=99-100' } },
    )
    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBe('bytes */5')
  })
})
