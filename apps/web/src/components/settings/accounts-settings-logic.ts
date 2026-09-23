import type { HarnessConfig } from '@forge/protocol/config'
import type {
  Account,
  HarnessAccountSnapshot,
  HarnessHealthSummary,
} from '@/lib/accounts-api'
import {
  KIND_LABELS,
  LIMIT_KIND_LABELS,
  accountKindForHarness,
  activeAccount,
  isAccountCooling,
  isAccountUsable,
  moveAccount,
  resolveAccountAuthAction,
  type AccountAuthAction,
  type HarnessKind,
} from '@/lib/harness-accounts-logic'
import { harnessMarkKind } from './harness-mark-logic'

export type AccountUsageWindow = {
  id: string
  label: string
  percent: number
  resetsAt: string | null
}

export type AccountRowModel = {
  id: string
  harnessKey: string
  kind: string
  label: string
  email: string | null
  initial: string
  homePath: string
  config: Account['config']
  disabled: boolean
  cooling: boolean
  signedIn: boolean
  authAction: AccountAuthAction
  /** New sessions of this harness use this account. */
  active: boolean
  /** Switch makes this account active: it is usable, signed in, not active. */
  switchable: boolean
  plan: string | null
  usage: AccountUsageWindow[]
  limit: { label: string; resetsAt: string | null } | null
}

export type AccountSectionModel = {
  key: string
  name: string
  markKind: string
  /** Account kind new accounts get; null when this harness has no managed accounts. */
  accountKind: HarnessKind | null
  command: string | null
  installed: boolean
  enabled: boolean
  rows: AccountRowModel[]
}

function buildRow(
  account: Account,
  snapshot: HarnessAccountSnapshot | undefined,
  nowMs: number,
): Omit<AccountRowModel, 'active' | 'switchable'> {
  const authStatus = snapshot?.auth.status ?? account.authStatus
  const signedIn = authStatus === 'authenticated'
  const email = snapshot?.auth.email ?? account.email ?? null
  const limit = snapshot?.limit
  const liveLimit =
    limit && (limit.resetsAt === null || Date.parse(limit.resetsAt) > nowMs)
      ? { label: LIMIT_KIND_LABELS[limit.kind], resetsAt: limit.resetsAt }
      : null
  return {
    id: account.id,
    harnessKey: account.harnessKey,
    kind: account.kind,
    label: account.label,
    email,
    initial: (email ?? account.label).trim().charAt(0).toUpperCase() || '?',
    homePath: account.homePath,
    config: account.config,
    disabled: !account.enabled,
    cooling: isAccountCooling(account.cooldownUntil, nowMs),
    signedIn,
    authAction: resolveAccountAuthAction({
      harnessKind: account.kind,
      authStatus,
      serverMessage: snapshot?.message,
    }),
    plan: snapshot?.tierLabel ?? snapshot?.auth.plan ?? null,
    usage: signedIn
      ? (snapshot?.usage ?? []).map((window, index) => ({
          id: window.windowId ?? `${window.window}-${index}`,
          label: window.window,
          // The server stores usage as a 0..1 fraction.
          percent: window.utilization * 100,
          resetsAt: window.resetsAt,
        }))
      : [],
    limit: liveLimit,
  }
}

/**
 * One section per harness that can hold accounts (a managed account kind) or
 * already holds some, in config order; harness keys that only exist on
 * accounts come last. Rows keep the server's rotation order.
 */
export function buildAccountSections(input: {
  config: Record<string, HarnessConfig>
  health: ReadonlyArray<HarnessHealthSummary>
  accounts: ReadonlyArray<Account>
  snapshots: ReadonlyArray<HarnessAccountSnapshot>
  nowMs: number
}): AccountSectionModel[] {
  const snapshots = new Map(
    input.snapshots.map((snapshot) => [snapshot.accountId, snapshot]),
  )
  const keys = [
    ...new Set([
      ...Object.keys(input.config).filter(
        (key) =>
          accountKindForHarness(key, input.config[key]) ||
          input.accounts.some((account) => account.harnessKey === key),
      ),
      ...input.accounts.map((account) => account.harnessKey),
    ]),
  ]
  return keys.map((key) => {
    const harness = input.config[key]
    const health = input.health.find((entry) => entry.key === key)
    const accountKind = accountKindForHarness(key, harness)
    const rows = input.accounts
      .filter((account) => account.harnessKey === key)
      .map((account) =>
        buildRow(account, snapshots.get(account.id), input.nowMs),
      )
    const active = activeAccount(rows)
    return {
      key,
      name:
        harness?.name ||
        health?.name ||
        (accountKind ? KIND_LABELS[accountKind] : undefined) ||
        key,
      markKind: harnessMarkKind(key, harness),
      accountKind,
      command: harness?.command ?? health?.command ?? null,
      installed: health?.installed ?? true,
      enabled: harness?.enabled ?? health?.enabled ?? true,
      rows: rows.map((row) => ({
        ...row,
        active: row === active,
        switchable: row !== active && row.signedIn && isAccountUsable(row),
      })),
    }
  })
}

/** Rotation order after Switch: the chosen account first, the rest unchanged. */
export function orderWithFirst(
  ids: ReadonlyArray<string>,
  id: string,
): string[] {
  return [id, ...ids.filter((other) => other !== id)]
}

/** Rotation order after moving one account a step up or down; null at an end. */
export function orderWithMove(
  ids: ReadonlyArray<string>,
  id: string,
  direction: 'up' | 'down',
): string[] | null {
  return (
    moveAccount(
      ids.map((accountId) => ({ accountId, availability: 'available' })),
      id,
      direction,
    )?.map((row) => row.accountId) ?? null
  )
}

/** Default label for a new account: "Claude Account 3". */
export function newAccountLabel(section: AccountSectionModel): string {
  const kindLabel = section.accountKind
    ? KIND_LABELS[section.accountKind]
    : section.name
  return `${kindLabel} Account ${section.rows.length + 1}`
}

/** opencode and pi ask for a provider and a sign-in method first. */
export function needsLoginOptions(kind: string): boolean {
  return kind === 'opencode' || kind === 'pi'
}
