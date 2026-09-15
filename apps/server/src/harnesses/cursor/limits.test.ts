import { expect, it } from 'vitest'
import {
  cursorLimits,
  plainCopy,
  boundedId,
  CursorResources,
  type CursorLimits,
} from './limits.js'
import { CursorNormalizer } from './normalize.js'
import { validateEnvironment } from './launch.js'
import { captureInput, validateCatalog } from './input.js'
import { readCursorCredentials } from './credentials.js'
import type { CursorSelectedRecords, CursorOwner } from './contracts.js'

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
const norm = (overrides: Partial<CursorLimits>) =>
  new CursorNormalizer(
    owner,
    cursorLimits(overrides),
    () => {},
    () => {},
  )
const text = (normalizer: CursorNormalizer, value: string) =>
  normalizer.delta({ type: 'text-delta', text: value } as never)
it('exhausts independent environment entry, value, total, identifier, depth, and element limits', () => {
  for (const [value, limits] of [
    [{ A: 'x', B: 'y' }, cursorLimits({ envEntries: 1 })],
    [{ A: 'xx' }, cursorLimits({ envValueBytes: 2 })],
    [{ A: 'x', B: 'y' }, cursorLimits({ envBytes: 3 })],
  ] as const)
    expect(() => validateEnvironment(value, limits)).toThrow()
  expect(() => boundedId('éé', 3)).toThrow()
  expect(() => plainCopy({ a: { b: 1 } }, 1000, 1)).toThrow('value_shape')
  expect(() => plainCopy([1, 2, 3], 1000, 32, 2)).toThrow('value_shape')
})
it('exhausts prompt part, text, image count, and credential key bytes before reads', async () => {
  expect(() =>
    captureInput(
      [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ],
      { permissionMode: 'auto' },
      cursorLimits({ parts: 1 }),
    ),
  ).toThrow('input_parts')
  expect(() =>
    captureInput(
      'é'.repeat(100),
      { permissionMode: 'auto' },
      cursorLimits({ promptBytes: 100 }),
    ),
  ).toThrow()
  expect(() =>
    captureInput(
      [
        { type: 'attachment', attachmentId: 'a', mime: 'image/png' },
        { type: 'attachment', attachmentId: 'b', mime: 'image/png' },
      ],
      { permissionMode: 'auto' },
      cursorLimits({ images: 1 }),
    ),
  ).toThrow('input_limit')
  await expect(
    readCursorCredentials(
      {
        credential: { type: 'api-key', apiKey: 'abcd' },
      } as CursorSelectedRecords,
      cursorLimits({ credentialKeyBytes: 3 }),
      new AbortController().signal,
    ),
  ).rejects.toThrow('credential_invalid')
})
it('exhausts model, parameter, value, variant and catalog byte admission independently', () => {
  const model = {
    id: 'm',
    displayName: 'Model',
    parameters: [{ id: 'p', values: [{ value: 'one' }, { value: 'two' }] }],
    variants: [
      { params: [{ id: 'p', value: 'one' }] },
      { params: [{ id: 'p', value: 'two' }] },
    ],
  }
  for (const [items, limits] of [
    [[model, { ...model, id: 'n' }], cursorLimits({ models: 1 })],
    [
      [
        {
          ...model,
          parameters: [
            ...model.parameters,
            { id: 'q', values: [{ value: 'x' }] },
          ],
        },
      ],
      cursorLimits({ parameters: 1 }),
    ],
    [[model], cursorLimits({ parameterValues: 1 })],
    [[model], cursorLimits({ variants: 1 })],
    [[model], cursorLimits({ catalogBytes: 100 })],
  ] as const)
    expect(() => validateCatalog(items as never, limits)).toThrow()
})
it('exhausts root item, retained content, callback count, event bytes and diagnostic reservations', () => {
  const item = norm({ itemBytes: 2 })
  text(item, 'a')
  expect(() => text(item, 'bc')).toThrow('content_item_limit')
  const content = norm({ contentBytes: 3 })
  text(content, 'aa')
  content.delta({ type: 'thinking-delta', text: 'b' } as never)
  expect(() => text(content, 'c')).toThrow('content_limit')
  const count = norm({ rootEvents: 3 })
  text(count, 'a')
  expect(() => text(count, 'b')).toThrow('output_limit')
  const bytes = norm({ rootEventBytes: 800 })
  text(bytes, 'a')
  expect(() => text(bytes, 'b'.repeat(800))).toThrow('output_limit')
  const diagnostic = norm({ diagnostics: 2 })
  diagnostic.record('diagnostic', { code: 'one' })
  expect(() => diagnostic.record('diagnostic', { code: 'two' })).toThrow(
    'diagnostic_limit',
  )
  expect(() =>
    norm({ detailBytes: 16 }).record('diagnostic', { detail: 'a'.repeat(30) }),
  ).toThrow('value_bytes')
  expect(() =>
    norm({ diagnosticBytes: 4100 }).record('diagnostic', { code: 'one' }),
  ).toThrow('diagnostic_limit')
})
it('serializes raw and native scans and retains the physical global charge until release', async () => {
  const resources = new CursorResources(),
    limits = cursorLimits({ scans: 1, storeOperations: 2 })
  let release!: () => void,
    entered = 0
  const gate = new Promise<void>((done) => {
    release = done
  })
  const first = resources.scan('same-store', limits, async () => {
    entered++
    await gate
  })
  await Promise.resolve()
  const second = resources.scan('same-store', limits, async () => {
    entered++
  })
  expect(entered).toBe(1)
  expect(resources.snapshot().scans).toBe(1)
  expect(() => resources.scan('same-store', limits, async () => {})).toThrow(
    'scan_queue_limit',
  )
  await expect(
    resources.scan('other-store', limits, async () => {}),
  ).rejects.toThrow('resource_limit')
  release()
  await Promise.all([first, second])
  expect(entered).toBe(2)
  expect(resources.snapshot().scans).toBe(0)
})
it('exhausts retained identifiers, child count, live child count, child bytes and tool object bytes', () => {
  const ids = norm({ owners: 1 })
  text(ids, 'a')
  expect(() =>
    ids.delta({ type: 'thinking-delta', text: 'b' } as never),
  ).toThrow('resource_limit')
  expect(() => text(norm({ ownerBytes: 1 }), 'a')).toThrow('resource_limit')
  const task = (
    normalizer: CursorNormalizer,
    callId: string,
    isBackground: boolean,
  ) =>
    normalizer.delta({
      type: 'tool-call-completed',
      callId,
      toolCall: {
        type: 'task',
        args: { prompt: 'work' },
        result: { status: 'success', value: { agentId: callId, isBackground } },
      },
    } as never)
  const retained = norm({ children: 1 })
  task(retained, 'first', false)
  expect(() => task(retained, 'second', false)).toThrow('children_limit')
  const live = norm({ liveChildren: 1 })
  task(live, 'first', true)
  expect(() => task(live, 'second', true)).toThrow('children_limit')
  expect(() => task(norm({ childBytes: 1 }), 'first', false)).toThrow(
    'child_content_limit',
  )
  expect(() => task(norm({ toolBytes: 32 }), 'first', false)).toThrow(
    'value_bytes',
  )
})
