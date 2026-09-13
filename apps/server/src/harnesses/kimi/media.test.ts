import { expect, test } from 'vitest'
import { KimiHostOwner, type KimiLease } from './host.js'
import { KimiBudget, type KimiLimits } from './limits.js'
import { KimiRecords } from './records.js'
import {
  captureInput,
  prepareInput,
  validatePromptEnvelope,
  validateExactPromptEnvelope,
} from './input.js'
import { preserveMessage } from './discovery.js'
import type { KimiAttachmentSink, KimiLoadAttachment } from './types.js'

const scope = {
  sessionId: 'correction',
  runtimeGeneration: 'generation',
  binding: {
    provider: 'kimi',
    accountId: 'account',
    cwd: '/inert',
    providerSessionId: 'native',
  },
}
function fixture(limits: Partial<KimiLimits> = {}) {
  const host = new KimiHostOwner({ limits }),
    budget = new KimiBudget(host.budget.limits),
    calls: string[] = []
  const records = new KimiRecords(
    scope,
    budget,
    host,
    async (input) => ({
      ordinal: input.expectedOrdinal + 1,
      disposition: 'committed',
    }),
    () => {},
    new AbortController().signal,
  )
  const lease = {
    lane: 'lane',
    server: {
      http: async (
        _lane: string,
        path: string,
        options: { raw?: boolean } = {},
      ) => {
        calls.push(path)
        if (options.raw)
          return {
            bytes: Buffer.from([1, 2, 3]),
            release: host.budget.reserve('hostAttachmentBytes', 3),
          }
        return { id: 'native-file' }
      },
    },
  } as unknown as KimiLease
  return {
    host,
    budget,
    records,
    lease,
    calls,
    close: async () => {
      records.close()
      await host.close()
    },
  }
}
const part = {
  type: 'attachment' as const,
  attachmentId: 'attachment',
  mime: 'image/png',
}
const descriptor = (readBytes: () => Promise<Uint8Array>) => ({
  mime: 'image/png',
  name: 'image.png',
  path: '/inert/image.png',
  sizeBytes: 3,
  readBytes,
})
test('attachment byte refusal occurs before the descriptor reader starts', async () => {
  const f = fixture({ hostAttachmentBytes: 2 })
  let reads = 0
  const loader: KimiLoadAttachment = async () =>
    descriptor(async () => {
      reads++
      return Buffer.from([1, 2, 3])
    })
  await expect(
    prepareInput(
      [part],
      'correction',
      f.lease,
      f.host,
      f.budget,
      loader,
      new AbortController().signal,
      async () => {},
    ),
  ).rejects.toMatchObject({ code: 'kimi_resource_limit' })
  expect(reads).toBe(0)
  expect(f.calls).toEqual([])
  expect(f.host.budget.count('hostAttachmentBytes')).toBe(0)
  await f.close()
})
test('a timed-out attachment reader retains its known bytes until physical settlement', async () => {
  const f = fixture({ attachmentMs: 10 })
  let resolve!: (bytes: Uint8Array) => void
  const loader: KimiLoadAttachment = async () =>
    descriptor(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
  await expect(
    prepareInput(
      [part],
      'correction',
      f.lease,
      f.host,
      f.budget,
      loader,
      new AbortController().signal,
      async () => {},
    ),
  ).rejects.toMatchObject({ code: 'kimi_deadline' })
  expect(f.host.budget.count('hostAttachmentBytes')).toBe(3)
  expect(f.host.budget.count('hostAttachmentLoads')).toBe(1)
  resolve(Buffer.from([1, 2, 3]))
  await f.close()
  expect(f.host.budget.count('hostAttachmentBytes')).toBe(0)
  expect(f.calls).toEqual([])
})
test('a saturated media sink rolls back bytes without invoking the callback', async () => {
  const f = fixture({ sinkCalls: 1 }),
    release = f.host.budget.reserve('sinkCalls')
  let called = false
  const sink: KimiAttachmentSink = async () => {
    called = true
    return { attachmentId: 'stored' }
  }
  await expect(
    preserveMessage(
      {
        id: 'message',
        session_id: 'native',
        role: 'tool',
        content: [
          {
            type: 'image',
            source: { kind: 'base64', media_type: 'image/png', data: 'AQID' },
          },
        ],
      },
      'snapshot',
      f.records,
      f.lease,
      f.host,
      sink,
    ),
  ).rejects.toMatchObject({ code: 'kimi_resource_limit' })
  expect(called).toBe(false)
  expect(f.host.budget.count('hostAttachmentBytes')).toBe(0)
  expect(f.host.budget.count('hostIpcBytes')).toBe(0)
  release()
  await f.close()
})
test('raw tool media preserves owned kimi-file bytes through the owned file route', async () => {
  const f = fixture(),
    stored: number[] = []
  const sink: KimiAttachmentSink = async (input) => {
    expect(f.host.budget.count('hostAttachmentBytes')).toBe(3)
    for await (const chunk of input.bytes) stored.push(...chunk)
    return { attachmentId: 'stored' }
  }
  const result = await preserveMessage(
    {
      id: 'message',
      session_id: 'native',
      role: 'tool',
      content: [
        {
          type: 'tool_result',
          result: [
            {
              type: 'video_url',
              videoUrl: {
                url: 'kimi-file://owned?path=%2Fnever-read-this-path',
              },
            },
          ],
        },
      ],
    },
    'snapshot',
    f.records,
    f.lease,
    f.host,
    sink,
  )
  expect(stored).toEqual([1, 2, 3])
  expect(f.calls).toEqual(['/api/v1/files/owned'])
  expect(result.unavailable).toBe(false)
  expect(f.host.budget.count('hostAttachmentBytes')).toBe(0)
  result.release()
  await f.close()
})
test('a slow media sink cannot publish after the total history deadline and retains physical bytes', async () => {
  const f = fixture()
  let finish!: (value: { attachmentId: string }) => void
  const pending = preserveMessage(
    {
      id: 'slow',
      session_id: 'native',
      role: 'assistant',
      content: [
        {
          type: 'image',
          source: { kind: 'base64', media_type: 'image/png', data: 'AQID' },
        },
      ],
    },
    'snapshot',
    f.records,
    f.lease,
    f.host,
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
    undefined,
    undefined,
    performance.now() + 20,
  )
  await expect(pending).rejects.toMatchObject({ code: 'kimi_deadline' })
  expect(f.records.ordinal).toBe(0)
  expect(f.host.budget.count('hostAttachmentBytes')).toBe(3)
  expect(f.host.budget.count('sinkCalls')).toBe(1)
  finish({ attachmentId: 'stored-late' })
  await f.close()
  expect(f.host.budget.count('hostAttachmentBytes')).toBe(0)
  expect(f.host.budget.count('sinkCalls')).toBe(0)
})
test('text and encoded bodies use separate intersecting limits, including escape expansion', async () => {
  const f = fixture({ promptTextBytes: 64 }),
    settings = { permission_mode: 'manual' as const }
  const parts = captureInput('a'.repeat(64), f.budget)
  expect(() => validatePromptEnvelope(parts, settings, f.budget)).not.toThrow()
  expect(() => captureInput('a'.repeat(65), f.budget)).toThrow()
  await f.close()
  const exact = fixture({ httpControlBytes: 69 })
  expect(() =>
    validateExactPromptEnvelope(
      [{ type: 'text', text: 'abc' }],
      settings,
      exact.budget,
    ),
  ).not.toThrow()
  expect(() =>
    validateExactPromptEnvelope(
      [{ type: 'text', text: 'abcd' }],
      settings,
      exact.budget,
    ),
  ).toThrow('encoded Kimi prompt')
  expect(() =>
    validatePromptEnvelope(
      captureInput('\0', exact.budget),
      settings,
      exact.budget,
    ),
  ).toThrow('encoded Kimi prompt')
  expect(() => validatePromptEnvelope([part], settings, exact.budget)).toThrow(
    'encoded Kimi prompt',
  )
  expect(exact.calls).toEqual([])
  await exact.close()
})
