import { describe, expect, it } from 'vitest'
import type { InteractionUpdate, RunResult } from '@cursor/sdk'
import type { HarnessEvent } from '../types.js'
import type { CursorNativeEnvelope, CursorOwner } from './contracts.js'
import { captureInput, cursorMessage } from './input.js'
import { cursorLimits } from './limits.js'
import { CursorNormalizer } from './normalize.js'
import { parseFrame } from './wire.js'

const limits = cursorLimits()
const owner: CursorOwner = {
  forgeSessionId: 'session',
  provider: 'cursor',
  accountId: 'account',
  cwd: '/tmp',
  storeId: 'store',
  generation: 'generation',
  attemptId: 'attempt',
  runId: 'run',
  turnId: 'turn',
}
function fixture() {
  const events: HarnessEvent[] = [],
    records: CursorNativeEnvelope[] = []
  const normalizer = new CursorNormalizer(
    owner,
    limits,
    (event) => events.push(event),
    (record) => records.push(record),
  )
  return {
    events,
    records,
    normalizer,
    delta: (value: unknown) => normalizer.delta(value as InteractionUpdate),
    finish: (value: Partial<RunResult> = {}) =>
      normalizer.finish({ id: 'native', status: 'finished', ...value }),
  }
}

describe('Cursor corrected input and content boundaries', () => {
  it('accepts exact raw text maxima across UTF-8 and escaping, then rejects the next byte', async () => {
    for (const text of [
      'x'.repeat(limits.promptBytes),
      'é'.repeat(limits.promptBytes / 2),
      '\\'.repeat(limits.promptBytes),
      '\n'.repeat(limits.promptBytes),
    ]) {
      const parts = [
        { type: 'text' as const, text: text.slice(0, text.length / 2) },
        { type: 'text' as const, text: text.slice(text.length / 2) },
      ]
      const captured = captureInput(parts, { permissionMode: 'auto' }, limits)
      expect(captured.textBytes).toBe(limits.promptBytes)
      const message = await cursorMessage(
        'session',
        captured.parts,
        async () => {
          throw new Error('unexpected loader')
        },
        new AbortController().signal,
        limits,
      )
      expect(message.text).toBe(`${parts[0].text}\n${parts[1].text}`)
      expect(() =>
        captureInput(
          [...parts, { type: 'text', text: 'x' }],
          { permissionMode: 'auto' },
          limits,
        ),
      ).toThrow('cursor_input_limit')
    }
  })
  it('validates review fields and dispatch options after refusing descriptors', () => {
    for (const review of [
      { url: ['https://example.invalid'] },
      { url: 'https://example.invalid', title: 42 },
      { url: 'https://example.invalid', title: [] },
    ])
      expect(() =>
        captureInput(
          [{ type: 'review_reference', ...review }] as any,
          { permissionMode: 'auto' },
          limits,
        ),
      ).toThrow()
    for (const options of [
      null,
      { permissionMode: 'auto', model: 1 },
      { permissionMode: 'auto', extra: true },
      {
        permissionMode: 'auto',
        nativeModelParams: [{ id: 'x', value: '', extra: true }],
      },
      {
        permissionMode: 'auto',
        nativeModelParams: [
          { id: 'x', value: '' },
          { id: 'x', value: '' },
        ],
      },
    ])
      expect(() => captureInput('text', options as any, limits)).toThrow()
    let reads = 0
    expect(() =>
      captureInput(
        [
          {
            type: 'review_reference',
            get url() {
              reads++
              return 'https://example.invalid'
            },
          },
        ],
        { permissionMode: 'auto' },
        limits,
      ),
    ).toThrow('accessor')
    expect(reads).toBe(0)
    expect(
      captureInput(
        'text',
        {
          permissionMode: 'auto',
          model: null,
          reasoning: null,
          nativeModelParams: [{ id: 'x', value: '' }],
        },
        limits,
      ).options.model,
    ).toBeNull()
  })
  it('reserves separate base64 padding for each image', () => {
    for (let count = 1; count <= 4; count++)
      for (const size of [9, 10, 11]) {
        const local = cursorLimits({
          imageBytes: size,
          imageTotalBytes: size * 4,
        })
        const parts = Array.from({ length: count }, (_, index) => ({
          type: 'attachment' as const,
          attachmentId: String(index),
          mime: 'image/png',
        }))
        const captured = captureInput(parts, { permissionMode: 'auto' }, local)
        expect(captured.imageReservation).toBe(
          count * Buffer.alloc(size).toString('base64').length,
        )
      }
  })
  it('encodes four maximum PNG inputs with maximum raw text under their complete frame allowance', async () => {
    const parts = [
      { type: 'text' as const, text: 'x'.repeat(limits.promptBytes) },
      ...Array.from({ length: 4 }, (_, index) => ({
        type: 'attachment' as const,
        attachmentId: `image-${index}`,
        mime: 'image/png',
      })),
    ]
    const captured = captureInput(parts, { permissionMode: 'auto' }, limits)
    let reads = 0
    const message = await cursorMessage(
      'session',
      captured.parts,
      async (_session, id) => ({
        attachmentId: id,
        mime: 'image/png',
        size: limits.imageBytes,
        read: async () => {
          reads++
          const bytes = Buffer.alloc(limits.imageBytes)
          bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
          return bytes
        },
      }),
      new AbortController().signal,
      limits,
    )
    expect(reads).toBe(4)
    const encoded = message.images!.reduce(
      (total, image) => total + ('data' in image ? image.data.length : 0),
      0,
    )
    expect(encoded).toBe(11184816)
    expect(captured.imageReservation).toBe(encoded)
    expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThanOrEqual(
      limits.frameBytes - limits.controlBytes,
    )
    expect(() =>
      captureInput(
        [...parts, { type: 'text', text: 'x' }],
        { permissionMode: 'auto' },
        limits,
      ),
    ).toThrow('cursor_input_limit')
    expect(reads).toBe(4)
  })
  it.each(['text', 'thinking'])(
    'keeps child %s separate from its root append slot',
    (kind) => {
      const { events, delta, finish } = fixture()
      delta({ type: `${kind}-delta`, text: 'A' })
      delta({
        type: 'tool-call-started',
        callId: 'spawn',
        toolCall: { type: 'task', args: { prompt: 'child' } },
      })
      delta({
        type: 'tool-call-delta',
        callId: 'spawn',
        taskUpdate: { type: `${kind}-delta`, text: 'CHILD' },
      })
      delta({ type: `${kind}-delta`, text: 'B' })
      finish()
      const snapshots = events.filter(
        (event) =>
          event.type === 'text_delta' || event.type === 'thought_delta',
      )
      expect(snapshots.map((event) => event.text)).toEqual(['A', 'CHILD', 'B'])
      expect(snapshots[1].childId).toBeDefined()
      expect(snapshots[0].itemId).toBe(snapshots[2].itemId)
      expect(snapshots[1].itemId).not.toBe(snapshots[0].itemId)
    },
  )
  it.each(['thinking', 'tool'])(
    'corrects the last assistant across a later %s-only turn',
    (later) => {
      const { events, delta, finish } = fixture()
      delta({ type: 'user-message-appended' })
      delta({ type: 'text-delta', text: 'ANSWER' })
      delta({ type: 'user-message-appended' })
      if (later === 'thinking')
        delta({ type: 'thinking-delta', text: 'thought' })
      else
        delta({
          type: 'tool-call-completed',
          callId: 'tool',
          toolCall: { type: 'read', result: { status: 'success' } },
        })
      finish({ result: 'FINAL ANSWER' })
      const texts = events.filter(
        (event) =>
          event.type === 'text_delta' ||
          (event.type === 'content_snapshot' && event.contentType === 'text'),
      )
      expect(texts).toHaveLength(2)
      expect(texts[0].itemId).toBe(texts[1].itemId)
    },
  )
  it('keeps absent and empty final text distinct without adding an empty item', () => {
    for (const final of [{}, { result: '' }]) {
      const value = fixture()
      value.finish(final)
      expect(
        value.events.filter((event) => event.type === 'content_snapshot'),
      ).toHaveLength(0)
    }
    const value = fixture()
    value.delta({ type: 'text-delta', text: 'remove' })
    value.finish({ result: '' })
    expect(
      value.events
        .filter((event) => event.type === 'content_snapshot')
        .map((event) => event.text),
    ).toEqual([''])
  })
  it('keeps the latest call separate from cumulative final usage and reasoning', () => {
    const value = fixture()
    value.delta({
      type: 'turn-ended',
      usage: { inputTokens: 10, outputTokens: 9, reasoningTokens: 2 },
    })
    value.delta({
      type: 'turn-ended',
      usage: { inputTokens: 20, outputTokens: 21, reasoningTokens: 3 },
    })
    value.finish({
      usage: {
        inputTokens: 30,
        outputTokens: 30,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 60,
        reasoningTokens: 5,
      },
    })
    const usage = value.events.filter((event) => event.type === 'usage')
    expect(usage.map((event) => event.totalTokens)).toEqual([19, 41, 41])
    expect(usage[2]).toMatchObject({
      reasoningOutputTokens: 3,
      cumulative: { totalTokens: 60, reasoningOutputTokens: 5 },
    })
  })
  it('retains a maximum escaped assistant callback and terminal record inside the fixed frame', () => {
    const text = '\u0000'.repeat(limits.itemBytes)
    const value = fixture()
    value.normalizer.step({
      type: 'assistantMessage',
      message: { text },
    } as any)
    value.finish({ result: text })
    for (const record of value.records) {
      const frame = {
        v: 1,
        generation: owner.generation,
        type: 'native_record',
        owner,
        record,
      }
      expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThan(
        limits.frameBytes,
      )
      expect(parseFrame(frame, owner.generation, limits).record).toEqual(record)
    }
    expect(value.records.at(-1)?.payload).toMatchObject({ result: text })
    expect(() =>
      fixture().normalizer.step({
        type: 'assistantMessage',
        message: { text: `${text}x` },
      } as any),
    ).toThrow('cursor_content_item_limit')
  })
  it.each(['text', 'thinking'])(
    'publishes two MiB of small %s appends with one stable item and linear output',
    (kind) => {
      const value = fixture(),
        chunk = 'x'.repeat(1024)
      for (let index = 0; index < 2048; index++)
        value.delta({ type: `${kind}-delta`, text: chunk })
      const appends = value.events.filter(
        (event) =>
          event.type === 'text_delta' || event.type === 'thought_delta',
      )
      expect(appends).toHaveLength(2048)
      expect(new Set(appends.map((event) => event.itemId)).size).toBe(1)
      expect(appends.map((event) => event.text).join('')).toBe(
        chunk.repeat(2048),
      )
      expect(
        value.events.reduce(
          (total, event) => total + Buffer.byteLength(JSON.stringify(event)),
          0,
        ),
      ).toBeLessThan(3 * limits.itemBytes)
      expect(
        value.events.some((event) => event.type === 'content_snapshot'),
      ).toBe(false)
      expect(() => value.delta({ type: `${kind}-delta`, text: 'x' })).toThrow(
        'cursor_content_item_limit',
      )
    },
  )
  it('omits identical empty and nonempty snapshots while retaining every native record and real correction', () => {
    const value = fixture()
    for (const text of ['', '', 'longer', 'longer', 'short', ''])
      value.normalizer.step({ type: 'assistantMessage', message: { text } })
    value.finish({ result: '' })
    expect(
      value.events
        .filter((event) => event.type === 'content_snapshot')
        .map((event) => event.text),
    ).toEqual(['longer', 'short', ''])
    expect(value.records.map((record) => record.kind)).toEqual([
      ...Array(6).fill('sdk-record'),
      'terminal',
    ])
  })
  it('preserves the independent 32 MiB callback and stream ceilings beside 64 MiB emitted output', () => {
    const text = '\u0000'.repeat(limits.itemBytes)
    const callback = fixture()
    callback.normalizer.step({ type: 'assistantMessage', message: { text } })
    callback.normalizer.step({ type: 'assistantMessage', message: { text } })
    expect(() =>
      callback.normalizer.step({ type: 'assistantMessage', message: { text } }),
    ).toThrow('cursor_output_limit')
    const emitted = [...callback.events, ...callback.records].reduce(
      (total, value) => total + Buffer.byteLength(JSON.stringify(value)),
      0,
    )
    expect(emitted).toBeGreaterThan(32 * 1024 * 1024)
    expect(emitted).toBeLessThan(64 * 1024 * 1024)
    const stream = fixture()
    const message = {
      type: 'assistant' as const,
      agent_id: 'agent',
      run_id: 'run',
      message: {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text }],
      },
    }
    stream.normalizer.stream(message)
    stream.normalizer.stream(message)
    expect(() => stream.normalizer.stream(message)).toThrow(
      'cursor_output_limit',
    )
    expect(stream.events).toHaveLength(0)
    expect(stream.records).toHaveLength(0)
  })
})
