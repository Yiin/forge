import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

type SqliteLike = {
  exec(sql: string): unknown
  prepare(sql: string): {
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
    run(...params: unknown[]): unknown
  }
}

export function migrate(sqlite: SqliteLike) {
  const dir = fileURLToPath(new URL('../../drizzle/', import.meta.url))
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
  const hadLedger = Boolean(
    sqlite
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
      )
      .get(),
  )

  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )`,
  )

  if (!hadLedger) {
    const hasExistingSchema = sqlite
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'",
      )
      .get()
    if (hasExistingSchema) {
      sqlite.exec('BEGIN')
      try {
        // Existing databases predate the migration ledger. Apply the newest
        // idempotent migration before recording the legacy baseline.
        const newest = files.at(-1)
        if (newest) {
          try {
            sqlite.exec(readFileSync(dir + newest, 'utf8'))
          } catch (error) {
            // A pre-ledger database may already contain the newest columns.
            // The legacy path executes that migration once before recording
            // the baseline, so treat those duplicate ALTERs as applied.
            const hasIdentity = sqlite
              .prepare(
                "SELECT 1 FROM pragma_table_info('harness_accounts') WHERE name = 'identity'",
              )
              .get()
            if (!hasIdentity || !String(error).includes('duplicate column'))
              throw error
          }
        }
        const insert = sqlite.prepare(
          'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)',
        )
        const now = Date.now()
        for (const file of files) insert.run(file, now)
        sqlite.exec('COMMIT')
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
      return
    }
  }

  const applied = new Set(
    (
      sqlite.prepare('SELECT name FROM schema_migrations').all() as Array<{
        name: string
      }>
    ).map((row) => row.name),
  )
  const insert = sqlite.prepare(
    'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)',
  )
  for (const file of files) {
    if (applied.has(file)) continue
    sqlite.exec('BEGIN')
    try {
      sqlite.exec(readFileSync(dir + file, 'utf8'))
      insert.run(file, Date.now())
      sqlite.exec('COMMIT')
    } catch (error) {
      sqlite.exec('ROLLBACK')
      throw error
    }
  }
}
