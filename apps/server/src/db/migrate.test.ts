import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { migrate } from './migrate.js'

const dbs: DatabaseSync[] = []
afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
})

const dir = fileURLToPath(new URL('../../drizzle/', import.meta.url))
const files = readdirSync(dir)
  .filter((name) => name.endsWith('.sql'))
  .sort()
const PROJECT_OPTIONAL = '0026_session_project_optional.sql'

// A database that already ran every migration up to, but not including, the one
// under test, with its ledger filled in. Running migrate() then applies exactly
// that one migration, the way an upgraded install experiences it.
function applied(through: string) {
  const db = new DatabaseSync(':memory:')
  dbs.push(db)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`)
  const insert = db.prepare(
    'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)',
  )
  for (const file of files) {
    if (file === through) break
    db.exec(readFileSync(dir + file, 'utf8'))
    insert.run(file, 1)
  }
  return db
}

function seed(db: DatabaseSync) {
  db.exec(`INSERT INTO projects (id, name, path, created_at)
    VALUES ('prj_1', 'Forge', '/tmp/forge', 1)`)
  // An explicit rowid with a gap under it. A copy that lets SQLite assign
  // rowids would land this row at 1, so the assertion can actually fail.
  db.exec(`INSERT INTO sessions
    (rowid, id, project_id, harness, title, cwd, kind, status, auto_resume, created_at, last_activity_at, model)
    VALUES (7, 'ses_1', 'prj_1', 'claude', 'Kept chat', '/tmp/forge', 'chat', 'idle', 0, 1, 2, 'opus')`)
  db.exec(`INSERT INTO messages (session_id, turn_id, item_id, role, type, content, created_at)
    VALUES ('ses_1', 'turn_1', 'item_1', 'agent', 'text', '{"text":"hi"}', 3)`)
  db.exec(`INSERT INTO native_interactions
    (request_id, session_id, kind, request, status, created_at, updated_at, expires_at)
    VALUES ('req_1', 'ses_1', 'permission', '{}', 'pending', 4, 4, 5)`)
  db.exec(`INSERT INTO git_turn_snapshots
    (id, session_id, turn_id, workspace_id, workspace_revision, checkout_key, state, created_at)
    VALUES ('snap_1', 'ses_1', 'turn_1', 'ws_1', 1, 'key', 'ready', 6)`)
}

// Leave ses_1 pointing at a project that no longer exists. Enforcement blocks
// the delete, so it has to be suspended the way a pre-enforcement server did.
function orphan(db: DatabaseSync) {
  db.exec('PRAGMA foreign_keys = OFF')
  db.exec("DELETE FROM projects WHERE id = 'prj_1'")
  db.exec('PRAGMA foreign_keys = ON')
}

describe(PROJECT_OPTIONAL, () => {
  it('makes project_id optional on an already-applied database', () => {
    const db = applied(PROJECT_OPTIONAL)
    seed(db)
    const before = db
      .prepare('SELECT rowid FROM sessions WHERE id = ?')
      .get('ses_1') as { rowid: number }

    migrate(db)

    const column = (
      db
        .prepare('SELECT name, "notnull" FROM pragma_table_info(?)')
        .all('sessions') as Array<{ name: string; notnull: number }>
    ).find((entry) => entry.name === 'project_id')
    expect(column?.notnull).toBe(0)
    db.exec(`INSERT INTO sessions
      (id, project_id, harness, title, cwd, kind, status, auto_resume, created_at, last_activity_at)
      VALUES ('ses_2', NULL, 'claude', 'Filesystem chat', '/tmp/any', 'chat', 'idle', 0, 7, 8)`)
    expect(
      db.prepare('SELECT project_id FROM sessions WHERE id = ?').get('ses_2'),
    ).toEqual({ project_id: null })
    // rowid identity backs sessions_fts, so the rebuild has to preserve it.
    expect(before).toEqual({ rowid: 7 })
    expect(
      db.prepare('SELECT rowid FROM sessions WHERE id = ?').get('ses_1'),
    ).toEqual(before)
  })

  it('keeps rows that a cascading rebuild would have deleted', () => {
    const db = applied(PROJECT_OPTIONAL)
    seed(db)

    migrate(db)

    expect(
      db.prepare('SELECT COUNT(*) AS n FROM native_interactions').get(),
    ).toEqual({ n: 1 })
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM git_turn_snapshots').get(),
    ).toEqual({ n: 1 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({
      n: 1,
    })
    expect(
      db
        .prepare('SELECT model, retention FROM sessions WHERE id = ?')
        .get('ses_1'),
    ).toEqual({ model: 'opus', retention: 'permanent' })
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('restores the indexes and search triggers the rebuild drops', () => {
    const db = applied(PROJECT_OPTIONAL)
    seed(db)

    migrate(db)

    const names = (
      db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE tbl_name = 'sessions' AND type IN ('index','trigger')",
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'sessions_parent_fork_request_idx',
        'sessions_retention_idx',
        'sessions_fts_insert',
        'sessions_fts_update',
      ]),
    )
    db.exec(`INSERT INTO sessions
      (id, project_id, harness, title, cwd, kind, status, auto_resume, created_at, last_activity_at)
      VALUES ('ses_3', 'prj_1', 'claude', 'Searchable', '/tmp/forge', 'chat', 'idle', 0, 9, 10)`)
    expect(
      db
        .prepare('SELECT COUNT(*) AS n FROM sessions_fts WHERE title MATCH ?')
        .get('Searchable'),
    ).toEqual({ n: 1 })
  })

  // An older server could leave the ledger empty while the schema is partly
  // upgraded. migrate() replays every file through replayLegacyMigration then,
  // so the rebuild has to survive that path too.
  it('rebuilds through the ledgerless replay path', () => {
    const db = new DatabaseSync(':memory:')
    dbs.push(db)
    db.exec('PRAGMA foreign_keys = ON')
    for (const file of files) {
      if (file === '0013_harness_account_identity.sql') break
      db.exec(readFileSync(dir + file, 'utf8'))
    }
    db.exec(`INSERT INTO projects (id, name, path, created_at)
      VALUES ('prj_1', 'Forge', '/tmp/forge', 1)`)
    db.exec(`INSERT INTO sessions
      (id, project_id, harness, title, cwd, kind, status, auto_resume, created_at, last_activity_at)
      VALUES ('ses_1', 'prj_1', 'claude', 'Kept chat', '/tmp/forge', 'chat', 'idle', 0, 1, 2)`)

    migrate(db)

    const column = (
      db
        .prepare('SELECT name, "notnull" FROM pragma_table_info(?)')
        .all('sessions') as Array<{ name: string; notnull: number }>
    ).find((entry) => entry.name === 'project_id')
    expect(column?.notnull).toBe(0)
    expect(
      db.prepare('SELECT title FROM sessions WHERE id = ?').get('ses_1'),
    ).toEqual({ title: 'Kept chat' })
    expect(
      db
        .prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE name = ?')
        .get(PROJECT_OPTIONAL),
    ).toEqual({ n: 1 })
  })

  it('names the rows when a migration breaks a reference', () => {
    const db = applied(PROJECT_OPTIONAL)
    seed(db)
    orphan(db)

    expect(() => migrate(db)).toThrow(/sessions rowid 7 -> projects/)
    // The failed run rolls back rather than half-applying the rebuild.
    expect(
      db
        .prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE name = ?')
        .get(PROJECT_OPTIONAL),
    ).toEqual({ n: 0 })
  })

  // Refusing to boot over a row the run never touched would strand the user.
  it('does not check references when nothing is pending', () => {
    const db = applied(PROJECT_OPTIONAL)
    seed(db)
    migrate(db)
    orphan(db)

    expect(() => migrate(db)).not.toThrow()
  })

  // The rebuild restates every column by hand, so it has to be compared against
  // the schema it replaces, not against another database that also ran it.
  it('changes nothing about sessions except the project_id constraint', () => {
    const before = applied(PROJECT_OPTIONAL)
    const expected = (
      columns(before) as Array<{ name: string; notnull: number }>
    ).map((column) =>
      column.name === 'project_id' ? { ...column, notnull: 0 } : column,
    )
    expect(expected.find((column) => column.name === 'project_id')).toEqual(
      expect.objectContaining({ notnull: 0 }),
    )

    const after = applied(PROJECT_OPTIONAL)
    migrate(after)
    const fresh = new DatabaseSync(':memory:')
    dbs.push(fresh)
    fresh.exec('PRAGMA foreign_keys = ON')
    migrate(fresh)

    expect(columns(after)).toEqual(expected)
    expect(columns(fresh)).toEqual(expected)
  })
})

const columns = (db: DatabaseSync) =>
  db
    .prepare(
      'SELECT cid, name, type, "notnull", dflt_value, pk FROM pragma_table_info(?)',
    )
    .all('sessions')
