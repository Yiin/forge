import { accountKindForHarness } from '../../lib/harness-accounts-logic'

/** Agents without managed accounts that still have a brand mark. */
const EXTRA_MARK_KINDS = ['cursor', 'hermes', 'devin'] as const

/**
 * Resolves the brand kind for a harness config entry: the account kind when
 * the harness has one, else a known agent name found in the key, command, or
 * args, else the key itself (HarnessMark falls back to a generic icon).
 */
export function harnessMarkKind(
  key: string,
  harness?: { command?: string; args?: string[] },
): string {
  const accountKind = accountKindForHarness(key, harness)
  if (accountKind) return accountKind
  const tokens = [key, harness?.command ?? '', ...(harness?.args ?? [])]
    .join(' ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
  return EXTRA_MARK_KINDS.find((kind) => tokens.includes(kind)) ?? key
}
