import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
})
