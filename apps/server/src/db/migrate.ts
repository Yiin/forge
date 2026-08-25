import { readFileSync } from 'node:fs'
type SqliteLike = { exec(sql: string): unknown }
export function migrate(sqlite: SqliteLike) {
  const sql = readFileSync(
    new URL('../../drizzle/0000_initial.sql', import.meta.url),
    'utf8',
  )
  sqlite.exec(sql)
}
