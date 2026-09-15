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
  it('keeps only enabled harnesses with accounts and uses display names', () => {
    const options = buildHarnessOptions(
      [
        { key: 'claude', name: 'Claude' },
        { key: 'codex', name: 'Codex', enabled: false },
        { key: 'kimi', name: 'Kimi' },
        { key: 'fallback' },
      ],
      [
        account(),
        account({ id: 'other', label: 'Other' }),
        account({ id: 'codex', harness: 'codex' }),
      ],
      0,
    )
    expect(options.map((option) => option.harness)).toEqual(['claude'])
    expect(options[0]).toMatchObject({
      label: 'Claude',
      accounts: [{ id: 'main' }, { id: 'other' }],
    })

    expect(
      buildHarnessOptions(
        [{ key: 'fallback' }],
        [account({ harness: 'fallback' })],
        0,
      )[0]?.label,
    ).toBe('fallback')
  })

  it('does not return an accountless selection', () => {
    const options = buildHarnessOptions(['claude'], [], 0)
    expect(defaultSelection(options, { harness: 'claude' })).toEqual({
      harness: '',
    })
  })

  it('prefers the identity email over the stored label', () => {
    const options = buildHarnessOptions(
      [{ key: 'claude', name: 'Claude' }],
      [
        account({
          label: 'Claude Account 1',
          identity: { status: 'authenticated', email: 'me@example.com' },
        }),
        account({ id: 'work', label: 'Claude Account 2' }),
      ],
      0,
    )
    expect(options[0]!.accounts.map((item) => item.label)).toEqual([
      'Claude 1 - me@example.com',
      'Claude Account 2',
    ])
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

it('offers accountless ACP and PTY without inventing account rows', () => {
  const options = buildHarnessOptions(
    [
      { key: 'grok', adapterKind: 'acp' },
      { key: 'qa-acp', adapterKind: 'custom' },
      { key: 'shell', protocol: 'pty' },
      { key: 'claude', adapterKind: 'native' },
    ],
    [],
    0,
  )
  expect(options.map((option) => option.harness)).toEqual([
    'grok',
    'qa-acp',
    'shell',
  ])
  expect(options.every((option) => option.accounts.length === 0)).toBe(true)
  expect(
    defaultSelection(options, { harness: 'qa-acp', model: 'native' }),
  ).toEqual({ harness: 'qa-acp', model: 'native' })
  expect(defaultSelection(options, { harness: '' })).toEqual({
    harness: 'grok',
  })
})
it('retains an explicitly selected account for ACP and requires native account isolation', () => {
  const options = buildHarnessOptions(
    [
      { key: 'grok', adapterKind: 'acp' },
      { key: 'claude', adapterKind: 'native' },
    ],
    [account({ harness: 'grok', id: 'grok-selected' }), account()],
    0,
  )
  expect(
    defaultSelection(options, { harness: 'grok', accountId: 'grok-selected' }),
  ).toEqual({ harness: 'grok', accountId: 'grok-selected' })
  expect(
    defaultSelection(options, { harness: 'claude', accountId: 'main' }),
  ).toEqual({ harness: 'claude', accountId: 'main' })
})
