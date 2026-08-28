import { describe, expect, it } from 'vitest'
import {
  buildHarnessOptions,
  defaultSelection,
  type HarnessOption,
} from './harness-picker-logic'
import type { Account } from '@/lib/accounts-api'

const account = (patch: Partial<Account> = {}): Account => ({
  id: 'main',
  harness: 'claude',
  harnessKey: 'claude',
  kind: 'claude',
  label: 'Main',
  storageDir: '/tmp/main',
  homePath: '/tmp/main',
  enabled: true,
  authStatus: 'authenticated',
  email: null,
  cooldownUntil: null,
  cooldownReason: null,
  lastUsedAt: null,
  ...patch,
})

describe('harness picker logic', () => {
  it('groups zero, one, and several accounts', () => {
    const options = buildHarnessOptions(
      ['claude', 'codex', 'kimi'],
      [
        account(),
        account({ id: 'other', label: 'Other' }),
        account({ id: 'codex', harness: 'codex' }),
      ],
      0,
    )
    expect(options.map((option) => option.accounts.length)).toEqual([2, 1, 0])
    expect(options[2]).toMatchObject({
      disabled: true,
      disabledReason: 'No account',
    })
  })

  it('does not return an accountless selection', () => {
    const options = buildHarnessOptions(['claude'], [], 0)
    expect(defaultSelection(options, { harness: 'claude' })).toEqual({
      harness: '',
    })
  })

  it('marks cooling accounts and keeps them selectable', () => {
    const options = buildHarnessOptions(
      ['claude'],
      [account({ cooldownUntil: 61_000 })],
      0,
    )
    expect(options[0]!.accounts[0]).toMatchObject({
      cooling: true,
      coolingLabel: '2m',
      disabled: false,
    })
  })

  it('skips a cooling first account and falls back from stale selection', () => {
    const options: HarnessOption[] = buildHarnessOptions(
      ['claude', 'codex'],
      [
        account({ cooldownUntil: 60_001 }),
        account({ id: 'ready', harness: 'codex' }),
      ],
      0,
    )
    expect(defaultSelection(options, { harness: 'missing' })).toEqual({
      harness: 'codex',
      accountId: 'ready',
    })
    expect(
      defaultSelection(options, { harness: 'claude', accountId: 'main' }),
    ).toEqual({
      harness: 'codex',
      accountId: 'ready',
    })
  })
})
