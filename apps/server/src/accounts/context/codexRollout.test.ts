import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readCodexRollout } from './codexRollout.js'

const input = (homePath: string, providerSessionId: string | null = null) => ({
  homePath,
  cwd: '/workspace/project',
  providerSessionId,
})

function tokenEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 20,
          output_tokens: 30,
          reasoning_output_tokens: 4,
          total_tokens: 150,
        },
        total_token_usage: { total_tokens: 200 },
        model_context_window: 258400,
        ...overrides,
      },
      rate_limits: {
        primary: {
          used_percent: 25,
          window_minutes: 10080,
          resets_at: 1787838000,
        },
        secondary: null,
      },
    },
  }
}

async function makeHome() {
  const home = await mkdtemp(join(tmpdir(), 'forge-codex-rollout-'))
  await mkdir(join(home, 'sessions', '2026', '08', '29'), { recursive: true })
  return home
}

describe('readCodexRollout', () => {
  it('reads the newest token_count and rate limits', async () => {
    const home = await makeHome()
    const file = join(home, 'sessions/2026/08/29/rollout-a.jsonl')
    await writeFile(
      file,
      `${JSON.stringify({ type: 'session_meta', payload: { cwd: '/workspace/project' } })}\n${JSON.stringify(tokenEvent())}\n`,
    )

    expect(readCodexRollout(input(home))).toMatchObject({
      usage: {
        usedTokens: 150,
        totalProcessedTokens: 200,
        maxTokens: 258400,
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 30,
        reasoningOutputTokens: 4,
        compactsAutomatically: true,
        source: 'codex.rollout',
      },
      rateLimits: { primary: { window_minutes: 10080, resets_at: 1787838000 } },
    })
  })

  it('prefers the provider session filename', async () => {
    const home = await makeHome()
    await writeFile(
      join(home, 'sessions/2026/08/29/rollout-old.jsonl'),
      JSON.stringify(tokenEvent({ model_context_window: 1 })),
    )
    await writeFile(
      join(home, 'sessions/2026/08/29/rollout-any-session-id.jsonl'),
      JSON.stringify(tokenEvent()),
    )
    expect(
      readCodexRollout(input(home, 'missing-id'))?.usage?.maxTokens,
    ).toBeUndefined()
    expect(
      readCodexRollout(input(home, 'any-session-id'))?.usage?.maxTokens,
    ).toBe(258400)
  })

  it('uses the newest cwd match and returns undefined when none match', async () => {
    const home = await makeHome()
    const older = join(home, 'sessions/2026/08/29/rollout-old.jsonl')
    const newer = join(home, 'sessions/2026/08/29/rollout-new.jsonl')
    const meta = JSON.stringify({
      type: 'session_meta',
      payload: { cwd: '/workspace/project' },
    })
    await writeFile(
      older,
      `${meta}\n${JSON.stringify(tokenEvent({ model_context_window: 1 }))}`,
    )
    await writeFile(newer, `${meta}\n${JSON.stringify(tokenEvent())}`)
    await utimes(older, 1, 1)
    await utimes(newer, 2, 2)
    expect(readCodexRollout(input(home))?.usage?.maxTokens).toBe(258400)
    expect(readCodexRollout({ ...input(home), cwd: '/other' })).toBeUndefined()
  })

  it.each([
    ['no token event', '{"type":"session_meta"}'],
    [
      'zero usage',
      JSON.stringify(tokenEvent({ last_token_usage: { total_tokens: 0 } })),
    ],
    ['corrupt line', '{not-json'],
  ])('returns undefined for %s', async (_name, contents) => {
    const home = await makeHome()
    await writeFile(
      join(home, 'sessions/2026/08/29/rollout.jsonl'),
      `${JSON.stringify({ type: 'session_meta', payload: { cwd: '/workspace/project' } })}\n${contents}`,
    )
    expect(readCodexRollout(input(home))).toBeUndefined()
  })

  it('keeps usage when primary rate limits are null', async () => {
    const home = await makeHome()
    const event = tokenEvent()
    ;(event.payload as { rate_limits: unknown }).rate_limits = {
      primary: null,
      secondary: null,
    }
    await writeFile(
      join(home, 'sessions/2026/08/29/rollout.jsonl'),
      `${JSON.stringify({ type: 'session_meta', payload: { cwd: '/workspace/project' } })}\n${JSON.stringify(event)}`,
    )
    expect(readCodexRollout(input(home))).toMatchObject({
      usage: { usedTokens: 150 },
    })
    expect(readCodexRollout(input(home))?.rateLimits).toEqual({
      primary: null,
      secondary: null,
    })
  })
})
