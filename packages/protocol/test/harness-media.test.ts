import { describe, expect, it } from 'vitest'
import { harnessEventSchema, questionRequestSchema } from '../src/harness.js'
const item = {
  runId: 'run',
  turnId: 'turn',
  runtimeGeneration: 'generation',
  deliveryId: 'delivery',
  itemId: 'item',
}
const reference = {
  artifactId: 'artifact',
  mime: 'application/json',
  bytes: 2,
  sha256: 'a'.repeat(64),
}
const usage = { ...item, type: 'usage_snapshot', measurementId: 'measurement' }
describe('neutral media and usage patches', () => {
  it('preserves absent, null and zero measurements without fabricating counts', () => {
    for (const context of [
      null,
      { used: null },
      { used: 0 },
      { capacity: 9 },
    ]) {
      const result = harnessEventSchema.parse({ ...usage, context })
      expect(result).toEqual({ ...usage, context })
      expect(result).not.toHaveProperty('tokens')
    }
    for (const tokens of [
      null,
      { inputTokens: null },
      { inputTokens: 0 },
      { cachedInputTokens: 9 },
    ])
      expect(
        harnessEventSchema.parse({
          ...usage,
          tokenScope: 'unspecified',
          tokens,
        }),
      ).toEqual({ ...usage, tokenScope: 'unspecified', tokens })
    for (const cost of [
      null,
      { amount: null, currency: 'USD' },
      { amount: 0, currency: 'USD' },
    ])
      expect(
        harnessEventSchema.parse({ ...usage, costScope: 'session', cost }),
      ).toEqual({ ...usage, costScope: 'session', cost })
  })
  it('rejects empty, unsafe, or unscoped measurements', () => {
    for (const fields of [
      {},
      { context: {} },
      { context: { used: Number.MAX_SAFE_INTEGER + 1 } },
      { tokens: {} },
      { tokens: { inputTokens: 1 } },
      { cost: { amount: -1, currency: 'USD' }, costScope: 'session' },
      {
        tokens: { totalTokens: 1 },
        tokenScope: 'call',
        responseId: 'response',
      },
    ])
      expect(
        harnessEventSchema.safeParse({ ...usage, ...fields }).success,
      ).toBe(false)
  })
  it('keeps ordered authorized blocks and rejects embedded provider payloads', () => {
    for (const block of [
      { kind: 'image', ...reference },
      { kind: 'audio', ...reference },
      { kind: 'artifact_resource', uri: 'native:/data', ...reference },
      { kind: 'text_resource', uri: 'native:/text', text: 'exact\ntext' },
      {
        kind: 'resource_link',
        uri: 'https://example.test',
        name: 'name',
        size: 0,
      },
    ]) {
      const event = {
        ...item,
        type: 'content_block',
        blockIndex: 0,
        role: 'assistant',
        block,
        sourceRef: reference,
      }
      expect(harnessEventSchema.parse(event)).toEqual(event)
      expect(
        harnessEventSchema.safeParse({
          ...event,
          block: { ...block, _meta: { provider: 'opaque' } },
        }).success,
      ).toBe(false)
    }
  })
  it('links response boundaries without duplicate visible content', () => {
    const event = {
      ...item,
      type: 'source_reference',
      subject: { kind: 'response', responseId: 'response' },
      boundary: 'closed',
      sourceRef: reference,
    }
    const { itemId: _itemId, ...wire } = event
    expect(harnessEventSchema.parse(wire)).toEqual(wire)
    expect(
      harnessEventSchema.safeParse({
        ...wire,
        sourceRef: { ...reference, bytes: 1024 * 1024 + 1 },
      }).success,
    ).toBe(false)
  })
  it('preserves bounded native option previews', () => {
    const request = {
      requestId: 'request',
      questions: [
        {
          id: 'q',
          question: 'Choose',
          options: [{ id: 'o', label: 'Option', preview: 'Exact preview' }],
        },
      ],
    }
    expect(
      questionRequestSchema.parse(request).questions[0]!.options[0]!.preview,
    ).toBe('Exact preview')
    request.questions[0]!.options[0]!.preview = 'x'.repeat(65537)
    expect(questionRequestSchema.safeParse(request).success).toBe(false)
  })
})
