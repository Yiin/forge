import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_UPLOAD_BYTES, UploadStore } from './store.js'

const resources: Array<{ store: UploadStore; db: DatabaseSync; dir: string }> = []

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    resource.store.close()
    resource.db.close()
    await rm(resource.dir, { recursive: true, force: true })
  }
})

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'forge-upload-'))
  const db = new DatabaseSync(':memory:')
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY); CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL);")
  db.prepare('INSERT INTO projects VALUES (?)').run('project-one')
  db.prepare('INSERT INTO sessions VALUES (?, ?)').run('session-one', 'project-one')
  const store = new UploadStore(db, { dataDir: dir })
  resources.push({ store, db, dir })
  return { store, db, dir }
}

describe('UploadStore', () => {
  it('streams a body to disk and appends an ordered attachment reference', async () => {
    const { store, db, dir } = await fixture()
    const body = new TextEncoder().encode('hello upload')
    const init = store.init('session-one', { filename: '../Read Me.TXT', mime: 'text/plain', sizeBytes: body.byteLength })
    const result = await store.put(init.attachmentId, new ReadableStream({ start(controller) { controller.enqueue(body); controller.close() } }))
    const row = store.attachment(init.attachmentId)
    expect(row?.status).toBe('complete')
    expect(row?.sha256).toBe(result.sha256)
    expect(result.seq).toBe(1)
    expect(await readFile(join(dir, result.relPath), 'utf8')).toBe('hello upload')
    expect(JSON.parse((db.prepare('SELECT content FROM messages WHERE seq = ?').get(result.seq) as { content: string }).content)).toMatchObject({ attachmentId: init.attachmentId, filename: '../Read Me.TXT', sizeBytes: body.byteLength })
  })

  it('rejects a declared upload over 1 GiB before writing', async () => {
    const { store } = await fixture()
    expect(() => store.init('session-one', { filename: 'large.bin', mime: 'application/octet-stream', sizeBytes: MAX_UPLOAD_BYTES + 1 })).toThrow(/1 GiB/)
  })

  it('publishes progress through the ephemeral bus', async () => {
    const { store } = await fixture()
    const events: unknown[] = []
    store.eventBus.subscribe((event) => events.push(event))
    const init = store.init('session-one', { filename: 'small.bin', mime: 'application/octet-stream', sizeBytes: 1 })
    await store.put(init.attachmentId, new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.close() } }))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'uploadProgress', seq: null, bytesReceived: 1 })
  })

  it('sweeps stale pending files without touching complete files', async () => {
    const { store, db, dir } = await fixture()
    const old = Date.now() - 25 * 60 * 60 * 1000
    db.prepare('INSERT INTO attachments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('att_stale', 'session-one', 'old.txt', 'text/plain', 3, null, null, 'pending', old)
    db.prepare('INSERT INTO attachments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('att_complete', 'session-one', 'keep.txt', 'text/plain', 4, 'hash', 'keep', 'complete', old)
    await mkdir(join(dir, 'projects/project-one/sessions/session-one/files'), { recursive: true })
    await writeFile(join(dir, 'projects/project-one/sessions/session-one/files/att_stale-old-txt'), 'old')
    await writeFile(join(dir, 'projects/project-one/sessions/session-one/files/keep'), 'keep')
    expect(await store.sweep()).toBe(1)
    expect(store.attachment('att_stale')).toBeUndefined()
    expect(store.attachment('att_complete')?.status).toBe('complete')
    await expect(readFile(join(dir, 'projects/project-one/sessions/session-one/files/keep'), 'utf8')).resolves.toBe('keep')
  })
})
