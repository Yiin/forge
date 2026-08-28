import { describe, expect, it } from 'vitest'
import { classifyPromptFailure, planAttempts } from './runner.js'

describe('epic runner account attempts', () => {
  const accounts = [
    { id: 'claude-a', harnessKey: 'claude', orderIndex: 0 },
    { id: 'claude-b', harnessKey: 'claude', orderIndex: 1 },
    { id: 'codex-a', harnessKey: 'codex', orderIndex: 0 },
  ]
  const hops = [{ harness: 'claude' }, { harness: 'codex' }]

  it('keeps sibling accounts before the next harness', () => {
    expect(planAttempts(hops, accounts, new Set())).toEqual([
      { harness: 'claude', accountId: 'claude-a' },
      { harness: 'claude', accountId: 'claude-b' },
      { harness: 'codex', accountId: 'codex-a' },
    ])
  })

  it('skips blocked accounts and fully blocked harnesses', () => {
    expect(planAttempts(hops, accounts, new Set(['claude-a']))).toEqual([
      { harness: 'claude', accountId: 'claude-b' },
      { harness: 'codex', accountId: 'codex-a' },
    ])
    expect(
      planAttempts(hops, accounts, new Set(['claude-a', 'claude-b'])),
    ).toEqual([{ harness: 'codex', accountId: 'codex-a' }])
  })

  it('skips hops without managed accounts', () => {
    expect(planAttempts([{ harness: 'kimi' }], accounts, new Set())).toEqual([])
  })

  it('records cooldowns only for limit failures', () => {
    expect(
      classifyPromptFailure(new Error('usage limit reached'), 123),
    ).toEqual({
      category: 'usage-limit',
      recordCooldown: true,
      detectedAt: 123,
    })
    expect(classifyPromptFailure(new Error('invalid api key'), 123)).toEqual({
      category: 'auth',
      recordCooldown: false,
      detectedAt: 123,
    })
  })
})

describe('planAttempts ambient hops', () => {
  it('keeps an accountless attempt for a kind-less harness', () => {
    const attempts = planAttempts(
      [{ harness: 'gemini' }],
      [],
      new Set(),
      () => false,
    )
    expect(attempts).toEqual([{ harness: 'gemini' }])
  })
  it('drops the hop when the harness requires an account and has none', () => {
    expect(planAttempts([{ harness: 'claude' }], [], new Set())).toEqual([])
  })
})
