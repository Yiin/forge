import { describe, expect, it } from 'vitest'
import {
  accountKindForHarness,
  buildAccountReorderPatch,
  deriveAccountLimitState,
  formatResetCountdown,
  isManagedAccountHome,
  moveAccount,
  orderAccountRows,
  reduceLoginRunState,
  resolveAccountAuthAction,
  validateAccountId,
} from './harness-accounts-logic'

const rows = (ids: string[]) =>
  ids.map((accountId) => ({ accountId, availability: 'available' }))

describe('harness account presentation logic', () => {
  it('orders rotation rows and demotes unavailable rows', () => {
    expect(
      orderAccountRows(
        [
          { ...rows(['a'])[0], availability: 'unavailable' },
          ...rows(['b', 'a']),
        ],
        ['a', 'b'],
      ).map((row) => row.accountId),
    ).toEqual(['a', 'b', 'a'])
  })
  it('returns null when moving off either end', () => {
    expect(moveAccount(rows(['a', 'b']), 'a', 'up')).toBeNull()
    expect(moveAccount(rows(['a', 'b']), 'b', 'down')).toBeNull()
  })
  it('rewrites group slots and appends new members', () => {
    const config = {
      harness: { a: { name: 'a' } as never, other: { name: 'other' } as never },
    }
    expect(
      Object.keys(
        buildAccountReorderPatch({
          config,
          groupOrder: [
            { accountId: 'a', harness: { name: 'a2' } as never },
            { accountId: 'new', harness: { name: 'new' } as never },
          ],
        }).harness,
      ),
    ).toEqual(['a', 'other', 'new'])
  })
  it('hides expired limits and keeps permanent blocks', () => {
    expect(
      deriveAccountLimitState({
        nowMs: 100,
        usage: [
          {
            utilization: 90,
            window: 'primary',
            resetsAt: '1970-01-01T00:00:00.000Z',
          },
        ],
        limit: { kind: 'auth', resetsAt: '1970-01-01T00:00:00.000Z' },
      }),
    ).toBeNull()
    expect(
      deriveAccountLimitState({
        nowMs: 100,
        limit: { kind: 'auth', resetsAt: null },
      }),
    ).toEqual({
      utilization: null,
      blocked: { label: 'Sign-in required', resetsAt: null },
    })
  })
  it('rounds a sub-minute countdown up', () =>
    expect(formatResetCountdown(new Date(30_001).toISOString(), 0)).toBe('1m'))
  it('resolves scriptable and manual auth actions', () => {
    expect(
      resolveAccountAuthAction({
        harnessKind: 'claude',
        authStatus: 'authenticated',
      }),
    ).toEqual({ kind: 'sign-out' })
    expect(
      resolveAccountAuthAction({
        harnessKind: 'claude',
        authStatus: 'unauthenticated',
      }),
    ).toEqual({ kind: 'sign-in' })
    expect(
      resolveAccountAuthAction({
        harnessKind: 'claude',
        authStatus: 'unknown',
      }),
    ).toEqual({ kind: 'none' })
    expect(
      resolveAccountAuthAction({
        harnessKind: 'cursor',
        authStatus: 'unauthenticated',
        serverMessage: 'Run `cursor login`',
      }),
    ).toEqual({ kind: 'manual', command: 'cursor login' })
    expect(
      resolveAccountAuthAction({
        harnessKind: 'cursor',
        authStatus: 'authenticated',
      }),
    ).toEqual({ kind: 'none' })
  })
  it('validates account ids', () => {
    expect(validateAccountId('')).toBe('Account ID is required.')
    expect(validateAccountId('1bad')).toContain('must start')
    expect(validateAccountId('a'.repeat(65))).toContain('64')
    expect(validateAccountId('work', ['work'])).toContain('already exists')
  })
  it('recognizes only the managed account home', () => {
    expect(
      isManagedAccountHome({
        homePath: '/x/claude/a/',
        accountsDir: '/x',
        harnessKind: 'claude',
        accountId: 'a',
      }),
    ).toBe(true)
    expect(
      isManagedAccountHome({
        homePath: '/x/claude/ab',
        accountsDir: '/x',
        harnessKind: 'claude',
        accountId: 'a',
      }),
    ).toBe(false)
  })
  it('keeps terminal login state against later running state', () => {
    const current = {
      status: 'succeeded' as const,
      startedAt: null,
      finishedAt: null,
      message: null,
      output: 'done',
      verificationUrl: null,
      userCode: null,
    }
    expect(
      reduceLoginRunState(current, {
        ...current,
        status: 'running',
        output: '',
      }),
    ).toBe(current)
  })
})

describe('accountKindForHarness', () => {
  it('maps the default forge harness entries to their account kinds', () => {
    expect(
      accountKindForHarness('claude-code-acp', {
        command: 'npx',
        args: ['@zed-industries/claude-code-acp'],
      }),
    ).toBe('claude')
    expect(
      accountKindForHarness('codex-acp', {
        command: 'npx',
        args: ['@zed-industries/codex-acp'],
      }),
    ).toBe('codex')
    expect(accountKindForHarness('kimi', { command: 'kimi' })).toBe('kimi')
    expect(accountKindForHarness('my-oc', { command: 'opencode' })).toBe(
      'opencode',
    )
  })
  it('returns null for harnesses with no managed accounts', () => {
    expect(accountKindForHarness('shell', { command: 'bash' })).toBeNull()
    expect(accountKindForHarness('gemini', { command: 'gemini' })).toBeNull()
    expect(
      accountKindForHarness('mock', {
        command: 'bun',
        args: ['apps/server/test/fixtures/acp-mock-agent.ts'],
      }),
    ).toBeNull()
  })
})
