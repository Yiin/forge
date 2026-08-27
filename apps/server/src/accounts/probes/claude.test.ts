import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeClaudeUsageProbe } from './claude.js'

const context = (homePath: string) => ({
  accountId: 'acct',
  kind: 'claude',
  harnessKey: 'claude',
  homePath,
  env: { CLAUDE_CONFIG_DIR: homePath },
  db: {} as any,
})

async function home(oauth: Record<string, unknown> = {}) {
  const path = await mkdtemp(join(tmpdir(), 'forge-claude-'))
  await writeFile(
    join(path, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: oauth }),
  )
  return path
}

describe('claude usage probe', () => {
  it('normalizes percent and fraction payloads, including model windows', async () => {
    const path = await home({ accessToken: 'token', rateLimitTier: 'max_5x' })
    const reset = 1_700_000_000_000
    const fetcher = async () =>
      new Response(
        JSON.stringify({
          five_hour: { utilization: 37, resets_at: reset / 1000 },
          seven_day_oauth_apps: {
            utilization: 37,
            resets_at: new Date(reset).toISOString(),
          },
          limits: [
            {
              percent: 37,
              kind: 'seven_day',
              scope: { model: { id: 'fable', display_name: 'Fable' } },
              resets_at: reset,
            },
            {
              percent: 10,
              kind: 'month',
              scope: { model: { id: 'mythos', display_name: 'Mythos' } },
              resets_at: reset,
            },
          ],
        }),
        { status: 200 },
      )
    const result = await makeClaudeUsageProbe(fetcher)(context(path))
    expect(result).toMatchObject({ status: 'ok', tierLabel: 'Max 5x' })
    expect(result.windows).toHaveLength(4)
    expect(result.windows.map((window) => window.windowKey)).toContain(
      'model:fable:seven_day',
    )
    expect(
      result.windows.find((window) => window.windowKey === 'model:mythos:month')
        ?.label,
    ).toBe('Mythos Monthly')
    expect(
      result.windows.every(
        (window) => window.percent === 0.37 || window.percent === 0.1,
      ),
    ).toBe(true)
    expect(result.windows[0]?.resetsAt).toBe(reset)
    await rm(path, { recursive: true, force: true })
  })

  it('keeps a lone raw 1 as full usage and handles auth states', async () => {
    const path = await home({ accessToken: 'token', subscriptionType: 'pro' })
    const fetcher = async () =>
      new Response(JSON.stringify({ five_hour: { utilization: 1 } }), {
        status: 200,
      })
    await expect(
      makeClaudeUsageProbe(fetcher)(context(path)),
    ).resolves.toMatchObject({
      tierLabel: 'Pro',
      windows: [{ percent: 1 }],
    })
    await rm(path, { recursive: true, force: true })
    const missing = await mkdtemp(join(tmpdir(), 'forge-claude-'))
    await expect(
      makeClaudeUsageProbe(fetcher)(context(missing)),
    ).resolves.toMatchObject({ status: 'auth', detail: 'Waiting for auth' })
    await rm(missing, { recursive: true, force: true })
  })

  it('scales a raw 1 when another sibling value reaches 100', async () => {
    const path = await home({ accessToken: 'token' })
    const fetcher = async () =>
      new Response(
        JSON.stringify({
          five_hour: { utilization: 1 },
          seven_day: { utilization: 1 },
        }),
        { status: 200 },
      )
    const result = await makeClaudeUsageProbe(fetcher)(context(path))
    expect(result.windows.map((window) => window.percent)).toEqual([0.01, 0.01])
    await rm(path, { recursive: true, force: true })
  })

  it('returns retryable network errors and non-retryable rate limits', async () => {
    const path = await home({ accessToken: 'token' })
    const network = makeClaudeUsageProbe(async () => {
      throw new Error('offline')
    })
    await expect(network(context(path))).resolves.toMatchObject({
      status: 'unavailable',
      retryAdvised: true,
    })
    const limited = makeClaudeUsageProbe(
      async () =>
        new Response('', { status: 429, headers: { 'retry-after': '12' } }),
    )
    const limitedResult = await limited(context(path))
    expect(limitedResult).toMatchObject({ status: 'unavailable', detail: '12' })
    expect(limitedResult).not.toHaveProperty('retryAdvised')
    await rm(path, { recursive: true, force: true })
  })
})
