import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type {
  CreateHarnessAccount,
  HarnessAccount,
  PatchHarnessAccount,
} from '@forge/protocol/accounts'

type Db = { prepare(sql: string): any }
type AccountRow = {
  id: string
  harness_key: string
  label: string
  kind: string
  home_path: string
  order_index: number
  disabled_at: number | null
  created_at: number
  last_used_at: number | null
}

const accountRoot = () =>
  resolve(
    process.env.FORGE_ACCOUNTS_DIR ?? join(homedir(), '.forge', 'accounts'),
  )
const toAccount = (row: AccountRow): HarnessAccount => ({
  id: row.id,
  harnessKey: row.harness_key,
  label: row.label,
  kind: row.kind,
  homePath: row.home_path,
  orderIndex: row.order_index,
  disabledAt: row.disabled_at,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
})
const newId = () => `acct_${crypto.randomUUID().replaceAll('-', '')}`

export class HarnessAccountStore {
  constructor(private readonly db: Db) {}

  list(harnessKey?: string) {
    const rows = harnessKey
      ? this.db
          .prepare(
            'SELECT * FROM harness_accounts WHERE harness_key = ? ORDER BY order_index, created_at',
          )
          .all(harnessKey)
      : this.db
          .prepare(
            'SELECT * FROM harness_accounts ORDER BY harness_key, order_index, created_at',
          )
          .all()
    return (rows as AccountRow[]).map(toAccount)
  }

  get(id: string) {
    const row = this.db
      .prepare('SELECT * FROM harness_accounts WHERE id = ?')
      .get(id) as AccountRow | undefined
    return row ? toAccount(row) : undefined
  }

  create(input: CreateHarnessAccount) {
    const id = newId()
    const now = Date.now()
    const homePath = join(accountRoot(), input.kind, id)
    mkdirSync(homePath, { recursive: true, mode: 0o700 })
    chmodSync(homePath, 0o700)
    this.db
      .prepare(
        `INSERT INTO harness_accounts
          (id, harness_key, label, kind, home_path, order_index, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.harnessKey,
        input.label,
        input.kind,
        homePath,
        input.orderIndex ?? 0,
        now,
      )
    return this.get(id)!
  }

  patch(id: string, input: PatchHarnessAccount) {
    const current = this.get(id)
    if (!current) return undefined
    const disabledAt =
      input.disabled === undefined
        ? current.disabledAt
        : input.disabled
          ? (current.disabledAt ?? Date.now())
          : null
    this.db
      .prepare(
        'UPDATE harness_accounts SET label = ?, order_index = ?, disabled_at = ? WHERE id = ?',
      )
      .run(
        input.label ?? current.label,
        input.orderIndex ?? current.orderIndex,
        disabledAt,
        id,
      )
    return this.get(id)
  }

  rename(id: string, label: string) {
    return this.patch(id, { label })
  }

  reorder(id: string, orderIndex: number) {
    return this.patch(id, { orderIndex })
  }

  disable(id: string) {
    return this.patch(id, { disabled: true })
  }

  delete(id: string, removeHome = false) {
    const current = this.get(id)
    if (!current) return false
    this.db.prepare('DELETE FROM harness_accounts WHERE id = ?').run(id)
    if (removeHome) rmSync(current.homePath, { recursive: true, force: true })
    return true
  }
}

export function accountEnv(
  kind: string,
  homePath: string,
): Record<string, string> {
  switch (kind) {
    case 'claude':
      return { CLAUDE_CONFIG_DIR: homePath }
    case 'codex':
      return { CODEX_HOME: homePath }
    case 'kimi':
      return { KIMI_SHARE_DIR: homePath }
    case 'opencode':
      return {
        XDG_DATA_HOME: homePath,
        OPENCODE_DB: join(homePath, 'opencode', 'opencode.db'),
      }
    default:
      return {}
  }
}

export function accountAuthenticated(kind: string, homePath: string) {
  const files =
    kind === 'claude'
      ? ['.credentials.json', '.claude.json']
      : kind === 'codex'
        ? ['auth.json']
        : kind === 'kimi'
          ? ['credentials.json', 'auth.json']
          : kind === 'opencode'
            ? ['opencode/auth.json']
            : []
  return files.some((file) => existsSync(join(homePath, file)))
}
