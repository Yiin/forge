import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { migrate } from '../db/migrate.js'
import {
  blockedAccounts,
  clearExpiredLimits,
  detectProviderError,
  normalizeEpochResetsAt,
  recordLimit,
} from './limits.js'

const db = () => {
  const value = new DatabaseSync(':memory:')
  migrate(value)
  return value
}

describe('account limits', () => {
  it('classifies provider errors and returns the matched line', () => {
    expect(
      detectProviderError('task mentions a usage limit in prose'),
    ).toMatchObject({
      category: 'usage-limit',
      excerpt: 'task mentions a usage limit in prose',
    })
    expect(detectProviderError('invalid API key')).toMatchObject({
      category: 'auth',
    })
    expect(detectProviderError('rate limit')).toMatchObject({
      category: 'rate-limit',
    })
    expect(detectProviderError('service unavailable')).toMatchObject({
      category: 'unavailable',
    })
    expect(
      detectProviderError(`prefix\n${'x'.repeat(240)} usage limit`)?.excerpt,
    ).toHaveLength(200)
    expect(detectProviderError('ordinary task text')).toBeNull()
  })

  it('normalizes seconds and milliseconds and rejects invalid values', () => {
    expect(normalizeEpochResetsAt(1787207826)).toBe(1787207826000)
    expect(normalizeEpochResetsAt(1787207826000)).toBe(1787207826000)
    expect(normalizeEpochResetsAt(0)).toBeNull()
    expect(normalizeEpochResetsAt(Number.NaN)).toBeNull()
    expect(normalizeEpochResetsAt(-1)).toBeNull()
  })

  it('keeps the newest signal for each account and category', () => {
    const value = db()
    recordLimit(value, {
      accountId: 'a',
      kind: 'usage-limit',
      harnessKey: 'claude',
      detectedAt: 20,
      source: 'new',
    })
    recordLimit(value, {
      accountId: 'a',
      kind: 'usage-limit',
      harnessKey: 'claude',
      detectedAt: 10,
      source: 'old',
    })
    expect(
      value
        .prepare('SELECT detected_at, source FROM harness_account_limits')
        .get(),
    ).toEqual({ detected_at: 20, source: 'new' })
  })

  it('clears expired rows and blocks only live budget limits', () => {
    const value = db()
    recordLimit(value, {
      accountId: 'expired',
      kind: 'usage-limit',
      harnessKey: 'claude',
      detectedAt: 1,
      resetsAt: 100,
      source: 'test',
    })
    recordLimit(value, {
      accountId: 'open',
      kind: 'spend-limit',
      harnessKey: 'claude',
      detectedAt: 900,
      source: 'test',
    })
    recordLimit(value, {
      accountId: 'auth',
      kind: 'auth',
      harnessKey: 'claude',
      detectedAt: 900,
      source: 'test',
    })
    recordLimit(value, {
      accountId: 'outage',
      kind: 'unavailable',
      harnessKey: 'claude',
      detectedAt: 900,
      source: 'test',
    })
    clearExpiredLimits(value, 100)
    expect(
      value.prepare('SELECT account_id FROM harness_account_limits').all(),
    ).not.toContainEqual({ account_id: 'expired' })
    expect(blockedAccounts(value, 1000, 500)).toEqual(new Set(['open']))
  })
})
