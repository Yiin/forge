import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { migrate } from '../src/db/migrate.js'
import { UploadStore } from '../src/uploads/store.js'
import { createProject, createSession } from '../src/db/queries.js'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const task of cleanup.splice(0)) await task()
})

describe('migrated schema', () => {
  it('applies every drizzle migration in order', () => {
    const db = new DatabaseSync(':memory:')
    cleanup.push(() => db.close())
    migrate(db)
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name)
    expect(tables).toContain('messages')
    expect(tables).toContain('harness_capabilities')
    expect(tables).toContain('epic_runs')
    expect(tables).toContain('epic_iterations')
  })

  it('writes an upload attachment row into the migrated messages table', async () => {
    const db = new DatabaseSync(':memory:')
    cleanup.push(() => db.close())
    migrate(db)
    const dataDir = await mkdtemp(join(tmpdir(), 'forge-merge-'))
    cleanup.push(() => rm(dataDir, { recursive: true, force: true }))
    const project = createProject(db, { name: 'Forge', path: '/tmp/forge' })
    const session = createSession(db, {
      projectId: project.id,
      harness: 'default',
      title: 'Chat',
      cwd: '/tmp',
    })
    const store = new UploadStore(db, { dataDir })
    cleanup.push(() => store.close())
    const { attachmentId } = store.init(session.id, {
      filename: 'a.txt',
      mime: 'text/plain',
      sizeBytes: 5,
    })
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('hello'))
        controller.close()
      },
    })
    await store.put(attachmentId, body)
    const row = db
      .prepare("SELECT * FROM messages WHERE type = 'attachment_ref'")
      .get() as Record<string, unknown>
    expect(row.session_id).toBe(session.id)
    expect(row.role).toBe('user')
    expect(row.turn_id).toBe(attachmentId)
    expect(row.item_id).toBe(attachmentId)
  })

  it('can run twice without losing draft attachment ownership', async () => {
    const dbPath = join(
      await mkdtemp(join(tmpdir(), 'forge-migration-rerun-')),
      'forge.db',
    )
    cleanup.push(() => rm(dbPath, { force: true }))
    const db = new DatabaseSync(dbPath)
    cleanup.push(() => db.close())
    migrate(db)
    const project = createProject(db, { name: 'Forge', path: '/tmp/forge' })
    const dataDir = await mkdtemp(join(tmpdir(), 'forge-upload-'))
    cleanup.push(() => rm(dataDir, { recursive: true, force: true }))
    const store = new UploadStore(db, { dataDir })
    cleanup.push(() => store.close())
    const { attachmentId } = store.initDraft('draft', project.id, {
      filename: 'a.txt',
      mime: 'text/plain',
      sizeBytes: 5,
    })

    migrate(db)

    expect(
      db
        .prepare('SELECT draft_id, project_id FROM attachments WHERE id = ?')
        .get(attachmentId),
    ).toEqual({ draft_id: 'draft', project_id: project.id })
    expect(
      (
        db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as {
          count: number
        }
      ).count,
    ).toBe((await readdir(new URL('../drizzle/', import.meta.url))).length)
  })

  it('backfills the ledger for an existing pre-ledger database', () => {
    const db = new DatabaseSync(':memory:')
    cleanup.push(() => db.close())
    const dir = fileURLToPath(new URL('../drizzle/', import.meta.url))
    for (const file of readdirSync(dir)
      .filter((name) => name.endsWith('.sql'))
      .sort())
      db.exec(readFileSync(join(dir, file), 'utf8'))

    migrate(db)

    expect(
      (
        db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as {
          count: number
        }
      ).count,
    ).toBe(readdirSync(dir).filter((name) => name.endsWith('.sql')).length)
  })
})
