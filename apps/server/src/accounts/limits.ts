type Db = { prepare(sql: string): any }

export type LimitCategory =
  'usage-limit' | 'spend-limit' | 'auth' | 'rate-limit' | 'unavailable'
export type ProviderErrorMatch = { category: LimitCategory; excerpt: string }

const patterns: ReadonlyArray<{ category: LimitCategory; pattern: RegExp }> = [
  { category: 'spend-limit', pattern: /monthly spend limit/i },
  { category: 'usage-limit', pattern: /usage limit/i },
  { category: 'auth', pattern: /invalid api key/i },
  { category: 'auth', pattern: /authentication/i },
  { category: 'auth', pattern: /credit balance/i },
  { category: 'auth', pattern: /unauthorized/i },
  { category: 'auth', pattern: /\b401\b/ },
  { category: 'rate-limit', pattern: /rate limit/i },
  { category: 'rate-limit', pattern: /overloaded/i },
  { category: 'unavailable', pattern: /service unavailable/i },
  { category: 'unavailable', pattern: /temporarily unavailable/i },
  { category: 'unavailable', pattern: /provider (?:is )?unavailable/i },
  {
    category: 'unavailable',
    pattern: /provider error.{0,80}(?:service |temporarily )?unavailable/i,
  },
]

export function detectProviderError(text: string): ProviderErrorMatch | null {
  for (const { category, pattern } of patterns) {
    const match = pattern.exec(text)
    if (!match) continue
    const start = text.lastIndexOf('\n', match.index) + 1
    const end = text.indexOf('\n', match.index)
    return {
      category,
      excerpt: text
        .slice(start, end < 0 ? text.length : end)
        .trim()
        .slice(0, 200),
    }
  }
  return null
}

export function normalizeEpochResetsAt(
  value: string | number | null | undefined,
): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    return null
  return value < 1e11 ? value * 1000 : value
}

export function recordLimit(
  db: Db,
  input: {
    accountId: string
    kind: LimitCategory
    harnessKey: string
    detectedAt: number
    resetsAt?: number | null
    resetsAtEstimated?: boolean
    source: string
    detail?: string | null
  },
) {
  db.prepare(
    `INSERT INTO harness_account_limits
      (account_id, kind, harness_key, detected_at, resets_at, resets_at_estimated, source, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, kind) DO UPDATE SET
       harness_key = excluded.harness_key, detected_at = excluded.detected_at,
       resets_at = excluded.resets_at, resets_at_estimated = excluded.resets_at_estimated,
       source = excluded.source, detail = excluded.detail
     WHERE excluded.detected_at >= harness_account_limits.detected_at`,
  ).run(
    input.accountId,
    input.kind,
    input.harnessKey,
    input.detectedAt,
    input.resetsAt ?? null,
    input.resetsAtEstimated ? 1 : 0,
    input.source,
    input.detail?.slice(0, 200) ?? null,
  )
}

export function clearExpiredLimits(db: Db, now: number) {
  db.prepare(
    'DELETE FROM harness_account_limits WHERE resets_at IS NOT NULL AND resets_at <= ?',
  ).run(now)
}

export function clearAccountLimits(db: Db, accountId: string) {
  db.prepare('DELETE FROM harness_account_limits WHERE account_id = ?').run(
    accountId,
  )
}

export function blockedAccounts(
  db: Db,
  now: number,
  ttlMs: number,
): Set<string> {
  clearExpiredLimits(db, now)
  const cutoff = now - ttlMs
  const rows = db
    .prepare(
      `SELECT account_id FROM harness_account_limits
     WHERE kind IN ('usage-limit', 'spend-limit')
       AND detected_at >= ? AND (resets_at IS NULL OR resets_at > ?)`,
    )
    .all(cutoff, now) as Array<{ account_id: string }>
  return new Set(rows.map((row) => row.account_id))
}
