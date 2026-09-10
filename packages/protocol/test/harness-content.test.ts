import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { harnessEventSchema, type HarnessEvent } from '../src/harness.js'

const item = {
  runId: 'root-run',
  runtimeGeneration: 'runtime-1',
  deliveryId: 'delivery-1',
  turnId: 'root-turn',
  itemId: 'item-1',
  providerRunId: 'native-run',
  providerTurnId: 'native-turn',
  providerItemId: 'native-item',
}
const snapshot = {
  ...item,
  type: 'content_snapshot',
  contentType: 'text',
  text: 'Final text',
}
const diagnostic = {
  ...item,
  type: 'diagnostic',
  code: 'responseStreamDisconnected',
  message: 'The stream disconnected',
  severity: 'error',
}
const counts = { inputTokens: 4, outputTokens: 3, totalTokens: 7 }
const details = {
  cachedInputTokens: 0,
  cacheWriteInputTokens: 2,
  reasoningOutputTokens: 1,
}
const usage = { ...item, type: 'usage', ...counts }
const plan = { ...item, type: 'plan', steps: [] }
const wire = (input: unknown) =>
  harnessEventSchema.parse(JSON.parse(JSON.stringify(input)))
const utf8AtLimit = (bytes: number) =>
  '🧭'.repeat(Math.floor(bytes / 4)) + 'a'.repeat(bytes % 4)

// These fixtures mirror the reviewed Codex 0.153.4 notification shapes after normalization.
describe('content snapshot contract', () => {
  it.each(['text', 'thought', 'plan'])(
    'preserves empty and literal Unicode %s content without adding metadata',
    (contentType) => {
      for (const text of ['', 'a\u2028b\u2029🧭é', '\ud800', '\udc00']) {
        const input = { ...snapshot, contentType, text }
        expect(wire(input)).toStrictEqual(input)
      }
    },
  )

  it.each(['user', 'assistant'])(
    'preserves text role %s, child ownership, and nullable inline metadata',
    (role) => {
      for (const questions of [
        null,
        [],
        [{ title: '' }],
        [{ title: 'Which\u2028file?', options: null }],
        [{ title: 'Which file?', options: [] }],
        [{ title: 'Which file?', options: ['', 'parser\u2029.ts'] }],
      ]) {
        const input = {
          ...snapshot,
          childId: 'child-1',
          role,
          phase: null,
          delivery: null,
          questions,
        }
        expect(wire(input)).toStrictEqual(input)
      }
    },
  )

  it.each(['commentary', 'final_answer'])(
    'preserves %s phase and async delivery',
    (phase) => {
      const input = { ...snapshot, phase, delivery: 'async' }
      expect(wire(input)).toStrictEqual(input)
    },
  )

  it.each(['thought', 'plan'])(
    'rejects every text-only field on %s snapshots, even when null or undefined',
    (contentType) => {
      for (const [field, value] of Object.entries({
        role: 'assistant',
        phase: 'commentary',
        delivery: 'async',
        questions: [],
      })) {
        for (const candidate of [value, null, undefined])
          expect(
            harnessEventSchema.safeParse({
              ...snapshot,
              contentType,
              [field]: candidate,
            }).success,
          ).toBe(false)
      }
    },
  )

  it('rejects unsupported types, inline callback fields, and malformed metadata', () => {
    for (const fields of [
      { contentType: 'tool' },
      { contentType: null },
      { text: null },
      { text: 42 },
      { role: 'system' },
      { role: null },
      { phase: 'complete' },
      { delivery: 'sync' },
      { questions: {} },
      { questions: [null] },
      { questions: [{}] },
      { questions: [{ title: null }] },
      { questions: [{ title: '', options: [null] }] },
      { questions: [{ title: '', options: [{ label: 'Option' }] }] },
      { questions: [{ title: '', options: 'Option' }] },
      { questions: [{ title: '', requestId: 'callback' }] },
      { questions: [{ title: '', isBlocking: true }] },
      { questions: [{ title: '', extra: true }] },
      { requestId: 'callback' },
      { isBlocking: true },
      { outcome: { status: 'completed' } },
      { extra: true },
    ])
      expect(
        harnessEventSchema.safeParse({ ...snapshot, ...fields }).success,
      ).toBe(false)
  })

  it('enforces public question and option counts without rejecting empty values', () => {
    const questions = Array.from({ length: 64 }, () => ({ title: '' }))
    expect(wire({ ...snapshot, questions })).toStrictEqual({
      ...snapshot,
      questions,
    })
    expect(
      harnessEventSchema.safeParse({
        ...snapshot,
        questions: [...questions, { title: '' }],
      }).success,
    ).toBe(false)
    const options = Array.from({ length: 128 }, () => '')
    const input = { ...snapshot, questions: [{ title: '', options }] }
    expect(wire(input)).toStrictEqual(input)
    expect(
      harnessEventSchema.safeParse({
        ...snapshot,
        questions: [{ title: '', options: [...options, ''] }],
      }).success,
    ).toBe(false)
  })

  it('bounds all text metadata together, separately from snapshot content', () => {
    const questions = Array.from({ length: 16 }, () => ({
      title: utf8AtLimit(64 * 1024),
    }))
    const input = {
      ...snapshot,
      text: utf8AtLimit(4 * 1024 * 1024),
      questions,
    }
    expect(wire(input)).toStrictEqual(input)
    expect(
      harnessEventSchema.safeParse({
        ...input,
        questions: [{ ...questions[0], options: ['x'] }, ...questions.slice(1)],
      }).success,
    ).toBe(false)

    const metadata = {
      role: 'assistant',
      phase: 'final_answer',
      delivery: 'async',
    }
    // These three metadata strings contain 26 UTF-8 bytes.
    const adjusted = [
      { title: utf8AtLimit(64 * 1024 - 26) },
      ...questions.slice(1),
    ]
    const exact = { ...snapshot, ...metadata, questions: adjusted }
    expect(wire(exact)).toStrictEqual(exact)
    expect(
      harnessEventSchema.safeParse({
        ...exact,
        questions: [{ title: adjusted[0].title + 'x' }, ...adjusted.slice(1)],
      }).success,
    ).toBe(false)
  })

  it('includes option labels in the aggregate metadata byte ceiling', () => {
    const options = Array.from({ length: 16 }, () => utf8AtLimit(64 * 1024))
    const input = { ...snapshot, questions: [{ title: '', options }] }
    expect(wire(input)).toStrictEqual(input)
    expect(
      harnessEventSchema.safeParse({
        ...snapshot,
        questions: [{ title: '\u2028', options }],
      }).success,
    ).toBe(false)
  })

  it.each([
    { questionCount: 64, optionCount: 128, maximumBytes: 1024 * 1024 },
    { questionCount: 65, optionCount: 128, maximumBytes: 0 },
    { questionCount: 1, optionCount: 129, maximumBytes: 0 },
    { questionCount: 64, optionCount: 129, maximumBytes: 0 },
  ])(
    'bounds total encoding before rejecting oversized metadata: %j',
    ({ questionCount, optionCount, maximumBytes }) => {
      let encodedBytes = 0
      const encode = TextEncoder.prototype.encode
      const spy = vi
        .spyOn(TextEncoder.prototype, 'encode')
        .mockImplementation(function (this: TextEncoder, value) {
          const bytes = encode.call(this, value)
          encodedBytes += bytes.byteLength
          return bytes
        })
      try {
        const questions = Array.from({ length: questionCount }, () => ({
          title: 'x'.repeat(64 * 1024),
          options: Array.from({ length: optionCount }, () =>
            'x'.repeat(64 * 1024),
          ),
        }))
        expect(
          harnessEventSchema.safeParse({ ...snapshot, text: '', questions })
            .success,
        ).toBe(false)
        expect(encodedBytes).toBeLessThanOrEqual(maximumBytes)
      } finally {
        spy.mockRestore()
      }
    },
  )

  it('checks late overlong option arrays before encoding earlier metadata', () => {
    let encodedBytes = 0
    const encode = TextEncoder.prototype.encode
    const spy = vi
      .spyOn(TextEncoder.prototype, 'encode')
      .mockImplementation(function (this: TextEncoder, value) {
        const bytes = encode.call(this, value)
        encodedBytes += bytes.byteLength
        return bytes
      })
    try {
      const questions = Array.from({ length: 64 }, () => ({
        title: 'x'.repeat(64 * 1024),
        options: ['valid'],
      }))
      questions[63]!.options = Array.from({ length: 129 }, () =>
        'x'.repeat(64 * 1024),
      )
      expect(
        harnessEventSchema.safeParse({ ...snapshot, text: '', questions })
          .success,
      ).toBe(false)
      expect(encodedBytes).toBe(0)
    } finally {
      spy.mockRestore()
    }
  })

  it('bounds multibyte encoding work on metadata overflow', () => {
    let encodedBytes = 0
    const encode = TextEncoder.prototype.encode
    const spy = vi
      .spyOn(TextEncoder.prototype, 'encode')
      .mockImplementation(function (this: TextEncoder, value) {
        const bytes = encode.call(this, value)
        encodedBytes += bytes.byteLength
        return bytes
      })
    try {
      const questions = Array.from({ length: 64 }, () => ({
        title: '🧭'.repeat(16 * 1024),
        options: ['é'],
      }))
      expect(
        harnessEventSchema.safeParse({ ...snapshot, text: '', questions })
          .success,
      ).toBe(false)
      expect(encodedBytes).toBeLessThanOrEqual(1024 * 1024 + 2 * 64 * 1024)
    } finally {
      spy.mockRestore()
    }
  })

  it('keeps the public event type and content type available for type narrowing', () => {
    type ContentSnapshot = Extract<HarnessEvent, { type: 'content_snapshot' }>
    expectTypeOf<ContentSnapshot['contentType']>().toEqualTypeOf<
      'text' | 'thought' | 'plan'
    >()
    expectTypeOf<
      Extract<ContentSnapshot, { contentType: 'text' }>['role']
    >().toEqualTypeOf<'user' | 'assistant' | undefined>()
    expectTypeOf<
      Extract<ContentSnapshot, { contentType: 'thought' | 'plan' }>
    >().not.toHaveProperty('role')
  })
})

const boundedFields: [string, number, (value: string) => unknown][] = [
  ...['text', 'thought', 'plan'].map(
    (contentType): [string, number, (value: string) => unknown] => [
      `${contentType} snapshot`,
      4 * 1024 * 1024,
      (text) => ({ ...snapshot, contentType, text }),
    ],
  ),
  [
    'question title',
    64 * 1024,
    (title) => ({ ...snapshot, questions: [{ title }] }),
  ],
  [
    'question label',
    64 * 1024,
    (label) => ({ ...snapshot, questions: [{ title: '', options: [label] }] }),
  ],
  [
    'plan explanation',
    1024 * 1024,
    (explanation) => ({ ...plan, explanation }),
  ],
  ['diagnostic code', 256, (code) => ({ ...diagnostic, code })],
  ['diagnostic message', 4096, (message) => ({ ...diagnostic, message })],
  ['diagnostic details', 16 * 1024, (details) => ({ ...diagnostic, details })],
]
describe('public UTF-8 byte ceilings', () => {
  it.each(boundedFields)('bounds %s to %i bytes', (_name, bytes, input) => {
    const exact = input(utf8AtLimit(bytes))
    expect(wire(exact)).toStrictEqual(exact)
    // The overflow remains below the byte limit when measured in UTF-16 code units.
    expect(
      harnessEventSchema.safeParse(input(utf8AtLimit(bytes) + 'x')).success,
    ).toBe(false)
    expect(
      harnessEventSchema.safeParse(input('a'.repeat(bytes + 1))).success,
    ).toBe(false)
    expect(
      harnessEventSchema.safeParse(input('a'.repeat(bytes - 2) + '\ud800'))
        .success,
    ).toBe(false)
    const separator = input('a'.repeat(bytes - 3) + '\u2029')
    expect(wire(separator)).toStrictEqual(separator)
  })
})

describe('nonterminal diagnostic contract', () => {
  it.each(['info', 'warning', 'error'])(
    'preserves severity %s without inventing retryability or optional details',
    (severity) => {
      const input = { ...diagnostic, severity }
      expect(wire(input)).toStrictEqual(input)
    },
  )

  it('preserves explicit false, zero, null, empty text, and child ownership', () => {
    for (const httpStatus of [0, 429, 65535, null]) {
      for (const details of ['', null, 'a\u2028b\u2029c']) {
        const input = {
          ...diagnostic,
          childId: 'child-1',
          retryable: false,
          httpStatus,
          message: '',
          details,
        }
        expect(wire(input)).toStrictEqual(input)
      }
    }
    expect(wire({ ...diagnostic, retryable: true })).toStrictEqual({
      ...diagnostic,
      retryable: true,
    })
  })

  it('rejects missing identity, unknown keys, empty codes, and malformed fields', () => {
    for (const field of [
      'runId',
      'runtimeGeneration',
      'deliveryId',
      'turnId',
      'itemId',
    ]) {
      for (const input of [snapshot, diagnostic, usage, plan]) {
        for (const value of [undefined, null, '', 42])
          expect(
            harnessEventSchema.safeParse({ ...input, [field]: value }).success,
          ).toBe(false)
      }
    }
    for (const input of [snapshot, diagnostic, usage, plan]) {
      for (const childId of [null, '', 42])
        expect(
          harnessEventSchema.safeParse({ ...input, childId }).success,
        ).toBe(false)
    }
    for (const fields of [
      { code: '' },
      { code: undefined },
      { message: undefined },
      { message: null },
      { severity: undefined },
      { severity: 'fatal' },
      { retryable: null },
      { retryable: 'true' },
      { details: { raw: 'response' } },
      { outcome: { status: 'failed' } },
      { raw: {} },
      { extra: true },
    ])
      expect(
        harnessEventSchema.safeParse({ ...diagnostic, ...fields }).success,
      ).toBe(false)
  })

  it.each([-1, 0.5, 65536, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '429'])(
    'rejects invalid HTTP status %s',
    (httpStatus) => {
      expect(
        harnessEventSchema.safeParse({ ...diagnostic, httpStatus }).success,
      ).toBe(false)
    },
  )
})

describe('structured plan explanation', () => {
  it('preserves absent, null, empty, and literal Unicode explanations', () => {
    expect(wire(plan)).toStrictEqual(plan)
    for (const explanation of [null, '', 'a\u2028b\u2029c']) {
      const input = {
        ...plan,
        childId: 'child-1',
        explanation,
        steps: [{ id: 'inspect', title: 'Inspect source', status: 'running' }],
      }
      expect(wire(input)).toStrictEqual(input)
    }
  })

  it('rejects unknown keys and non-text explanations without accepting plan prose as progress', () => {
    for (const fields of [
      { explanation: {} },
      { text: 'Proposed plan' },
      { extra: true },
      {
        steps: [
          {
            id: 'step',
            title: 'Inspect source',
            status: 'running',
            extra: true,
          },
        ],
      },
    ])
      expect(harnessEventSchema.safeParse({ ...plan, ...fields }).success).toBe(
        false,
      )
  })
})

describe('detailed usage contract', () => {
  it('keeps latest, cumulative, context, and child values distinct without defaults', () => {
    expect(wire(usage)).toStrictEqual(usage)
    for (const modelContextWindow of [null, 0, Number.MAX_SAFE_INTEGER]) {
      const input = {
        ...usage,
        ...details,
        childId: 'child-1',
        cumulative: {
          inputTokens: 10,
          outputTokens: 8,
          totalTokens: 18,
          ...details,
        },
        modelContextWindow,
      }
      expect(wire(input)).toStrictEqual(input)
    }
    const input = { ...usage, cumulative: counts }
    expect(wire(input)).toStrictEqual(input)
  })

  it.each(Object.keys({ ...counts, ...details }))(
    'validates latest and cumulative %s as nonnegative safe integers',
    (field) => {
      for (const value of [0, Number.MAX_SAFE_INTEGER]) {
        const latest = { ...usage, [field]: value }
        expect(wire(latest)).toStrictEqual(latest)
        const cumulative = {
          ...usage,
          cumulative: { ...counts, [field]: value },
        }
        expect(wire(cumulative)).toStrictEqual(cumulative)
      }
      for (const value of [
        -1,
        0.5,
        Number.MAX_SAFE_INTEGER + 1,
        NaN,
        Infinity,
        null,
        '1',
      ]) {
        expect(
          harnessEventSchema.safeParse({ ...usage, [field]: value }).success,
        ).toBe(false)
        expect(
          harnessEventSchema.safeParse({
            ...usage,
            cumulative: { ...counts, [field]: value },
          }).success,
        ).toBe(false)
      }
    },
  )

  it('requires primary counters in both scopes and rejects unknown usage fields', () => {
    for (const field of Object.keys(counts)) {
      expect(
        harnessEventSchema.safeParse({ ...usage, [field]: undefined }).success,
      ).toBe(false)
      expect(
        harnessEventSchema.safeParse({
          ...usage,
          cumulative: { ...counts, [field]: undefined },
        }).success,
      ).toBe(false)
    }
    for (const fields of [
      { cumulative: null },
      { cumulative: [] },
      { cumulative: { ...counts, extra: 1 } },
      { extra: true },
    ])
      expect(
        harnessEventSchema.safeParse({ ...usage, ...fields }).success,
      ).toBe(false)
    for (const modelContextWindow of [
      -1,
      0.5,
      Number.MAX_SAFE_INTEGER + 1,
      NaN,
      Infinity,
      '1',
    ])
      expect(
        harnessEventSchema.safeParse({ ...usage, modelContextWindow }).success,
      ).toBe(false)
  })
})
