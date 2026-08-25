import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
type SqliteLike = { exec(sql: string): unknown }
export function migrate(sqlite: SqliteLike) {
  const dir = fileURLToPath(new URL('../../drizzle/', import.meta.url))
  for (const file of readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort())
    sqlite.exec(readFileSync(dir + file, 'utf8'))
}
