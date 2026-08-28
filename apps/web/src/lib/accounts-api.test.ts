import { describe, expect, it } from 'vitest'
import { harnessAccountSnapshotSchema } from './accounts-api'

const base = {
  accountId: 'claude-primary',
  harnessKind: 'claude',
  harnessKey: 'claude-code-acp',
  enabled: true,
  installed: true,
  version: '1.2.3',
  status: 'ready' as const,
  auth: { status: 'authenticated' as const },
  checkedAt: '2026-08-27T12:00:00.000Z',
}

describe('harnessAccountSnapshotSchema', () => {
  it('decodes usage and limit data', () => {
    const snapshot = harnessAccountSnapshotSchema.parse({
      ...base,
      usage: [
        {
          windowId: 'five_hour',
          window: 'five_hour',
          label: 'Session',
          utilization: 0.42,
          resetsAt: null,
          source: 'claude.sdk.get_usage',
          observedAt: base.checkedAt,
        },
      ],
      limit: {
        kind: 'usage-limit',
        detectedAt: base.checkedAt,
        resetsAt: null,
        resetsAtEstimated: false,
        source: 'claude.sdk.rate_limit_event',
        detail: null,
      },
    })

    expect(snapshot.usage?.[0]?.utilization).toBe(0.42)
    expect(snapshot.limit?.kind).toBe('usage-limit')
  })

  it('decodes snapshots without optional usage and limit', () => {
    const snapshot = harnessAccountSnapshotSchema.parse(base)

    expect(snapshot.usage).toBeUndefined()
    expect(snapshot.limit).toBeUndefined()
  })

  it('accepts a rate-limit cooldown, the category the server actually records', () => {
    const snapshot = harnessAccountSnapshotSchema.parse({
      ...base,
      limit: {
        kind: 'rate-limit',
        detectedAt: base.checkedAt,
        resetsAt: null,
        resetsAtEstimated: false,
        source: 'harness_account_limits',
        detail: 'rate limited',
      },
    })

    expect(snapshot.limit?.kind).toBe('rate-limit')
  })

  it('keeps an explicit null limit', () => {
    const snapshot = harnessAccountSnapshotSchema.parse({
      ...base,
      limit: null,
    })

    expect(snapshot.limit).toBeNull()
  })
})
