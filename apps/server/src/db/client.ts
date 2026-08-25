import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import * as schema from './schema.js'

export function openDatabase(filename = process.env.FORGE_DB ?? ':memory:') {
  const sqlite = new Database(filename)
  sqlite.exec(
    'PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;',
  )
  return { sqlite, db: drizzle(sqlite, { schema }) }
}
export type ForgeDatabase = ReturnType<typeof openDatabase>
