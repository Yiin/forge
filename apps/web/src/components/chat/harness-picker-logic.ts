import type { Account } from '@/lib/accounts-api'
import {
  KIND_LABELS,
  activeAccount,
  formatAccountDisplayName,
  formatCooldown,
  isAccountCooling,
  isAccountUsable,
} from '@/lib/harness-accounts-logic'

export type HarnessOptionAccount = {
  id: string
  label: string
  cooling: boolean
  coolingLabel: string | null
  disabled: boolean
}
export type HarnessOption = {
  harness: string
  label: string
  accounts: HarnessOptionAccount[]
  accountOptional?: boolean
}
export type HarnessSelection = {
  harness: string
  accountId?: string
  model?: string
  configOptions?: Record<string, string | boolean>
}

export function buildHarnessOptions(
  harnesses: ReadonlyArray<
    | string
    | {
        key: string
        name?: string
        enabled?: boolean
        protocol?: 'acp' | 'pty'
        adapterKind?: 'native' | 'acp' | 'pty' | 'custom'
      }
  >,
  accounts: ReadonlyArray<Account>,
  nowMs: number,
): HarnessOption[] {
  return harnesses.flatMap((entry) => {
    const harness = typeof entry === 'string' ? entry : entry.key
    if (typeof entry !== 'string' && entry.enabled === false) return []
    const harnessLabel =
      typeof entry === 'string' ? entry : entry.name || entry.key
    const optionAccounts = accounts
      .filter((account) => account.harness === harness)
      .map((account, index) => {
        const cooling = isAccountCooling(account.cooldownUntil, nowMs)
        return {
          id: account.id,
          label: formatAccountDisplayName({
            kindLabel: KIND_LABELS[account.kind] ?? harnessLabel,
            ordinal: index + 1,
            label: account.label,
            identity: account.identity,
          }),
          cooling,
          coolingLabel:
            cooling && account.cooldownUntil !== null
              ? formatCooldown(
                  new Date(account.cooldownUntil).toISOString(),
                  nowMs,
                )
              : null,
          disabled: !account.enabled,
        }
      })
    const accountOptional =
      typeof entry !== 'string' &&
      (entry.protocol === 'pty' ||
        entry.adapterKind === 'acp' ||
        entry.adapterKind === 'custom')
    if (optionAccounts.length === 0 && !accountOptional) return []
    return [
      {
        harness,
        label: harnessLabel,
        accounts: optionAccounts,
        accountOptional,
      },
    ]
  })
}

export function defaultSelection(
  options: ReadonlyArray<HarnessOption>,
  current: HarnessSelection,
): HarnessSelection {
  const currentOption = options.find(
    (option) => option.harness === current.harness,
  )
  if (currentOption?.accountOptional && !current.accountId) return current
  const currentAccount = currentOption?.accounts.find(
    (account) => account.id === current.accountId,
  )
  if (currentOption && currentAccount && isAccountUsable(currentAccount))
    return current
  for (const option of options) {
    if (option.accountOptional) return { harness: option.harness }
    const account = activeAccount(option.accounts)
    if (account) return { harness: option.harness, accountId: account.id }
  }
  return { harness: '' }
}
