import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { migrate } from '../db/migrate.js'
import { harnessAccountRoutes } from '../http/harnessAccounts.js'
import {
  MODEL_CATALOG_TTL_MS,
  isAccountModelsStale,
  readAccountModels,
  recordModelProbeFailure,
  refreshAccountModels,
  writeAccountModels,
} from './models.js'

const catalog = (updatedAt = Date.now()) => ({
  accountId: 'account-1',
  harnessKey: 'kimi',
  models: [{ id: 'k3', displayName: 'Kimi K3' }],
  source: 'acp' as const,
  updatedAt,
})

describe('account model catalogs', () => {
  it('round trips, detects TTL staleness, and keeps non-empty data', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const initial = catalog()
    writeAccountModels(db, initial)
    expect(readAccountModels(db, 'account-1')).toEqual(initial)
    expect(
      isAccountModelsStale(readAccountModels(db, 'account-1'), Date.now()),
    ).toBe(false)
    expect(
      isAccountModelsStale(catalog(Date.now() - MODEL_CATALOG_TTL_MS - 1)),
    ).toBe(true)
    writeAccountModels(db, { ...catalog(), models: [], source: 'none' })
    expect(readAccountModels(db, 'account-1')?.models).toHaveLength(1)
  })

  it('records a probe warning without removing the previous catalog', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    writeAccountModels(db, catalog())
    recordModelProbeFailure(
      db,
      readAccountModels(db, 'account-1'),
      'probe failed',
    )
    expect(readAccountModels(db, 'account-1')).toMatchObject({
      models: catalog().models,
      warning: 'probe failed',
    })
  })

  it('keeps the previous catalog when a refresh probe fails', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    writeAccountModels(db, catalog())
    await refreshAccountModels(db, {
      accountId: 'account-1',
      harnessKey: 'kimi',
      probe: async () => {
        throw new Error('not authenticated')
      },
    })
    expect(readAccountModels(db, 'account-1')).toMatchObject({
      models: catalog().models,
      warning: 'not authenticated',
    })
  })

  it('serves a cached catalog and preserves the account 404', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    db.prepare(
      `INSERT INTO harness_accounts
      (id, harness_key, label, kind, home_path, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('account-1', 'kimi', 'Work', 'kimi', '/tmp/account-1', Date.now())
    writeAccountModels(db, catalog())
    const app = harnessAccountRoutes(db)
    const response = await app.request('/api/harness-accounts/account-1/models')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      accountId: 'account-1',
      models: catalog().models,
    })
    expect(
      (await app.request('/api/harness-accounts/missing/models')).status,
    ).toBe(404)
  })
})
