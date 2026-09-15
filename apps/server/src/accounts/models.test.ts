import {
  NativeCleanupError,
  closeNativeDiscovery,
} from '../harnesses/native-cleanup.js'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { migrate } from '../db/migrate.js'
import { harnessAccountRoutes } from '../http/harnessAccounts.js'
import type { ModelEntry } from '@forge/protocol/models'
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
  source: 'native' as const,
  updatedAt,
})

describe('account model catalogs', () => {
  it('does not launch an already cancelled probe', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const controller = new AbortController()
    controller.abort()
    let called = false
    try {
      await refreshAccountModels(db, {
        accountId: 'cancelled',
        harnessKey: 'codex',
        signal: controller.signal,
        probe: async () => {
          called = true
          return []
        },
      })
      expect(called).toBe(false)
    } finally {
      db.close()
    }
  })

  it('holds a timed out probe until its original cleanup settles', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let observedAbort!: () => void
    const aborted = new Promise<void>((resolve) => {
      observedAbort = resolve
    })
    let settled = false
    const work = refreshAccountModels(
      db,
      {
        accountId: 'held',
        harnessKey: 'codex',
        probe: async (signal) => {
          signal.addEventListener('abort', observedAbort, { once: true })
          await held
          return [{ id: 'late', displayName: 'Late' }]
        },
      },
      5,
    ).then((value) => {
      settled = true
      return value
    })
    try {
      await aborted
      await Promise.resolve()
      expect(settled).toBe(false)
      release()
      expect(await work).toBeNull()
      expect(readAccountModels(db, 'held')).toBeNull()
    } finally {
      release()
      await work
      db.close()
    }
  })

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

  it('aborts a timed-out native probe', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    let aborted = false
    const result = await refreshAccountModels(
      db,
      {
        accountId: 'account-1',
        harnessKey: 'codex',
        probe: async (signal) =>
          new Promise<ModelEntry[]>((resolve) => {
            signal.addEventListener('abort', () => {
              aborted = true
              resolve([{ id: 'ignored', displayName: 'Ignored' }])
            })
          }),
      },
      1,
    )
    expect(aborted).toBe(true)
    expect(result).toBeNull()
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

it.each(['ordinary', 'cleanup'] as const)(
  'joins original cleanup after timeout and preserves %s failure',
  async (kind) => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    writeAccountModels(db, catalog())
    let release!: () => void, aborted!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const cancelled = new Promise<void>((resolve) => {
      aborted = resolve
    })
    let settled = false
    const work = refreshAccountModels(
      db,
      {
        accountId: 'account-1',
        harnessKey: 'kimi',
        probe: async (signal) => {
          await new Promise<void>((resolve) =>
            signal.addEventListener(
              'abort',
              () => {
                aborted()
                resolve()
              },
              { once: true },
            ),
          )
          await closeNativeDiscovery(async () => {
            await held
            if (kind === 'cleanup')
              throw Error('credential=private-cleanup-value')
          })
          throw Error('catalog failed')
        },
      },
      5,
    )
    const observed = work
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      )
      .finally(() => {
        settled = true
      })
    try {
      await cancelled
      await Promise.resolve()
      expect(settled).toBe(false)
      release()
      const result = await observed
      if (kind === 'cleanup') {
        expect(result).toHaveProperty('error')
        if ('error' in result) {
          expect(result.error).toBeInstanceOf(NativeCleanupError)
          expect(result.error.message).toBe('Native cleanup failed')
          expect(result.error.cause).toBeUndefined()
        }
        expect(readAccountModels(db, 'account-1')?.warning).toBeUndefined()
      } else
        expect(result).toMatchObject({ value: { models: catalog().models } })
    } finally {
      release()
      await observed
      db.close()
    }
  },
)
it('propagates immediate cleanup failure instead of returning the previous catalog', async () => {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  writeAccountModels(db, catalog())
  const failure = new NativeCleanupError(async () => {})
  try {
    await expect(
      refreshAccountModels(db, {
        accountId: 'account-1',
        harnessKey: 'kimi',
        probe: async () => {
          throw failure
        },
      }),
    ).rejects.toBe(failure)
  } finally {
    db.close()
  }
})
