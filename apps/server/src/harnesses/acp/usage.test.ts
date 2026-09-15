import { describe, expect, it } from 'vitest'
import { captureNumbers } from './numbers.js'
import { projectAcpUsage, type AcpUsageKind } from './usage.js'
function project(text: string, kind: AcpUsageKind = 'standard') {
  const frame = `{"usage":${text}}`
  return projectAcpUsage(
    JSON.parse(frame).usage,
    kind,
    captureNumbers(frame),
    '/usage',
  )
}
describe('ACP exact usage projection', () => {
  it('keeps missing, null, and zero distinct without adding snapshots', () => {
    expect(project('{"inputTokens":9}').patch?.tokens).toEqual({
      inputTokens: 9,
    })
    expect(project('{}').patch).toBeNull()
    expect(project('{"inputTokens":null}').patch?.tokens).toEqual({
      inputTokens: null,
    })
    expect(project('{"inputTokens":0}').patch?.tokens).toEqual({
      inputTokens: 0,
    })
    expect(project('null').patch).toEqual({
      tokens: null,
      tokenScope: 'unspecified',
      inputTokenBasis: 'unspecified',
    })
    expect(
      projectAcpUsage(undefined, 'standard', { numbers: [] }, '/usage').patch,
    ).toBeNull()
  })
  it('maps native token names and preserves scope and cache basis', () => {
    expect(
      project('{"cachedReadTokens":3,"cachedWriteTokens":4,"thoughtTokens":5}')
        .patch,
    ).toEqual({
      tokens: {
        cachedInputTokens: 3,
        cacheWriteInputTokens: 4,
        reasoningOutputTokens: 5,
      },
      tokenScope: 'unspecified',
      inputTokenBasis: 'unspecified',
    })
    expect(
      project('{"inputTokens":8,"cacheCreationTokens":2}', 'grok_prompt').patch,
    ).toEqual({
      tokens: { inputTokens: 8, cacheWriteInputTokens: 2 },
      tokenScope: 'prompt',
      inputTokenBasis: 'includes_cache_reads',
    })
    expect(
      project('{"input_tokens":8,"cache_read_input_tokens":2}', 'grok_response')
        .patch,
    ).toEqual({
      tokens: { inputTokens: 8, cachedInputTokens: 2 },
      tokenScope: 'call',
      inputTokenBasis: 'excludes_cache_reads',
    })
  })
  it('keeps unsafe native integers as exact text without rounded projections', () => {
    for (const number of [
      '9007199254740992',
      '9007199254740993',
      '9223372036854775807',
      '18446744073709551615',
      '-1',
      '1e3',
      '1.5',
      '1e999',
    ]) {
      const result = project(
        `{"inputTokens":${number},"outputTokens":0}`,
        'grok_prompt',
      )
      expect(result.patch?.tokens).toEqual({ outputTokens: 0 })
      expect(result.source).toMatchObject({
        value: { inputTokens: number },
      })
    }
    expect(project('{"inputTokens":9007199254740991}').patch?.tokens).toEqual({
      inputTokens: 9007199254740991,
    })
  })
  it('preserves exact signed ticks and suppresses unsafe or incomplete costs', () => {
    expect(
      project('{"costUsdTicks":10000000000}', 'grok_prompt').patch,
    ).toEqual({ costScope: 'prompt', cost: { amount: 1, currency: 'USD' } })
    for (const tick of [
      '-9223372036854775808',
      '-1',
      '9007199254740992',
      '9223372036854775807',
    ]) {
      const result = project(`{"costUsdTicks":${tick}}`, 'grok_prompt')
      expect(result.patch).toBeNull()
      expect(result.source).toMatchObject({
        value: { costUsdTicks: tick },
      })
    }
    for (const flag of ['usageIsIncomplete', 'costIsPartial'])
      expect(
        project(`{"costUsdTicks":100, "${flag}":true}`, 'grok_prompt').patch,
      ).toBeNull()
    expect(project('{"costUsdTicks":0}', 'grok_prompt').patch?.cost).toEqual({
      amount: 0,
      currency: 'USD',
    })
  })
  it('requires boolean completeness evidence and retains the exact cost scale', () => {
    for (const flag of ['usageIsIncomplete', 'costIsPartial'])
      for (const value of ['"true"', '1', 'null'])
        expect(() =>
          project(`{"costUsdTicks":1,"${flag}":${value}}`, 'grok_prompt'),
        ).toThrow('completeness flag')
    expect(project('{"costUsdTicks":1}', 'grok_prompt').source).toMatchObject({
      costScale: { ticksPerUnit: '10000000000', currency: 'USD' },
    })
  })
  it('maps context and cumulative session cost independently', () => {
    expect(
      project(
        '{"used":0,"size":100,"cost":{"amount":0,"currency":"USD"}}',
        'context',
      ).patch,
    ).toEqual({
      context: { used: 0, capacity: 100 },
      cost: { amount: 0, currency: 'USD' },
      costScope: 'session',
    })
    expect(project('{"used":null,"cost":null}', 'context').patch).toEqual({
      context: { used: null },
      cost: null,
      costScope: 'session',
    })
  })
  it('records declared domains only within the original usage subtree', () => {
    const text =
      '{"unrelated":7,"usage":{"inputTokens":9007199254740993,"costUsdTicks":-1,"extra":8}}'
    const result = projectAcpUsage(
      JSON.parse(text).usage,
      'grok_prompt',
      captureNumbers(text),
      '/usage',
    )
    expect(result.source).toMatchObject({
      kind: 'grok_prompt',
      numbers: [
        {
          path: '/usage/inputTokens',
          text: '9007199254740993',
          declaredType: 'u64',
        },
        { path: '/usage/costUsdTicks', text: '-1', declaredType: 'i64' },
        { path: '/usage/extra', text: '8', declaredType: undefined },
      ],
    })
  })
  it('requires original numeric evidence and rejects data accessors', () => {
    expect(() =>
      projectAcpUsage(
        { inputTokens: 3 },
        'standard',
        { numbers: [] },
        '/usage',
      ),
    ).toThrow('numeric source')
    expect(() =>
      projectAcpUsage(
        Object.defineProperty({}, 'inputTokens', {
          get() {
            throw Error('executed')
          },
        }),
        'standard',
        { numbers: [] },
        '/usage',
      ),
    ).toThrow()
  })
})
