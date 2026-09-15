import { NativeCleanupError } from '../harnesses/native-cleanup.js'
import type {
  ModelCatalog,
  ModelEntry,
  ModelSource,
} from '@forge/protocol/models'

export const MODEL_CATALOG_TTL_MS = 15 * 60 * 1000
export const MODEL_PROBE_TIMEOUT_MS = 15_000
type Db = {
  prepare(sql: string): {
    get(...args: unknown[]): unknown
    run(...args: unknown[]): unknown
  }
}

export function readAccountModels(
  db: Db,
  accountId: string,
): ModelCatalog | null {
  const row = db
    .prepare('SELECT * FROM harness_account_models WHERE account_id = ?')
    .get(accountId) as Record<string, unknown> | undefined
  if (!row) return null
  return {
    accountId: String(row.account_id),
    harnessKey: String(row.harness_key),
    models: JSON.parse(String(row.models)) as ModelEntry[],
    source: row.source as ModelSource,
    updatedAt: Number(row.updated_at),
    ...(typeof row.warning === 'string' && row.warning
      ? { warning: row.warning }
      : {}),
  }
}

export function writeAccountModels(db: Db, catalog: ModelCatalog): void {
  if (
    !catalog.models.length &&
    readAccountModels(db, catalog.accountId)?.models.length
  )
    return
  db.prepare(
    `INSERT INTO harness_account_models
    (account_id, harness_key, models, source, warning, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET harness_key=excluded.harness_key,
    models=excluded.models, source=excluded.source, warning=excluded.warning,
    updated_at=excluded.updated_at`,
  ).run(
    catalog.accountId,
    catalog.harnessKey,
    JSON.stringify(catalog.models),
    catalog.source,
    catalog.warning ?? null,
    catalog.updatedAt,
  )
}

export function isAccountModelsStale(
  catalog: ModelCatalog | null,
  now = Date.now(),
): boolean {
  return !catalog || now - catalog.updatedAt >= MODEL_CATALOG_TTL_MS
}

export function recordModelProbeFailure(
  db: Db,
  catalog: ModelCatalog | null,
  warning: string,
): void {
  if (catalog)
    writeAccountModels(db, { ...catalog, warning, updatedAt: Date.now() })
}

export async function refreshAccountModels(
  db: Db,
  input: {
    accountId: string
    harnessKey: string
    probe: (signal: AbortSignal) => Promise<ModelEntry[]>
    signal?: AbortSignal
  },
  timeoutMs = MODEL_PROBE_TIMEOUT_MS,
): Promise<ModelCatalog | null> {
  const previous = readAccountModels(db, input.accountId)
  let timer: ReturnType<typeof setTimeout> | undefined
  const controller = new AbortController()
  const abortExternal = () => controller.abort()
  if (input.signal?.aborted) controller.abort()
  input.signal?.addEventListener('abort', abortExternal, { once: true })
  let work: Promise<ModelEntry[]> | undefined
  try {
    if (controller.signal.aborted)
      throw new Error('native model discovery cancelled')
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error(`model probe timed out after ${timeoutMs}ms`))
      }, timeoutMs)
    })
    work = Promise.resolve().then(() => input.probe(controller.signal))
    const models = await Promise.race([work, timeout])
    controller.signal.throwIfAborted()
    if (timer) clearTimeout(timer)
    if (!models.length) return previous
    const next = {
      accountId: input.accountId,
      harnessKey: input.harnessKey,
      models,
      source: 'native' as const,
      updatedAt: Date.now(),
    }
    writeAccountModels(db, next)
    return next
  } catch (error) {
    controller.abort()
    if (timer) clearTimeout(timer)
    // A logical timeout cannot turn a later physical cleanup failure into cached success.
    if (work) {
      try {
        await work
      } catch (physical) {
        if (physical instanceof NativeCleanupError) throw physical
      }
    }
    if (error instanceof NativeCleanupError) throw error
    recordModelProbeFailure(
      db,
      previous,
      error instanceof Error ? error.message : String(error),
    )
    return previous
  } finally {
    input.signal?.removeEventListener('abort', abortExternal)
  }
}
