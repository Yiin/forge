import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { migrate } from '../../db/migrate.js'
import { makeCodexUsageProbe, type CodexProbeChild } from './codex.js'

function child(
  messages: unknown[],
): CodexProbeChild & { writes: string[]; kills: string[] } {
  const writes: string[] = []
  const kills: string[] = []
  async function* output() {
    for (const message of messages) yield `${JSON.stringify(message)}\n`
  }
  return {
    writes,
    kills,
    stdin: { write: (data) => writes.push(data), end: () => undefined },
    stdout: output(),
    kill: (signal) => kills.push(signal ?? ''),
    exited: Promise.resolve(0),
  }
}

function database() {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  return db
}

describe('codex usage probe', () => {
  it('speaks the app-server protocol and maps usage windows', async () => {
    const db = database()
    const process = child([
      { id: 1, result: {} },
      { id: 2, result: { account: { type: 'free' } } },
      {
        id: 3,
        result: {
          rateLimits: {
            planType: 'pro',
            primary: {
              usedPercent: 42,
              windowDurationMins: 10080,
              resetsAt: 1_700_000_000,
            },
            secondary: {
              usedPercent: 42,
              windowDurationMins: 300,
              resetsAt: 1_700_000_100,
            },
          },
        },
      },
    ])
    const probe = makeCodexUsageProbe(() => process)
    const result = await probe({
      accountId: 'acct',
      kind: 'codex',
      harnessKey: 'codex',
      homePath: '/managed',
      env: { CODEX_HOME: '/ambient' },
      db,
    })
    expect(process.writes.map((value) => JSON.parse(value).method)).toEqual([
      'initialize',
      'initialized',
      'account/read',
      'account/rateLimits/read',
    ])
    expect(JSON.parse(process.writes[0]!).id).toBe(1)
    expect(JSON.parse(process.writes[2]!).id).toBe(2)
    expect(JSON.parse(process.writes[3]!).id).toBe(3)
    expect(result).toMatchObject({ status: 'ok', tierLabel: 'pro' })
    expect(result.windows).toEqual([
      {
        windowKey: 'weekly-7d',
        label: 'Weekly (7-day)',
        percent: 0.42,
        resetsAt: 1_700_000_000_000,
        source: 'codex.app_server.read',
      },
      {
        windowKey: '5h',
        label: '5h window',
        percent: 0.42,
        resetsAt: 1_700_000_100_000,
        source: 'codex.app_server.read',
      },
    ])
    expect(process.kills).toEqual(['SIGTERM', 'SIGKILL'])
    expect(JSON.parse(process.writes[0]!).params).toEqual({
      clientInfo: { name: 'forge-usage', version: '1' },
    })
  })

  it('records one usage limit and skips windows without usage', async () => {
    const db = database()
    const process = child([
      { id: 1, result: {} },
      { id: 2, result: { type: 'team' } },
      {
        id: 3,
        result: {
          rateLimits: {
            planType: 'team',
            rateLimitReachedType: 'workspace_usage_limit_reached',
            primary: { usedPercent: null, windowDurationMins: 60 },
          },
        },
      },
    ])
    const result = await makeCodexUsageProbe(() => process)({
      accountId: 'acct',
      kind: 'codex',
      harnessKey: 'codex',
      homePath: '/managed',
      env: {},
      db,
    })
    expect(result.windows).toEqual([])
    expect(
      db.prepare('SELECT kind, source FROM harness_account_limits').all(),
    ).toEqual([{ kind: 'usage-limit', source: 'codex.app_server.read' }])
  })
})
