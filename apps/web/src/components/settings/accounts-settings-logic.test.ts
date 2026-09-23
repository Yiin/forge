import { describe, expect, it } from 'vitest'
import type { Account } from '@/lib/accounts-api'
import {
  buildAccountSections,
  newAccountLabel,
  orderWithFirst,
  orderWithMove,
} from './accounts-settings-logic'

const account = (patch: Partial<Account> & { id: string }): Account => ({
  harness: 'claude',
  harnessKey: 'claude',
  kind: 'claude',
  label: patch.id,
  storageDir: '/tmp',
  homePath: '/tmp',
  enabled: true,
  authStatus: 'authenticated',
  email: null,
  cooldownUntil: null,
  cooldownReason: null,
  lastUsedAt: null,
  ...patch,
})

const harness = (command: string) => ({
  name: '',
  command,
  args: [],
  env: {},
  protocol: 'acp' as const,
  enabled: true,
})

describe('accounts settings logic', () => {
  it('lists account-capable harnesses and any harness that holds accounts', () => {
    const sections = buildAccountSections({
      config: {
        claude: harness('claude'),
        shell: harness('bash'),
        mock: harness('node'),
      },
      health: [],
      accounts: [
        account({ id: 'a', harnessKey: 'mock', kind: 'mock' }),
        account({ id: 'b', harnessKey: 'gone', kind: 'mock' }),
      ],
      snapshots: [],
      nowMs: 0,
    })
    expect(sections.map((section) => section.key)).toEqual([
      'claude',
      'mock',
      'gone',
    ])
    expect(sections.map((section) => section.name)).toEqual([
      'Claude',
      'mock',
      'gone',
    ])
    expect(sections[1]!.accountKind).toBeNull()
    expect(newAccountLabel(sections[0]!)).toBe('Claude Account 1')
  })

  it('makes the first enabled, non-cooling account active', () => {
    const [section] = buildAccountSections({
      config: { claude: harness('claude') },
      health: [],
      accounts: [
        account({ id: 'off', enabled: false }),
        account({ id: 'cooling', cooldownUntil: 10 }),
        account({ id: 'ready' }),
        account({ id: 'spare' }),
        account({ id: 'signed-out', authStatus: 'unauthenticated' }),
      ],
      snapshots: [],
      nowMs: 0,
    })
    expect(
      section!.rows.map(({ id, active, switchable }) => ({
        id,
        active,
        switchable,
      })),
    ).toEqual([
      { id: 'off', active: false, switchable: false },
      { id: 'cooling', active: false, switchable: false },
      { id: 'ready', active: true, switchable: false },
      { id: 'spare', active: false, switchable: true },
      { id: 'signed-out', active: false, switchable: false },
    ])
  })

  it('reorders for Switch and for single steps', () => {
    expect(orderWithFirst(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b'])
    expect(orderWithMove(['a', 'b', 'c'], 'b', 'up')).toEqual(['b', 'a', 'c'])
    expect(orderWithMove(['a', 'b', 'c'], 'c', 'down')).toBeNull()
  })
})
