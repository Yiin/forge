import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm, writeFile, unlink, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { UploadStore } from './store.js'
import { createNativeAttachmentLoader } from './native.js'

const owned: Array<{
  directory: string
  db: DatabaseSync
  store: UploadStore
}> = []
afterEach(async () => {
  for (const f of owned.splice(0)) {
    f.store.close()
    f.db.close()
    await rm(f.directory, { recursive: true, force: true })
  }
})
async function fixture() {
  const directory = await mkdtemp('/tmp/forge-native-upload-')
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,deleted_at INTEGER);
    CREATE TABLE sessions(id TEXT PRIMARY KEY,project_id TEXT,status TEXT DEFAULT 'idle',deleted_at INTEGER);
    INSERT INTO projects(id) VALUES('project');
    INSERT INTO sessions(id,project_id) VALUES('session','project');`)
  const store = new UploadStore(db, { dataDir: directory })
  owned.push({ directory, db, store })
  const upload = store.init('session', {
    filename: 'pixel.png',
    mime: 'image/png',
    sizeBytes: 3,
  })
  await store.put(
    upload.attachmentId,
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]))
        controller.close()
      },
    }),
  )
  const row = store.attachment(upload.attachmentId)!
  return {
    directory,
    db,
    store,
    id: upload.attachmentId,
    path: join(directory, row.rel_path!),
    load: createNativeAttachmentLoader(db, directory),
    signal: new AbortController().signal,
  }
}
it('loads only the completed original session image through verified descriptors', async () => {
  const f = await fixture()
  const attachment = await f.load('session', f.id, f.signal)
  expect(attachment).toMatchObject({
    mime: 'image/png',
    name: 'pixel.png',
    sizeBytes: 3,
    path: f.path,
    sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  })
  expect(await attachment.readBytes()).toEqual(Buffer.from([1, 2, 3]))
  await expect(f.load('foreign', f.id, f.signal)).rejects.toThrow('unavailable')
})
it.each(['pending', 'deleted-session', 'deleted-project'])(
  'refuses %s ownership',
  async (mode) => {
    const f = await fixture()
    if (mode === 'pending') f.db.exec("UPDATE attachments SET status='pending'")
    if (mode === 'deleted-session')
      f.db.exec('UPDATE sessions SET deleted_at=1')
    if (mode === 'deleted-project')
      f.db.exec('UPDATE projects SET deleted_at=1')
    await expect(f.load('session', f.id, f.signal)).rejects.toThrow(
      'unavailable',
    )
  },
)
it('supports a live projectless session', async () => {
  const f = await fixture()
  f.db.exec('UPDATE sessions SET project_id=NULL')
  expect(await (await f.load('session', f.id, f.signal)).readBytes()).toEqual(
    Buffer.from([1, 2, 3]),
  )
})
it('refuses original ownership changes before deferred reads', async () => {
  const f = await fixture()
  const attachment = await f.load('session', f.id, f.signal)
  f.db.exec("UPDATE attachments SET session_id='foreign'")
  await expect(attachment.readBytes()).rejects.toThrow('ownership changed')
})
it('refuses symlink replacement and modified image bytes', async () => {
  const f = await fixture()
  const attachment = await f.load('session', f.id, f.signal)
  await writeFile(f.path, Buffer.from([4, 5, 6]))
  await expect(attachment.readBytes()).rejects.toThrow('file changed')
  await unlink(f.path)
  await symlink('/etc/hosts', f.path)
  await expect(f.load('session', f.id, f.signal)).rejects.toThrow(
    'regular files',
  )
})
it('refuses stored digest mismatch and aborted readers', async () => {
  const f = await fixture()
  f.db.prepare('UPDATE attachments SET sha256=?').run('0'.repeat(64))
  const attachment = await f.load('session', f.id, f.signal)
  await expect(attachment.readBytes()).rejects.toThrow('contents changed')
  const abort = new AbortController()
  const captured = await f.load('session', f.id, abort.signal)
  abort.abort()
  await expect(captured.readBytes()).rejects.toThrow()
})
