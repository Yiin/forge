import { Hono } from 'hono'
import { harnessHealthResponseSchema } from '@forge/protocol/status'
import type { ConfigState } from '../config.js'
import { clearExpiredLimits } from '../accounts/limits.js'
import { accountAuthenticated, HarnessAccountStore } from '../accounts/store.js'
import { clearExpiredUsage, readUsage } from '../accounts/usage.js'
import { readAccountIdentity } from '../accounts/identity.js'
import type { SessionManager } from '../sessions/manager.js'

type Db = { prepare(sql: string): any; exec(sql: string): unknown }

export function createHarnessHealthReader(options: {
  db: Db
  configState: ConfigState
  manager: SessionManager
}) {
  const accounts = new HarnessAccountStore(options.db)
  const read = () => {
    const now = Date.now()
    clearExpiredLimits(options.db, now)
    clearExpiredUsage(options.db, now)
    return harnessHealthResponseSchema.parse(
      Object.entries(options.configState.current.harness).map(
        ([key, config]) => ({
          key,
          name: config.name,
          command: config.command,
          args: config.args,
          protocol: config.protocol,
          enabled: config.enabled,
          accounts: accounts.list(key).map((account) => {
            if (
              account.identity === null &&
              (accountAuthenticated(account.kind, account.homePath) ||
                accounts.identityCheckedAt(account.id) === null)
            )
              accounts.saveIdentity(
                account.id,
                readAccountIdentity(account.kind, account.homePath),
              )
            else if (
              accounts.identityCheckedAt(account.id) !== null &&
              now - accounts.identityCheckedAt(account.id)! >= 10 * 60 * 1000
            )
              accounts.saveIdentity(
                account.id,
                readAccountIdentity(account.kind, account.homePath),
              )
            const current = accounts.get(account.id) ?? account
            const cooldown = options.db
              .prepare(
                `SELECT kind, detected_at, resets_at, resets_at_estimated, detail
                 FROM harness_account_limits
                 WHERE account_id = ? ORDER BY detected_at DESC LIMIT 1`,
              )
              .get(account.id) as
              | {
                  kind: string
                  detected_at: number
                  resets_at: number | null
                  resets_at_estimated: number
                  detail: string | null
                }
              | undefined
            const usageRows = readUsage(options.db, account.id)
            const visibleUsage = usageRows.filter(
              (row) => row.windowKey !== '__status',
            )
            return {
              id: account.id,
              label: current.label,
              kind: current.kind,
              homePath: current.homePath,
              order: current.orderIndex,
              disabled: current.disabledAt !== null,
              authenticated: current.identity?.status === 'authenticated',
              identity: current.identity,
              cooldown: cooldown
                ? {
                    kind: cooldown.kind,
                    detectedAt: cooldown.detected_at,
                    resetsAt: cooldown.resets_at,
                    resetsAtEstimated: cooldown.resets_at_estimated === 1,
                    detail: cooldown.detail,
                  }
                : null,
              usage: visibleUsage.length
                ? visibleUsage.map((row) => ({
                    windowKey: row.windowKey,
                    label: row.label,
                    percent: row.percent,
                    resetsAt: row.resetsAt,
                    source: row.source,
                    observedAt: row.observedAt!,
                  }))
                : undefined,
              tierLabel: usageRows.find((row) => row.tierLabel)?.tierLabel,
              usageStatus: usageRows.find((row) => row.status !== 'ok')
                ?.status as 'auth' | 'unavailable' | 'unsupported' | undefined,
            }
          }),
          liveProcesses: options.manager.liveProcessCount(key),
        }),
      ),
    )
  }
  return read
}

export function harnessHealthRoutes(
  options: Parameters<typeof createHarnessHealthReader>[0],
) {
  const read = createHarnessHealthReader(options)
  const app = new Hono()
  app.get('/api/harnesses/health', (c) => c.json(read()))
  return app
}
