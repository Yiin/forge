import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readClaudeContextUsage } from './claudeTranscript.js'

const input = (homePath: string, model?: string) => ({
  homePath,
  cwd: '/work/project',
  providerSessionId: 'provider-session',
  model,
})

async function fixture(lines: unknown[]) {
  const homePath = await mkdtemp(join(tmpdir(), 'forge-claude-context-'))
  const directory = join(homePath, 'projects', '-work-project')
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'provider-session.jsonl'),
    lines
      .map((line) => (typeof line === 'string' ? line : JSON.stringify(line)))
      .join('\n'),
  )
  return homePath
}

const assistant = (usage: Record<string, number>) => ({
  message: { role: 'assistant', usage },
})

describe('readClaudeContextUsage', () => {
  it('reads the last assistant usage and sums processed tokens', async () => {
    const homePath = await fixture([
      assistant({
        input_tokens: 100,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 20,
        output_tokens: 5,
      }),
      assistant({
        input_tokens: 2,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 4,
        output_tokens: 1,
      }),
    ])
    expect(
      readClaudeContextUsage(input(homePath, 'claude-opus-5')),
    ).toMatchObject({
      usedTokens: 10,
      totalProcessedTokens: 145,
      maxTokens: 1_000_000,
    })
  })

  it.each([
    ['missing', '/missing'],
    ['empty', ''],
    ['user only', JSON.stringify({ message: { role: 'user' } })],
    ['corrupt trailing line', `{`],
  ])('returns undefined for %s transcripts', async (_name, contents) => {
    if (contents === '/missing') {
      expect(readClaudeContextUsage(input(contents))).toBeUndefined()
      return
    }
    const homePath = await fixture(contents ? [contents] : [])
    expect(readClaudeContextUsage(input(homePath))).toBeUndefined()
  })

  it('uses model limits and omits the limit for unknown models', async () => {
    const homePath = await fixture([
      assistant({
        input_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
      }),
    ])
    expect(
      readClaudeContextUsage(input(homePath, 'claude-sonnet-4'))?.maxTokens,
    ).toBe(200_000)
    expect(
      readClaudeContextUsage(input(homePath, 'future-model')),
    ).not.toHaveProperty('maxTokens')
  })
})
