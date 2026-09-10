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

describe('legacy migration recovery', () => {
  const dir = fileURLToPath(new URL('../drizzle/', import.meta.url))
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
  const sql = (file: string) => readFileSync(join(dir, file), 'utf8')

  function databaseBefore(file?: string) {
    const db = new DatabaseSync(':memory:')
    cleanup.push(() => db.close())
    for (const migration of files) {
      if (migration === file) break
      db.exec(sql(migration))
    }
    db.exec(`
      INSERT INTO projects (id, name, path, created_at) VALUES ('project', 'Forge', '/tmp/forge', 1);
      INSERT INTO sessions (id, project_id, harness, title, cwd, kind, status, auto_resume, created_at, last_activity_at)
        VALUES ('session', 'project', 'codex', 'Keep this title', '/tmp/forge', 'chat', 'idle', 0, 1, 1);
      INSERT INTO messages (session_id, turn_id, item_id, role, type, content, created_at)
        VALUES ('session', 'turn', 'item', 'assistant', 'text', '{"text":"Keep; this message"}', 1);
      INSERT INTO attachments (id, session_id, filename, mime, size_bytes, status, created_at)
        VALUES ('attachment', 'session', 'keep.txt', 'text/plain', 4, 'complete', 1);
    `)
    return db
  }

  function expectComplete(db: DatabaseSync) {
    expect(
      db.prepare('SELECT name FROM schema_migrations ORDER BY name').all(),
    ).toEqual(files.map((name) => ({ name })))
    expect(
      db
        .prepare(
          "SELECT adapter_kind, native_resume_state, context_method, context_confidence FROM sessions WHERE id = 'session'",
        )
        .get(),
    ).toEqual({
      adapter_kind: null,
      native_resume_state: 'not_eligible',
      context_method: null,
      context_confidence: null,
    })
    expect(
      db.prepare("SELECT content FROM messages WHERE item_id = 'item'").get(),
    ).toEqual({ content: '{"text":"Keep; this message"}' })
    expect(
      db
        .prepare(
          "SELECT session_id, filename FROM attachments WHERE id = 'attachment'",
        )
        .get(),
    ).toEqual({ session_id: 'session', filename: 'keep.txt' })
    expect(db.prepare('SELECT * FROM native_session_bindings').all()).toEqual(
      [],
    )
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  }

  it.each(files.slice(1))('upgrades populated schemas before %s', (file) => {
    const db = databaseBefore(file)
    migrate(db)
    migrate(db)
    expectComplete(db)
  })

  it('preserves populated current schemas and their draft ownership', () => {
    const db = databaseBefore()
    db.exec(`
      INSERT INTO attachments (id, session_id, filename, mime, size_bytes, status, created_at, draft_id, project_id)
        VALUES ('draft-attachment', NULL, 'draft.txt', 'text/plain', 4, 'complete', 1, 'draft', 'project');
      INSERT INTO draft_promotions (request_id, draft_id, session_id)
        VALUES ('request-a', 'draft', 'session'), ('request-b', 'draft', 'session');
      INSERT INTO harness_accounts (id, harness_key, label, kind, home_path, created_at, identity, config, adapter_kind)
        VALUES ('account', 'codex', 'Account', 'managed', '/tmp/account', 1, '{"email":"test@example.invalid"}', '{"keep":true}', 'codex-app-server');
      UPDATE sessions SET provider_session_id = 'provider-session', account_id = 'account', native_resume_state = 'available';
      INSERT INTO native_session_bindings (session_id, provider, account_id, cwd, provider_session_id, updated_at)
        VALUES ('session', 'codex', 'account', '/tmp/forge', 'provider-session', 1);
    `)
    const tables = [
      'projects',
      'sessions',
      'messages',
      'attachments',
      'draft_promotions',
      'harness_accounts',
      'native_session_bindings',
    ]
    const before = tables.map((table) =>
      db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    )
    migrate(db)
    migrate(db)
    expect(
      tables.map((table) =>
        db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ),
    ).toEqual(before)
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  for (const file of [
    '0009_draft_promotion.sql',
    '0016_draft_promotions_request_key.sql',
  ]) {
    // These two rebuild scripts have no triggers or semicolons in literals.
    const statements = sql(file)
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean)
    it.each(statements.map((_, index) => index + 1))(
      `resumes ${file} after statement %i`,
      (count) => {
        const db = databaseBefore(file)
        if (file === '0016_draft_promotions_request_key.sql') {
          db.exec(
            "INSERT INTO draft_promotions (request_id, draft_id, session_id) VALUES ('request', 'draft', 'session')",
          )
        }
        for (const statement of statements.slice(0, count))
          db.exec(`${statement};`)
        migrate(db)
        migrate(db)
        expectComplete(db)
        expect(
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE name IN ('attachments_legacy', 'draft_promotions_new')",
            )
            .all(),
        ).toEqual([])
        if (file === '0016_draft_promotions_request_key.sql') {
          expect(db.prepare('SELECT * FROM draft_promotions').all()).toEqual([
            { request_id: 'request', draft_id: 'draft', session_id: 'session' },
          ])
        }
      },
    )
  }

  it('finishes partial column upgrades after the first ALTER already ran', () => {
    const db = databaseBefore('0006_session_forks.sql')
    db.exec('ALTER TABLE sessions ADD COLUMN fork_request_id TEXT')
    migrate(db)
    expectComplete(db)
  })

  it.each([false, true])(
    'retries a failed bootstrap with an existing empty ledger: %s',
    (emptyLedger) => {
      const db = databaseBefore('0006_session_forks.sql')
      if (emptyLedger)
        db.exec(
          'CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)',
        )
      const before = db
        .prepare('SELECT name, sql FROM sqlite_master ORDER BY name')
        .all()
      const failing = {
        prepare: db.prepare.bind(db),
        exec(statement: string) {
          if (
            statement.includes(
              'CREATE TABLE IF NOT EXISTS native_session_bindings',
            )
          )
            throw new Error('Injected migration failure')
          return db.exec(statement)
        },
      }
      expect(() => migrate(failing)).toThrow('Injected migration failure')
      expect(
        db.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all(),
      ).toEqual(before)
      migrate(db)
      expectComplete(db)
    },
  )

  it('refuses conflicting partial copies without losing rows or recording migrations', () => {
    const db = databaseBefore('0016_draft_promotions_request_key.sql')
    db.exec(`
      INSERT INTO draft_promotions (request_id, draft_id, session_id) VALUES ('request', 'original-draft', 'session');
      CREATE TABLE draft_promotions_new (request_id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id));
      INSERT INTO draft_promotions_new (request_id, draft_id, session_id) VALUES ('request', 'conflicting-draft', 'session');
    `)
    expect(() => migrate(db)).toThrow('conflicting rows')
    expect(db.prepare('SELECT draft_id FROM draft_promotions').get()).toEqual({
      draft_id: 'original-draft',
    })
    expect(
      db.prepare('SELECT draft_id FROM draft_promotions_new').get(),
    ).toEqual({ draft_id: 'conflicting-draft' })
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'schema_migrations'",
        )
        .get(),
    ).toBeUndefined()
  })
})
