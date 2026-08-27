import {
  accountAuthenticated,
  accountEnv,
  HarnessAccountStore,
} from './store.js'
import { clearExpiredLimits } from './limits.js'
import {
  clearExpiredUsage,
  pruneObservedBefore,
  recordUsageSnapshot,
  updateUsageStatus,
  type UsageSnapshot,
  type UsageWindow,
} from './usage.js'

type Db = { prepare(sql: string): any; exec(sql: string): unknown }
export type UsageProbeResult = {
  status: 'ok' | 'auth' | 'unavailable' | 'unsupported'
  tierLabel?: string
  windows: UsageWindow[]
  detail?: string
  retryAdvised?: boolean
}
export type UsageProbe = (ctx: {
  accountId: string
  kind: string
  harnessKey: string
  homePath: string
  env: Record<string, string>
  db: Db
}) => Promise<UsageProbeResult>

export const unsupportedUsageProbe: UsageProbe = async () => ({
  status: 'unsupported',
  windows: [],
  detail: 'No usage data is available for this provider',
})

export type UsagePollerOptions = {
  db: Db
  probes?: Map<string, UsageProbe>
  intervalMs?: number
  jitterMs?: number
  concurrency?: number
  random?: () => number
}

const floorMs = 30_000
const minAccountMs = 15_000
const retryMs = 30_000

export class UsagePoller {
  readonly intervalMs: number
  private readonly probes: Map<string, UsageProbe>
  private readonly accounts: HarnessAccountStore
  private readonly jitterMs: number
  private readonly concurrency: number
  private readonly random: () => number
  private readonly lastPoll = new Map<string, number>()
  private readonly retries = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = false

  constructor(private readonly options: UsagePollerOptions) {
    this.intervalMs = Math.max(floorMs, options.intervalMs ?? 300_000)
    this.probes = options.probes ?? new Map()
    this.accounts = new HarnessAccountStore(options.db)
    this.jitterMs = options.jitterMs ?? Math.min(10_000, this.intervalMs / 10)
    this.concurrency = Math.max(1, options.concurrency ?? 4)
    this.random = options.random ?? Math.random
  }

  start() {
    this.stopped = false
    void this.pollAll()
    this.schedule(this.intervalMs)
    return this
  }

  stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  async refresh(accountId: string) {
    return this.pollAccount(accountId, true)
  }

  private schedule(delay: number) {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      void this.pollAll().finally(() =>
        this.schedule(
          this.intervalMs + Math.floor(this.random() * this.jitterMs),
        ),
      )
    }, delay)
    if (typeof this.timer === 'object' && 'unref' in this.timer)
      this.timer.unref()
  }

  private async pollAll() {
    const accounts = this.accounts.list()
    let cursor = 0
    const worker = async () => {
      while (cursor < accounts.length) {
        const account = accounts[cursor++]!
        await this.pollAccount(account.id, false)
      }
    }
    await Promise.all(
      Array.from(
        { length: Math.min(this.concurrency, accounts.length) },
        worker,
      ),
    )
    const now = Date.now()
    pruneObservedBefore(this.options.db, now - 7 * 24 * 60 * 60 * 1000)
    clearExpiredUsage(this.options.db, now)
    clearExpiredLimits(this.options.db, now)
  }

  private async pollAccount(accountId: string, forced: boolean) {
    const account = this.accounts.get(accountId)
    if (!account || account.disabledAt !== null) return
    const probe = this.probes.get(account.kind)
    if (!probe) return
    const now = Date.now()
    if (!forced && now - (this.lastPoll.get(accountId) ?? 0) < minAccountMs)
      return
    this.lastPoll.set(accountId, now)
    if (!accountAuthenticated(account.kind, account.homePath)) {
      recordUsageSnapshot(this.options.db, account.id, [
        {
          windowKey: '__status',
          label: 'Usage',
          percent: 0,
          resetsAt: null,
          source: 'usage-poller',
          status: 'auth',
          detail: 'Account is not authenticated',
          observedAt: now,
        },
      ])
      return
    }
    let result: UsageProbeResult
    try {
      result = await probe({
        accountId: account.id,
        kind: account.kind,
        harnessKey: account.harnessKey,
        homePath: account.homePath,
        env: accountEnv(account.kind, account.homePath),
        db: this.options.db,
      })
    } catch (error) {
      updateUsageStatus(
        this.options.db,
        account.id,
        'unavailable',
        error instanceof Error ? error.message : String(error),
        now,
      )
      return
    }
    const rows: UsageSnapshot[] = result.windows.map((window) => ({
      ...window,
      tierLabel: result.tierLabel,
      status: result.status,
      detail: result.detail,
      observedAt: now,
    }))
    if (rows.length) recordUsageSnapshot(this.options.db, account.id, rows)
    else
      updateUsageStatus(
        this.options.db,
        account.id,
        result.status,
        result.detail ?? null,
        now,
      )
    if (result.retryAdvised && !forced && !this.retries.has(account.id)) {
      this.retries.add(account.id)
      const retry = setTimeout(() => {
        this.retries.delete(account.id)
        void this.pollAccount(account.id, false)
      }, retryMs)
      if (typeof retry === 'object' && 'unref' in retry) retry.unref()
    }
  }
}
