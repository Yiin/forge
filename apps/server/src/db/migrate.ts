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

type Column = { name: string; notnull: number; pk: number }

function columns(sqlite: SqliteLike, table: string) {
  return sqlite
    .prepare('SELECT name, "notnull", pk FROM pragma_table_info(?)')
    .all(table) as Column[]
}

function quoteIdentifier(name: string) {
  return `"${name.replaceAll('"', '""')}"`
}

// Old migrations could stop between copying rows and dropping the source table.
// Keep the destination rows, copy missing rows, and refuse conflicting copies.
function finishLegacyCopy(
  sqlite: SqliteLike,
  source: string,
  target: string,
  key: string,
) {
  const sourceColumns = columns(sqlite, source).map((column) => column.name)
  const targetColumns = new Set(
    columns(sqlite, target).map((column) => column.name),
  )
  if (
    !sourceColumns.includes(key) ||
    sourceColumns.some((column) => !targetColumns.has(column))
  ) {
    throw new Error(
      `Cannot recover migration from ${source} to ${target}: incompatible columns`,
    )
  }
  const from = quoteIdentifier(source)
  const to = quoteIdentifier(target)
  const id = quoteIdentifier(key)
  const names = sourceColumns.map(quoteIdentifier)
  const mismatches = names
    .map((name) => `source.${name} IS NOT target.${name}`)
    .join(' OR ')
  const conflict = sqlite
    .prepare(
      `SELECT 1 FROM ${from} AS source JOIN ${to} AS target
    ON source.${id} = target.${id} WHERE ${mismatches} LIMIT 1`,
    )
    .get()
  if (conflict)
    throw new Error(
      `Cannot recover migration from ${source} to ${target}: conflicting rows`,
    )
  sqlite.exec(`INSERT INTO ${to} (${names.join(', ')})
    SELECT ${names.map((name) => `source.${name}`).join(', ')} FROM ${from} AS source
    WHERE NOT EXISTS (SELECT 1 FROM ${to} AS target WHERE target.${id} = source.${id})`)
  sqlite.exec(`DROP TABLE ${from}`)
}

function recoverLegacyRebuilds(sqlite: SqliteLike) {
  if (columns(sqlite, 'attachments_legacy').length) {
    if (columns(sqlite, 'attachments').length) {
      finishLegacyCopy(sqlite, 'attachments_legacy', 'attachments', 'id')
    } else {
      sqlite.exec('ALTER TABLE attachments_legacy RENAME TO attachments')
    }
  }
  if (columns(sqlite, 'draft_promotions_new').length) {
    if (columns(sqlite, 'draft_promotions').length) {
      finishLegacyCopy(
        sqlite,
        'draft_promotions',
        'draft_promotions_new',
        'request_id',
      )
    }
    sqlite.exec('ALTER TABLE draft_promotions_new RENAME TO draft_promotions')
  }
}

function replayLegacyMigration(sqlite: SqliteLike, file: string, sql: string) {
  if (file === '0009_draft_promotion.sql') {
    const attachments = columns(sqlite, 'attachments')
    if (attachments.some((column) => column.name === 'draft_id')) {
      if (
        !attachments.some((column) => column.name === 'project_id') ||
        !attachments.some(
          (column) => column.name === 'session_id' && column.notnull === 0,
        )
      ) {
        throw new Error(
          'Cannot recover attachments migration: incomplete draft schema',
        )
      }
      // The rebuild already ran. Rebuilding again discards draft ownership.
      sqlite.exec(`CREATE TABLE IF NOT EXISTS draft_promotions (
        draft_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL REFERENCES sessions(id)
      )`)
      return
    }
  }
  if (file === '0016_draft_promotions_request_key.sql') {
    const promotions = columns(sqlite, 'draft_promotions')
    if (
      promotions.some(
        (column) => column.name === 'request_id' && column.pk === 1,
      )
    )
      return
  }

  // Shipped ADD COLUMN statements occupy whole lines. Remove only those whose
  // columns exist, then let SQLite parse the complete script, including triggers.
  const pending = sql.replace(
    /^ALTER TABLE (\w+) ADD COLUMN (\w+) [^\r\n]*;$/gm,
    (statement, table: string, column: string) =>
      columns(sqlite, table).some((existing) => existing.name === column)
        ? ''
        : statement,
  )
  if (pending.trim()) sqlite.exec(pending)
}

export function migrate(sqlite: SqliteLike) {
  const dir = fileURLToPath(new URL('../../drizzle/', import.meta.url))
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()

  // A migration that rebuilds a table has to drop the old one, and SQLite runs
  // an implicit DELETE FROM for that drop while foreign keys are on. That
  // delete cascades into child rows and trips immediate constraints, so the
  // documented rebuild procedure turns foreign keys off around the whole
  // transaction and checks the result before committing. The pragma is ignored
  // inside a transaction, so it has to happen here.
  const enforced =
    (
      sqlite.prepare('PRAGMA foreign_keys').get() as
        { foreign_keys: number } | undefined
    )?.foreign_keys === 1
  if (enforced) sqlite.exec('PRAGMA foreign_keys = OFF')
  try {
    migrateWithin(sqlite, dir, files, enforced)
  } finally {
    if (enforced) sqlite.exec('PRAGMA foreign_keys = ON')
  }
}

function migrateWithin(
  sqlite: SqliteLike,
  dir: string,
  files: string[],
  check: boolean,
) {
  sqlite.exec('BEGIN IMMEDIATE')
  try {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )`)
    const applied = new Set(
      (
        sqlite.prepare('SELECT name FROM schema_migrations').all() as Array<{
          name: string
        }>
      ).map((row) => row.name),
    )
    // A failed pre-ledger upgrade from an older server can leave an empty ledger.
    const legacy = applied.size === 0 && columns(sqlite, 'sessions').length > 0
    if (legacy) recoverLegacyRebuilds(sqlite)
    const insert = sqlite.prepare(
      'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)',
    )
    for (const file of files) {
      if (applied.has(file)) continue
      const sql = readFileSync(dir + file, 'utf8')
      if (legacy) replayLegacyMigration(sqlite, file, sql)
      else sqlite.exec(sql)
      insert.run(file, Date.now())
    }
    if (check) {
      const broken = sqlite.prepare('PRAGMA foreign_key_check').all()
      if (broken.length)
        throw new Error(
          `Migration left ${broken.length} broken foreign key reference(s)`,
        )
    }
    sqlite.exec('COMMIT')
  } catch (error) {
    sqlite.exec('ROLLBACK')
    throw error
  }
}
