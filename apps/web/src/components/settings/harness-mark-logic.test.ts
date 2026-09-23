import { describe, expect, it } from 'vitest'
import { harnessMarkKind } from './harness-mark-logic'

describe('harnessMarkKind', () => {
  it('uses the account kind for account-capable harnesses', () => {
    expect(harnessMarkKind('work', { command: 'claude' })).toBe('claude')
    expect(harnessMarkKind('codex')).toBe('codex')
    expect(harnessMarkKind('oc', { command: 'bunx', args: ['opencode'] })).toBe(
      'opencode',
    )
  })

  it('matches agents without accounts by key, command, or args', () => {
    expect(harnessMarkKind('cursor')).toBe('cursor')
    expect(harnessMarkKind('ide', { command: 'cursor-agent' })).toBe('cursor')
    expect(harnessMarkKind('nous', { command: 'hermes', args: ['acp'] })).toBe(
      'hermes',
    )
    expect(harnessMarkKind('x', { command: 'npx', args: ['devin'] })).toBe(
      'devin',
    )
  })

  it('falls back to the key for unknown harnesses', () => {
    expect(harnessMarkKind('gemini', { command: 'gemini' })).toBe('gemini')
    expect(harnessMarkKind('my-agent', { command: 'run' })).toBe('my-agent')
  })
})
