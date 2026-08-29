import type { Account } from '@/lib/accounts-api'
import { formatCooldown } from '@/lib/harness-accounts-logic'

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
  disabled: boolean
  disabledReason: string | null
}
export type HarnessSelection = {
  harness: string
  accountId?: string
  model?: string
}

export function buildHarnessOptions(
  harnesses: ReadonlyArray<string | { key: string }>,
  accounts: ReadonlyArray<Account>,
  nowMs: number,
): HarnessOption[] {
  return harnesses.map((entry) => {
    const harness = typeof entry === 'string' ? entry : entry.key
    const optionAccounts = accounts
      .filter((account) => account.harness === harness)
      .map((account) => {
        const cooling =
          account.cooldownUntil !== null && account.cooldownUntil > nowMs
        return {
          id: account.id,
          label: account.label,
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
    return {
      harness,
      label: harness,
      accounts: optionAccounts,
      disabled: optionAccounts.length === 0,
      disabledReason: optionAccounts.length === 0 ? 'No account' : null,
    }
  })
}

export function defaultSelection(
  options: ReadonlyArray<HarnessOption>,
  current: HarnessSelection,
): HarnessSelection {
  const currentOption = options.find(
    (option) => option.harness === current.harness,
  )
  const currentAccount = currentOption?.accounts.find(
    (account) => account.id === current.accountId,
  )
  if (
    currentOption &&
    currentAccount &&
    !currentAccount.cooling &&
    !currentAccount.disabled
  )
    return current
  const usable = options.find((option) => {
    const account = option.accounts[0]
    return account && !account.cooling && !account.disabled
  })
  if (usable)
    return { harness: usable.harness, accountId: usable.accounts[0]!.id }
  return { harness: '' }
}
