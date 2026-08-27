import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { migrate } from '../db/migrate.js'
import { clearExpiredUsage, readUsage, recordUsageSnapshot } from './usage.js'

function db() {
  const value = new DatabaseSync(':memory:')
  migrate(value)
  return value
}

describe('account usage store', () => {
  it('stores and replaces windows without accepting older observations', () => {
    const value = db()
    recordUsageSnapshot(value, 'acct', [
      {
        windowKey: 'session-5h',
        label: 'Session',
        percent: 0.2,
        resetsAt: 100,
        source: 'test',
        observedAt: 10,
      },
      {
        windowKey: 'weekly-7d',
        label: 'Weekly',
        percent: 0.4,
        resetsAt: null,
        source: 'test',
        observedAt: 10,
      },
      {
        windowKey: 'model:fable:weekly',
        label: 'Fable',
        percent: 0.6,
        resetsAt: 100,
        source: 'test',
        observedAt: 10,
      },
    ])
    recordUsageSnapshot(value, 'acct', [
      {
        windowKey: 'session-5h',
        label: 'Session',
        percent: 0.9,
        resetsAt: 200,
        source: 'test',
        observedAt: 9,
      },
      {
        windowKey: 'weekly-7d',
        label: 'Weekly',
        percent: 0.8,
        resetsAt: null,
        source: 'test',
        observedAt: 11,
      },
    ])
    expect(readUsage(value, 'acct')).toHaveLength(3)
    expect(
      readUsage(value, 'acct').find((row) => row.windowKey === 'session-5h')
        ?.percent,
    ).toBe(0.2)
    expect(
      readUsage(value, 'acct').find((row) => row.windowKey === 'weekly-7d')
        ?.percent,
    ).toBe(0.8)
  })

  it('clears expired windows and keeps windows without reset times', () => {
    const value = db()
    recordUsageSnapshot(value, 'acct', [
      {
        windowKey: 'expired',
        label: 'Expired',
        percent: 0.5,
        resetsAt: 10,
        source: 'test',
        observedAt: 1,
      },
      {
        windowKey: 'open',
        label: 'Open',
        percent: 0.5,
        resetsAt: null,
        source: 'test',
        observedAt: 1,
      },
    ])
    clearExpiredUsage(value, 10)
    expect(readUsage(value, 'acct').map((row) => row.windowKey)).toEqual([
      'open',
    ])
  })
})
