import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import type { HarnessSession } from '../harnesses/types.js'

/** Synchronous SQLite transactions keep native acknowledgements behind durable writes. */
export class NativeStorage {
  constructor(
    private readonly db: DatabaseSync,
    readonly session: HarnessSession,
  ) {}

  assertSession() {
    const row = this.db
      .prepare(
        'SELECT harness, account_id, cwd, deleted_at FROM sessions WHERE id = ?',
      )
      .get(this.session.id) as
      | {
          harness: string
          account_id: string | null
          cwd: string
          deleted_at: number | null
        }
      | undefined
    if (
      !row ||
      row.deleted_at !== null ||
      row.harness !== this.session.provider ||
      row.account_id !== this.session.accountId ||
      row.cwd !== this.session.cwd
    )
      throw new Error('Native storage session authority changed')
  }

  get<T>(name: string): T | undefined {
    this.assertSession()
    const row = this.db
      .prepare(
        'SELECT value FROM native_provider_state WHERE session_id = ? AND provider = ? AND name = ?',
      )
      .get(this.session.id, this.session.provider, name) as
      { value: string } | undefined
    return row ? (JSON.parse(row.value) as T) : undefined
  }

  put(name: string, value: unknown) {
    this.assertSession()
    this.db
      .prepare(
        'INSERT INTO native_provider_state VALUES (?, ?, ?, ?) ON CONFLICT(session_id, provider, name) DO UPDATE SET value = excluded.value',
      )
      .run(this.session.id, this.session.provider, name, encode(value))
  }

  pendingMediaCount(): number {
    this.assertSession()
    const row = this.db
      .prepare(
        "SELECT count(*) AS count FROM native_provider_state WHERE session_id=? AND provider=? AND name LIKE 'media:%' AND json_extract(value, '$.complete')=0",
      )
      .get(this.session.id, this.session.provider) as { count: number }
    return row.count
  }

  record(key: string, value: unknown): { position: number; replayed: boolean } {
    this.assertSession()
    const encoded = encode(value)
    const old = this.db
      .prepare(
        'SELECT position, value FROM native_provider_records WHERE session_id = ? AND provider = ? AND record_key = ?',
      )
      .get(this.session.id, this.session.provider, key) as
      { position: number; value: string } | undefined
    if (old) {
      if (!isDeepStrictEqual(JSON.parse(old.value), JSON.parse(encoded)))
        throw new Error('Native record identity conflict')
      return { position: old.position, replayed: true }
    }
    const result = this.db
      .prepare(
        'INSERT INTO native_provider_records(session_id, provider, record_key, value) VALUES (?, ?, ?, ?)',
      )
      .run(this.session.id, this.session.provider, key, encoded)
    return { position: Number(result.lastInsertRowid), replayed: false }
  }

  find<T>(key: string): T | undefined {
    this.assertSession()
    const row = this.db
      .prepare(
        'SELECT value FROM native_provider_records WHERE session_id = ? AND provider = ? AND record_key = ?',
      )
      .get(this.session.id, this.session.provider, key) as
      { value: string } | undefined
    return row ? (JSON.parse(row.value) as T) : undefined
  }

  transaction<T>(signal: AbortSignal, work: () => T): T {
    signal.throwIfAborted()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.assertSession()
      const value = work()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  activate(): string {
    const token = randomUUID()
    this.put('activation', token)
    return token
  }

  assertActivation(token: string) {
    if (this.get('activation') !== token)
      throw new Error('Native storage activation expired')
  }
}

function encode(value: unknown): string {
  const text = JSON.stringify(value)
  if (text === undefined || Buffer.byteLength(text) > 32 * 1024 * 1024)
    throw new Error('Native storage value exceeds limit')
  return text
}

export function sameNativeValue(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(JSON.parse(encode(left)), JSON.parse(encode(right)))
}
