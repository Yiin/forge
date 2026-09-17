import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_UPLOAD_BYTES, UploadStore } from './store.js'
import { migrate } from '../db/migrate.js'
import { createProject, createSession } from '../db/queries.js'

const resources: Array<{ store: UploadStore; db: DatabaseSync; dir: string }> =
  []

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
  db.exec(
    `CREATE TABLE projects (id TEXT PRIMARY KEY, deleted_at INTEGER);
     CREATE TABLE sessions (
       id TEXT PRIMARY KEY, project_id TEXT, status TEXT NOT NULL DEFAULT 'idle',
       deleted_at INTEGER
     );`,
  )
  db.prepare('INSERT INTO projects (id) VALUES (?)').run('project-one')
  db.prepare('INSERT INTO sessions (id, project_id) VALUES (?, ?)').run(
    'session-one',
    'project-one',
  )
  const store = new UploadStore(db, { dataDir: dir })
  resources.push({ store, db, dir })
  return { store, db, dir }
}

describe('UploadStore', () => {
  it('stores native output for a live projectless session and rejects deleted project owners', async () => {
    const { store, db, dir } = await fixture()
    db.prepare('INSERT INTO sessions(id, project_id) VALUES (?, NULL)').run(
      'projectless',
    )
    const upload = store.init('projectless', {
      filename: 'output.txt',
      mime: 'text/plain',
      sizeBytes: 5,
    })
    await store.put(upload.attachmentId, new Response('hello').body!)
    const row = store.attachment(upload.attachmentId)!
    expect(row.rel_path).toMatch(/^sessions\/projectless\/files\//)
    expect(await readFile(join(dir, row.rel_path!), 'utf8')).toBe('hello')
    const original = store.init('session-one', {
      filename: 'stale.txt',
      mime: 'text/plain',
      sizeBytes: 1,
    })
    db.prepare('UPDATE projects SET deleted_at = 1').run()
    expect(() =>
      store.init('session-one', {
        filename: 'no.txt',
        mime: 'text/plain',
        sizeBytes: 1,
      }),
    ).toThrow('Session not found')
    await expect(
      store.put(original.attachmentId, new Response('x').body!),
    ).rejects.toThrow('Session not found')
  })

  it('promotes a projectless draft attachment into its filesystem session', async () => {
    const { store, db, dir } = await fixture()
    const draft = store.initDraft('draft:filesystem', undefined, {
      filename: 'notes.txt',
      mime: 'text/plain',
      sizeBytes: 5,
    })
    await store.put(
      draft.attachmentId,
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('hello'))
          controller.close()
        },
      }),
    )

    await store.promoteDraft('draft:filesystem', 'filesystem-session')

    const row = store.attachment(draft.attachmentId)
    expect(row).toMatchObject({
      session_id: 'filesystem-session',
      draft_id: null,
      project_id: null,
      rel_path: expect.stringMatching(
        /^sessions\/filesystem-session\/files\/att_.+-notes-txt$/,
      ),
    })
    await expect(readFile(join(dir, row!.rel_path!), 'utf8')).resolves.toBe(
      'hello',
    )
    expect(
      db
        .prepare('SELECT COUNT(*) AS count FROM attachments WHERE draft_id = ?')
        .get('draft:filesystem'),
    ).toEqual({ count: 0 })
  })

  it('tombstones a project while retaining migrated session and epic records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-upload-migrated-'))
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const project = createProject(db, {
      name: 'Project',
      path: dir,
      now: 1,
    })
    const session = createSession(db, {
      projectId: project.id,
      harness: 'test',
      title: 'Retained',
      cwd: dir,
      now: 2,
    })
    db.prepare(
      `INSERT INTO messages
       (session_id, turn_id, item_id, role, type, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(session.id, 'turn', 'item', 'user', 'text', '"kept"', 3)
    db.prepare(
      `INSERT INTO epic_runs
       (id, project_id, epic_bead_id, status, mode, worker_count, base_branch, config, origin_session_id, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'run',
      project.id,
      'bead',
      'completed',
      'serial',
      1,
      'main',
      '{}',
      session.id,
      4,
    )
    db.prepare(
      `INSERT INTO native_session_bindings
       (session_id, provider, account_id, cwd, provider_session_id, state, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(session.id, 'test', null, dir, 'native', 'available', 5)
    const store = new UploadStore(db, { dataDir: dir })
    resources.push({ store, db, dir })

    await store.deleteProject(project.id)

    expect(
      db
        .prepare('SELECT deleted_at FROM projects WHERE id = ?')
        .get(project.id),
    ).toMatchObject({ deleted_at: expect.any(Number) })
    expect(
      db
        .prepare('SELECT deleted_at FROM sessions WHERE id = ?')
        .get(session.id),
    ).toMatchObject({
      deleted_at: expect.any(Number),
    })
    expect(
      db
        .prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?')
        .get(session.id),
    ).toMatchObject({
      count: 1,
    })
    expect(
      db
        .prepare(
          'SELECT COUNT(*) AS count FROM native_session_bindings WHERE session_id = ?',
        )
        .get(session.id),
    ).toMatchObject({
      count: 1,
    })
    expect(
      db
        .prepare('SELECT COUNT(*) AS count FROM epic_runs WHERE project_id = ?')
        .get(project.id),
    ).toMatchObject({
      count: 1,
    })
  })

  it('refuses project deletion while a session is running', async () => {
    const { store, db } = await fixture()
    db.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(
      'session-one',
    )
    await expect(store.deleteProject('project-one')).rejects.toThrow(
      'Project has active sessions',
    )
    expect(
      db
        .prepare('SELECT deleted_at FROM projects WHERE id = ?')
        .get('project-one'),
    ).toMatchObject({
      deleted_at: null,
    })
  })

  it('streams a body to disk and appends an ordered attachment reference', async () => {
    const { store, db, dir } = await fixture()
    const body = new TextEncoder().encode('hello upload')
    const init = store.init('session-one', {
      filename: '../Read Me.TXT',
      mime: 'text/plain',
      sizeBytes: body.byteLength,
    })
    const result = await store.put(
      init.attachmentId,
      new ReadableStream({
        start(controller) {
          controller.enqueue(body)
          controller.close()
        },
      }),
    )
    const row = store.attachment(init.attachmentId)
    expect(row?.status).toBe('complete')
    expect(row?.sha256).toBe(result.sha256)
    expect(result.seq).toBe(1)
    expect(await readFile(join(dir, result.relPath), 'utf8')).toBe(
      'hello upload',
    )
    expect(
      JSON.parse(
        (
          db
            .prepare('SELECT content FROM messages WHERE seq = ?')
            .get(result.seq) as { content: string }
        ).content,
      ),
    ).toMatchObject({
      attachmentId: init.attachmentId,
      filename: '../Read Me.TXT',
      sizeBytes: body.byteLength,
    })
  })

  it('rejects a declared upload over 1 GiB before writing', async () => {
    const { store } = await fixture()
    expect(() =>
      store.init('session-one', {
        filename: 'large.bin',
        mime: 'application/octet-stream',
        sizeBytes: MAX_UPLOAD_BYTES + 1,
      }),
    ).toThrow(/1 GiB/)
  })

  it('publishes progress through the ephemeral bus', async () => {
    const { store } = await fixture()
    const events: unknown[] = []
    store.eventBus.subscribe((event) => events.push(event))
    const init = store.init('session-one', {
      filename: 'small.bin',
      mime: 'application/octet-stream',
      sizeBytes: 1,
    })
    await store.put(
      init.attachmentId,
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1]))
          controller.close()
        },
      }),
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'uploadProgress',
      seq: null,
      bytesReceived: 1,
    })
  })

  it('sweeps stale pending files without touching complete files', async () => {
    const { store, db, dir } = await fixture()
    const old = Date.now() - 25 * 60 * 60 * 1000
    db.prepare(
      'INSERT INTO attachments (id, session_id, filename, mime, size_bytes, sha256, rel_path, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'att_stale',
      'session-one',
      'old.txt',
      'text/plain',
      3,
      null,
      null,
      'pending',
      old,
    )
    db.prepare(
      'INSERT INTO attachments (id, session_id, filename, mime, size_bytes, sha256, rel_path, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'att_complete',
      'session-one',
      'keep.txt',
      'text/plain',
      4,
      'hash',
      'keep',
      'complete',
      old,
    )
    await mkdir(join(dir, 'projects/project-one/sessions/session-one/files'), {
      recursive: true,
    })
    await writeFile(
      join(
        dir,
        'projects/project-one/sessions/session-one/files/att_stale-old-txt',
      ),
      'old',
    )
    await writeFile(
      join(dir, 'projects/project-one/sessions/session-one/files/keep'),
      'keep',
    )
    expect(await store.sweep()).toBe(1)
    expect(store.attachment('att_stale')).toBeUndefined()
    expect(store.attachment('att_complete')?.status).toBe('complete')
    await expect(
      readFile(
        join(dir, 'projects/project-one/sessions/session-one/files/keep'),
        'utf8',
      ),
    ).resolves.toBe('keep')
  })

  it('removes a session directory and attachment rows', async () => {
    const { store, db, dir } = await fixture()
    const files = join(dir, 'projects/project-one/sessions/session-one/files')
    await mkdir(files, { recursive: true })
    await writeFile(join(files, 'stored'), 'data')
    db.prepare(
      'INSERT INTO attachments (id, session_id, filename, mime, size_bytes, sha256, rel_path, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'att_delete',
      'session-one',
      'stored.txt',
      'text/plain',
      4,
      'hash',
      'projects/project-one/sessions/session-one/files/stored',
      'complete',
      Date.now(),
    )
    expect(await store.deleteSession('session-one')).toBe(true)
    expect(store.attachment('att_delete')).toBeUndefined()
    await expect(stat(files)).rejects.toThrow()
    expect(
      db
        .prepare('SELECT deleted_at, status FROM sessions WHERE id = ?')
        .get('session-one') as { deleted_at: number; status: string },
    ).toMatchObject({ status: 'archived' })
  })

  it('removes unindexed files and marks missing complete files failed', async () => {
    const { store, db, dir } = await fixture()
    const files = join(dir, 'projects/project-one/sessions/session-one/files')
    await mkdir(files, { recursive: true })
    await writeFile(join(files, 'orphan'), 'orphan')
    db.prepare(
      'INSERT INTO attachments (id, session_id, filename, mime, size_bytes, sha256, rel_path, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'att_missing',
      'session-one',
      'missing.txt',
      'text/plain',
      7,
      'hash',
      'projects/project-one/sessions/session-one/files/missing',
      'complete',
      Date.now(),
    )
    await store.sweep()
    await expect(stat(join(files, 'orphan'))).rejects.toThrow()
    expect(store.attachment('att_missing')?.status).toBe('failed')
  })
})
