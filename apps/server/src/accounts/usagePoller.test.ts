import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrate } from '../db/migrate.js'
import { HarnessAccountStore } from './store.js'
import { unsupportedUsageProbe, UsagePoller } from './usagePoller.js'

const resources: Array<{ db: DatabaseSync; root: string }> = []
afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.db.close()
    rmSync(resource.root, { recursive: true, force: true })
  }
  delete process.env.FORGE_ACCOUNTS_DIR
})

describe('unsupported usage polling', () => {
  it('returns unsupported for Grok without creating usage rows', async () => {
    const db = new DatabaseSync(':memory:')
    const root = mkdtempSync(join(tmpdir(), 'forge-usage-poller-'))
    resources.push({ db, root })
    process.env.FORGE_ACCOUNTS_DIR = root
    migrate(db)
    const account = new HarnessAccountStore(db).create({
      harnessKey: 'grok',
      label: 'Grok',
      kind: 'grok',
    })
    writeFileSync(join(account.homePath, 'auth.json'), '{}')
    const poller = new UsagePoller({
      db,
      probes: new Map([['grok', unsupportedUsageProbe]]),
    })

    await poller.refresh(account.id)

    expect(
      await unsupportedUsageProbe({
        accountId: account.id,
        kind: 'grok',
        harnessKey: 'grok',
        homePath: account.homePath,
        env: {},
        db,
      }),
    ).toMatchObject({ status: 'unsupported', windows: [] })
    expect(db.prepare('SELECT * FROM harness_account_usage').all()).toEqual([])
  })
})
