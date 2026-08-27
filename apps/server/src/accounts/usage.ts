type Db = { prepare(sql: string): any; exec(sql: string): unknown }

export type UsageWindow = {
  windowKey: string
  label: string
  percent: number
  resetsAt: number | null
  source: string
  observedAt?: number
  status?: string
  detail?: string | null
}

export type UsageSnapshot = UsageWindow & { tierLabel?: string }

export function recordUsageSnapshot(
  db: Db,
  accountId: string,
  rows: UsageSnapshot[],
) {
  db.exec('BEGIN')
  try {
    const upsert = db.prepare(`
      INSERT INTO harness_account_usage
        (account_id, window_key, label, percent, resets_at, tier_label, source, status, detail, observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, window_key) DO UPDATE SET
        label = excluded.label, percent = excluded.percent, resets_at = excluded.resets_at,
        tier_label = excluded.tier_label, source = excluded.source, status = excluded.status,
        detail = excluded.detail, observed_at = excluded.observed_at
      WHERE excluded.observed_at >= harness_account_usage.observed_at
    `)
    for (const row of rows)
      upsert.run(
        accountId,
        row.windowKey,
        row.label,
        row.percent,
        row.resetsAt,
        row.tierLabel ?? null,
        row.source,
        row.status ?? 'ok',
        row.detail?.slice(0, 200) ?? null,
        row.observedAt ?? Date.now(),
      )
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function readUsage(db: Db, accountId: string): UsageSnapshot[] {
  const rows = db
    .prepare(
      `
    SELECT window_key, label, percent, resets_at, tier_label, source, status, detail, observed_at
    FROM harness_account_usage WHERE account_id = ? ORDER BY window_key
  `,
    )
    .all(accountId) as Array<Record<string, unknown>>
  return rows.map((row) => ({
    windowKey: row.window_key as string,
    label: row.label as string,
    percent: row.percent as number,
    resetsAt: row.resets_at as number | null,
    tierLabel: (row.tier_label as string | null) ?? undefined,
    source: row.source as string,
    status: row.status as string,
    detail: row.detail as string | null,
    observedAt: row.observed_at as number,
  }))
}

export function updateUsageStatus(
  db: Db,
  accountId: string,
  status: string,
  detail: string | null,
  observedAt = Date.now(),
) {
  db.prepare(
    `UPDATE harness_account_usage SET status = ?, detail = ?
    WHERE account_id = ? AND (resets_at IS NULL OR resets_at > ?)`,
  ).run(status, detail?.slice(0, 200) ?? null, accountId, observedAt)
}

export function clearExpiredUsage(db: Db, now: number) {
  db.prepare(
    'DELETE FROM harness_account_usage WHERE resets_at IS NOT NULL AND resets_at <= ?',
  ).run(now)
}

export function pruneObservedBefore(db: Db, cutoff: number) {
  db.prepare('DELETE FROM harness_account_usage WHERE observed_at < ?').run(
    cutoff,
  )
}
