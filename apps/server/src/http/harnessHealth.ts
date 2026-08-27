import { Hono } from 'hono'
import { harnessHealthResponseSchema } from '@forge/protocol/status'
import type { ConfigState } from '../config.js'
import { clearExpiredLimits } from '../accounts/limits.js'
import { accountAuthenticated, HarnessAccountStore } from '../accounts/store.js'
import type { SessionManager } from '../sessions/manager.js'

type Db = { prepare(sql: string): any }

export function createHarnessHealthReader(options: {
  db: Db
  configState: ConfigState
  manager: SessionManager
}) {
  const accounts = new HarnessAccountStore(options.db)
  const read = () => {
    const now = Date.now()
    clearExpiredLimits(options.db, now)
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
            return {
              id: account.id,
              label: account.label,
              order: account.orderIndex,
              disabled: account.disabledAt !== null,
              authenticated: accountAuthenticated(
                account.kind,
                account.homePath,
              ),
              cooldown: cooldown
                ? {
                    kind: cooldown.kind,
                    detectedAt: cooldown.detected_at,
                    resetsAt: cooldown.resets_at,
                    resetsAtEstimated: cooldown.resets_at_estimated === 1,
                    detail: cooldown.detail,
                  }
                : null,
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
