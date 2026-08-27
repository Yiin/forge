import type { HarnessConfig } from '@forge/protocol/config'

export const HARNESS_KINDS = ['claude', 'codex', 'kimi', 'opencode'] as const
export type HarnessKind = (typeof HARNESS_KINDS)[number]

const ISOLATION_ENV: Record<HarnessKind, string> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
  kimi: 'KIMI_SHARE_DIR',
  opencode: 'XDG_DATA_HOME',
}

const ACCOUNT_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/

export function validateAccountId(
  id: string,
  existing: Iterable<string> = [],
): string | null {
  if (id.length === 0) return 'Account ID is required.'
  if (id.length > 64) return 'Account ID must be 64 characters or fewer.'
  if (!ACCOUNT_ID_PATTERN.test(id))
    return "Account ID must start with a letter and use only letters, digits, '-', or '_'."
  if (new Set(existing).has(id))
    return `An account named '${id}' already exists.`
  return null
}

export function nextAccountIdentity(
  harnessKind: HarnessKind,
  occupiedIds: ReadonlySet<string>,
): { accountId: string; displayName: string } {
  for (let number = 2; ; number += 1) {
    const displayName = `Account ${number}`
    const accountId = `${harnessKind}_account_${number}`
    if (!occupiedIds.has(accountId)) return { accountId, displayName }
  }
}

export interface HarnessAccountHarness extends HarnessConfig {
  readonly harnessKind: string
}

export function readAccountHome(
  harness: Pick<HarnessAccountHarness, 'harnessKind' | 'env'>,
): string | null {
  const variable = ISOLATION_ENV[harness.harnessKind as HarnessKind]
  const value = variable === undefined ? undefined : harness.env[variable]
  return value?.trim() || null
}

export function withAccountHome(
  harness: HarnessAccountHarness,
  homePath: string,
): HarnessAccountHarness {
  const variable = ISOLATION_ENV[harness.harnessKind as HarnessKind]
  if (variable === undefined) return harness
  return { ...harness, env: { ...harness.env, [variable]: homePath } }
}

function normalizePath(value: string): string {
  return value
    .trim()
    .replaceAll('\\', '/')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/g, '')
}

export function isManagedAccountHome(input: {
  homePath: string | null
  accountsDir: string | null | undefined
  harnessKind: string
  accountId: string
}): boolean {
  if (input.homePath === null || !input.accountsDir?.trim()) return false
  return (
    normalizePath(input.homePath) ===
    `${normalizePath(input.accountsDir)}/${input.harnessKind}/${input.accountId}`
  )
}

export type AccountAuthAction =
  | { kind: 'sign-in' }
  | { kind: 'sign-out' }
  | { kind: 'manual'; command: string | null }
  | { kind: 'none' }

const SCRIPTABLE = new Set<HarnessKind>(HARNESS_KINDS)

export function resolveAccountAuthAction(input: {
  harnessKind: string
  authStatus: 'authenticated' | 'unauthenticated' | 'unknown'
  serverMessage?: string | null
}): AccountAuthAction {
  if (SCRIPTABLE.has(input.harnessKind as HarnessKind)) {
    if (input.authStatus === 'authenticated') return { kind: 'sign-out' }
    if (input.authStatus === 'unauthenticated') return { kind: 'sign-in' }
    return { kind: 'none' }
  }
  if (input.authStatus === 'authenticated') return { kind: 'none' }
  return {
    kind: 'manual',
    command: input.serverMessage?.match(/\bRun `([^`]+)`/)?.[1] ?? null,
  }
}

export type LoginRunStatus =
  'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export interface LoginRunState {
  status: LoginRunStatus
  startedAt: string | null
  finishedAt: string | null
  message: string | null
  output: string
  verificationUrl: string | null
  userCode: string | null
}

export function reduceLoginRunState(
  current: LoginRunState | null,
  incoming: LoginRunState,
): LoginRunState {
  if (current === null) return incoming
  const terminal = (status: LoginRunStatus) =>
    ['succeeded', 'failed', 'cancelled'].includes(status)
  if (terminal(current.status) && !terminal(incoming.status)) return current
  if (incoming.status === 'idle' && current.status !== 'idle') return current
  return {
    ...incoming,
    startedAt: incoming.startedAt ?? current.startedAt,
    finishedAt: incoming.finishedAt ?? current.finishedAt,
    message: incoming.message ?? current.message,
    output: incoming.output || current.output,
    verificationUrl: incoming.verificationUrl ?? current.verificationUrl,
    userCode: incoming.userCode ?? current.userCode,
  }
}

export interface AccountRowLike {
  accountId: string
  availability: string
}

export function orderAccountRows<T extends AccountRowLike>(
  rows: ReadonlyArray<T>,
  explicitKeyOrder: ReadonlyArray<string>,
): T[] {
  const indexes = new Map(explicitKeyOrder.map((key, index) => [key, index]))
  const ordered = [...rows].sort(
    (a, b) =>
      (indexes.get(a.accountId) ?? explicitKeyOrder.length) -
      (indexes.get(b.accountId) ?? explicitKeyOrder.length),
  )
  return [
    ...ordered.filter((row) => row.availability !== 'unavailable'),
    ...ordered.filter((row) => row.availability === 'unavailable'),
  ]
}

export function moveAccount<T extends AccountRowLike>(
  rows: ReadonlyArray<T>,
  accountId: string,
  direction: 'up' | 'down',
): T[] | null {
  const from = rows.findIndex((row) => row.accountId === accountId)
  const to = direction === 'up' ? from - 1 : from + 1
  if (from < 0 || to < 0 || to >= rows.length) return null
  const next = [...rows]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved!)
  return next
}

export interface AccountGroupMember {
  accountId: string
  harness: HarnessConfig
}

export function buildAccountReorderPatch(input: {
  config: { harness: Record<string, HarnessConfig> }
  groupOrder: ReadonlyArray<AccountGroupMember>
}): { harness: Record<string, HarnessConfig> } {
  const current = input.config.harness
  const ids = new Set(input.groupOrder.map((entry) => entry.accountId))
  const queue = [...input.groupOrder]
  const next: Record<string, HarnessConfig> = {}
  for (const [id, harness] of Object.entries(current)) {
    if (ids.has(id)) {
      const entry = queue.shift()
      if (entry) next[entry.accountId] = entry.harness
    } else next[id] = harness
  }
  for (const entry of queue) next[entry.accountId] = entry.harness
  return { harness: next }
}

export const LIMIT_KIND_LABELS = {
  'usage-limit': 'Usage limit reached',
  'spend-limit': 'Spend limit reached',
  'credits-depleted': 'Credits depleted',
  auth: 'Sign-in required',
  unavailable: 'Account unavailable',
} as const

export const USAGE_WINDOW_LABELS: Record<string, string> = {
  five_hour: '5h window',
  seven_day: '7d window',
  seven_day_opus: '7d Opus window',
  seven_day_sonnet: '7d Sonnet window',
  overage: 'overage',
  primary: 'primary window',
  secondary: 'secondary window',
}

export interface UsageSample {
  utilization: number
  window: string
  resetsAt: string | null
}
export interface AccountLimit {
  kind: keyof typeof LIMIT_KIND_LABELS
  resetsAt: string | null
}
export interface AccountLimitState {
  utilization: {
    percent: number
    windowLabel: string
    resetsAt: string | null
  } | null
  blocked: { label: string; resetsAt: string | null } | null
}

export function deriveAccountLimitState(input: {
  usage?: ReadonlyArray<UsageSample>
  limit?: AccountLimit | null
  nowMs: number
}): AccountLimitState | null {
  const live = (resetsAt: string | null) =>
    resetsAt === null || Date.parse(resetsAt) > input.nowMs
  const worst = (input.usage ?? [])
    .filter((sample) => live(sample.resetsAt))
    .sort((a, b) => b.utilization - a.utilization)[0]
  const utilization = worst
    ? {
        percent: Math.round(Math.max(0, worst.utilization)),
        windowLabel: USAGE_WINDOW_LABELS[worst.window] ?? worst.window,
        resetsAt: worst.resetsAt,
      }
    : null
  const blocked =
    input.limit && live(input.limit.resetsAt)
      ? {
          label: LIMIT_KIND_LABELS[input.limit.kind],
          resetsAt: input.limit.resetsAt,
        }
      : null
  return utilization || blocked ? { utilization, blocked } : null
}

export function formatResetCountdown(
  resetsAt: string,
  nowMs: number,
): string | null {
  const remaining = Date.parse(resetsAt) - nowMs
  if (!Number.isFinite(remaining) || remaining <= 0) return null
  const minutes = Math.ceil(remaining / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  if (days) return hours ? `${days}d ${hours}h` : `${days}d`
  if (hours) return mins ? `${hours}h ${mins}m` : `${hours}h`
  return `${mins}m`
}
