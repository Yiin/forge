import { afterEach, describe, expect, test } from 'vitest'
import type {
  DispatchOptions,
  HarnessEvent,
  PermissionReply,
  PromptInput,
} from '../types.js'
import type { KimiCatalog, KimiRoot } from './types.js'
import type { KimiLease } from './host.js'
import { KimiHostOwner } from './host.js'
import { KimiBudget, kimiLimits, jsonBytes, type KimiLimits } from './limits.js'
import { KimiRecords } from './records.js'
import { KimiInteractions } from './interactions.js'
import { captureInput, resolveSettings } from './input.js'

const closes: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closes.splice(0)) await close()
})
const catalog: KimiCatalog = {
  version: '0.34.0',
  models: [],
  commands: { status: 'unsupported', reason: 'fixture' },
}
function fixture(overrides: Partial<KimiLimits> = {}) {
  const host = new KimiHostOwner({ limits: overrides }),
    budget = new KimiBudget(host.budget.limits)
  const events: HarnessEvent[] = [],
    writes: unknown[] = [],
    pending: Record<string, unknown>[] = []
  const scope = {
    sessionId: 'correction-session',
    runtimeGeneration: 'correction-generation',
    binding: {
      provider: 'kimi-correction',
      accountId: 'correction-account',
      cwd: '/inert',
      providerSessionId: 'correction-native',
    },
  }
  const records = new KimiRecords(
    scope,
    budget,
    host,
    async (input) => ({
      ordinal: input.expectedOrdinal + 1,
      disposition: 'committed',
    }),
    (event) => events.push(event),
    new AbortController().signal,
  )
  const lease = {
    lane: 'correction',
    server: {
      http: async (
        _lane: string,
        _path: string,
        options: { method?: string; body?: unknown } = {},
      ) => {
        if (options.method === 'POST') {
          writes.push(structuredClone(options.body))
          return { resolved: true }
        }
        return { items: pending }
      },
    },
  } as unknown as KimiLease
  const interactions = new KimiInteractions(
    records,
    lease,
    (work) => work(),
    async (error) => {
      throw error
    },
  )
  const root: KimiRoot = {
    runId: 'run',
    turnId: 'turn',
    operationId: 'operation',
  }
  closes.push(async () => {
    await interactions.expire('Fixture closed')
    await records.drain()
    interactions.close()
    records.close()
    await host.close()
    expect(budget.count('interactions')).toBe(0)
    expect(host.budget.count('hostRetainedBytes')).toBe(0)
  })
  async function request(
    kind: 'question' | 'approval',
    id: string,
    owner = root,
    agent = 'main',
  ) {
    const raw =
      kind === 'approval'
        ? {
            approval_id: id,
            session_id: scope.binding.providerSessionId,
            turn_id: 1,
            action: 'Fixture approval',
            tool_input: {},
          }
        : {
            question_id: id,
            session_id: scope.binding.providerSessionId,
            turn_id: 1,
            questions: [
              {
                id: 'item:one',
                question: 'Pick',
                options: [{ id: 'option:one', label: 'One' }],
                allow_other: true,
              },
            ],
          }
    pending.push(raw)
    await interactions.observe(kind, raw, owner, '1', agent)
    const event = events.at(-1)
    if (
      event?.type !== 'permission_requested' &&
      event?.type !== 'question_requested'
    )
      throw new Error('Missing requested event')
    return event.request.requestId
  }
  return {
    host,
    budget,
    records,
    interactions,
    root,
    events,
    writes,
    pending,
    request,
  }
}

describe('Kimi shared input and reply validation', () => {
  test.each([
    {},
    [],
    [0, 1, 2],
    { text: '\u0000\n\t"\\\ud800\udc00\ud800', missing: undefined },
    { rows: [{ name: 'ž😀' }] },
  ])('preflights the complete exact JSON byte boundary: %j', (value) => {
    const bytes = Buffer.byteLength(JSON.stringify(value))
    expect(jsonBytes(value, kimiLimits(), bytes)).toBe(bytes)
    expect(() => jsonBytes(value, kimiLimits(), bytes - 1)).toThrow()
  })
  test.each([
    { type: 'unexpected', optionId: 'approve_once' },
    { optionId: 'approve_once' },
    { type: 'denied', reason: 7 },
    {
      type: 'selected',
      optionId: 'approve_once',
      grant: { network: { enabled: false } },
    },
  ])(
    'refuses malformed or unsupported permission reply before mutation: %j',
    async (input) => {
      const f = fixture(),
        requestId = await f.request('approval', 'approval')
      expect(() =>
        f.interactions.replyPermission({
          ...input,
          requestId,
        } as PermissionReply),
      ).toThrow()
      expect(f.writes).toEqual([])
      await f.interactions.replyPermission({
        type: 'denied',
        requestId,
        reason: 'Explicit denial',
      })
      expect(f.writes).toEqual([
        { decision: 'rejected', feedback: 'Explicit denial' },
      ])
    },
  )
  test('explicit approval remains available', async () => {
    const f = fixture(),
      requestId = await f.request('approval', 'approval')
    await f.interactions.replyPermission({
      type: 'selected',
      requestId,
      optionId: 'approve_once',
    })
    expect(f.writes).toEqual([{ decision: 'approved' }])
  })
  test('strict options retain omitted defaults and explicit supported values', () => {
    const defaults = { permission_mode: 'auto' as const }
    expect(resolveSettings(undefined, defaults, catalog)).toEqual(defaults)
    expect(resolveSettings({} as DispatchOptions, defaults, catalog)).toEqual(
      defaults,
    )
    expect(
      resolveSettings({ permissionMode: 'yolo' }, defaults, catalog),
    ).toEqual({ permission_mode: 'yolo' })
    for (const input of [
      { permissionMode: 'invalid' },
      { permissionMode: 'manual', readOnly: true },
    ])
      expect(() =>
        resolveSettings(input as DispatchOptions, defaults, catalog),
      ).toThrow()
  })
  test('rejects malformed attachment and review fields before returning captured input', () => {
    const budget = new KimiBudget(kimiLimits())
    for (const part of [
      { type: 'attachment', attachmentId: 'a', mime: 7 },
      { type: 'attachment', attachmentId: 'a', mime: 'not-mime' },
      { type: 'review_reference', url: 'not-a-url' },
    ])
      expect(() => captureInput([part] as PromptInput[], budget)).toThrow()
    const valid = [
      {
        type: 'review_reference' as const,
        url: 'https://example.invalid/review',
      },
    ]
    expect(captureInput(valid, budget)).toEqual(valid)
  })
  test('text-only admission accepts its full lowered allowance and rejects the next byte', () => {
    const budget = new KimiBudget(kimiLimits({ promptTextBytes: 64 }))
    expect(captureInput('x'.repeat(64), budget)).toEqual([
      { type: 'text', text: 'x'.repeat(64) },
    ])
    expect(() => captureInput('x'.repeat(65), budget)).toThrow()
  })
})

describe('Kimi original interaction execution and admission', () => {
  test.each(['question', 'approval'] as const)(
    'main expiry retains detached child %s',
    async (kind) => {
      const f = fixture(),
        main = await f.request(kind, 'main'),
        child = await f.request(
          kind,
          'child',
          { ...f.root, childId: 'child-execution' },
          'child-agent',
        )
      await f.interactions.expire('Main ended', f.root)
      expect(
        f.events
          .filter((event) => event.type === 'request_cancelled')
          .map((event) => event.requestId),
      ).toEqual([main])
      if (kind === 'approval')
        await f.interactions.replyPermission({
          type: 'selected',
          requestId: child,
          optionId: 'approve_once',
        })
      else
        await f.interactions.replyQuestion(child, {
          'item:one': { type: 'selected', optionIds: ['option:one'] },
        })
      expect(f.writes).toHaveLength(1)
    },
  )
  test('failed byte admission rolls back its interaction count before repeated observations', async () => {
    const f = fixture({ interactionBytes: 128 })
    for (let index = 0; index < 5; index++) {
      await expect(
        f.interactions.observe(
          'approval',
          { approval_id: `bad-${index}`, action: 'x'.repeat(256) },
          f.root,
          '1',
          'main',
        ),
      ).rejects.toThrow()
      expect(f.budget.count('interactions')).toBe(0)
      expect(f.budget.count('interactionBytes')).toBe(0)
    }
    const raw = { approval_id: 'valid' }
    f.pending.push(raw)
    await f.interactions.observe('approval', raw, f.root, '1', 'main')
    expect(f.budget.count('interactions')).toBe(1)
  })
})
