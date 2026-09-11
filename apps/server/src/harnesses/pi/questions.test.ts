import { afterEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { QuestionAnswer } from '../types.js'
import {
  fixture,
  latch,
  pending,
  waitPhysicalIdle,
} from './fixtures/test-support.js'
import { check, physicalState } from './wire.js'
import type { PiAdapterOptions } from './index.js'

const owned: Array<Awaited<ReturnType<typeof fixture>>> = []
afterEach(async () => {
  for (const f of owned.splice(0)) await f.close()
  await waitPhysicalIdle()
})
async function question(
  method: string,
  fields: Record<string, unknown> = {},
  overrides: Partial<PiAdapterOptions> = {},
) {
  const f = await fixture({ behavior: 'manual' })
  owned.push(f)
  const { handle } = await f.start(overrides)
  const receipt = handle.prompt('question')
  await receipt.acceptance
  await f.control({
    events: [
      {
        type: 'extension_ui_request',
        id: 'original-native-id',
        method,
        title: 'Question',
        ...fields,
      },
    ],
  })
  const event = await f.wait(
    () => f.events.find((e) => e.type === 'question_requested') ?? false,
  )
  if (event.type !== 'question_requested') throw new Error('Missing question')
  const request = event.request
  return {
    f,
    handle,
    receipt,
    request,
    answer: (answer: QuestionAnswer) =>
      handle.replyQuestion!(request.requestId, {
        [request.questions[0]!.id]: answer,
      }),
  }
}
describe('Pi original question handles', () => {
  it.each(['released', 'blocked'] as const)(
    'Q7, E4, 35: %s expiry persistence keeps bounded cancellation ownership',
    async (mode) => {
      const f = await fixture({ behavior: 'manual' })
      owned.push(f)
      const held = latch(),
        entered = latch()
      const { handle } = await f.start({
        persistRecord: async (...args) => {
          if (
            args[2].body.type === 'ui_request' &&
            args[2].body.status === 'expired'
          ) {
            entered.resolve()
            await held.promise
            check(args[3])
          }
          await f.options.persistRecord(...args)
        },
      })
      const receipt = handle.prompt('Question')
      await receipt.acceptance
      await f.control({
        events: [
          {
            type: 'extension_ui_request',
            id: 'expiry',
            method: 'input',
            title: 'Question',
          },
        ],
      })
      const start = performance.now()
      const cancelled = Promise.resolve(handle.cancel())
      const outcome = cancelled.then(
        () => 'closed',
        (error) => error.code as string,
      )
      try {
        await entered.promise
        expect(await pending(receipt.completion)).toBe(true)
        if (mode === 'released') held.resolve()
        expect(await outcome).toBe(
          mode === 'released' ? 'closed' : 'PI_DEADLINE',
        )
        expect(performance.now() - start).toBeLessThan(1000)
        expect(await receipt.completion).toMatchObject({
          status: 'interrupted',
        })
        expect(
          f.events.filter((e) => e.type === 'request_cancelled'),
        ).toHaveLength(1)
        if (mode === 'blocked') {
          expect(physicalState().classes.sink).toBe(1)
          expect(
            f.records.filter((r) => r.body.type === 'ui_request'),
          ).toHaveLength(1)
        } else
          expect(
            f.records.filter((r) => r.body.type === 'ui_request'),
          ).toHaveLength(2)
      } finally {
        held.resolve()
        await handle.kill()
        await waitPhysicalIdle()
      }
      expect(physicalState().count).toBe(0)
    },
  )
  it.each(['select', 'confirm'] as const)(
    'Q6, 34: %s display redacts overlapping values and keeps exact native replies',
    async (method) => {
      const f = await fixture({ behavior: 'manual' })
      owned.push(f)
      const shorter = 'fixture-overlap',
        longer = shorter + '-hidden'
      const env = { FORGE_PI_SHORT: shorter, FORGE_PI_LONG: longer }
      const { handle } = await f.start({
        env,
        launch: { ...f.options.launch, selectedEnvOverrides: env },
      })
      const receipt = handle.prompt('Question')
      await receipt.acceptance
      await f.control({
        events: [
          {
            type: 'extension_ui_request',
            id: 'original-display',
            method,
            title: longer,
            ...(method === 'confirm'
              ? { message: longer }
              : { options: [shorter, longer, longer] }),
          },
        ],
      })
      const event = await f.wait(
        () => f.events.find((e) => e.type === 'question_requested') ?? false,
      )
      if (event.type !== 'question_requested') throw Error('Missing question')
      expect(JSON.stringify(event).includes(shorter)).toBe(false)
      expect(JSON.stringify(event).includes('-hidden')).toBe(false)
      const question = event.request.questions[0]!
      expect(question.header).toBe('[REDACTED]')
      expect(question.question).toBe('[REDACTED]')
      const index = method === 'select' ? 2 : 0
      await handle.replyQuestion!(event.request.requestId, {
        [question.id]: {
          type: 'selected',
          optionIds: [question.options[index]!.id],
        },
      })
      const reply = (await f.wire()).find(
        (frame) => frame.type === 'extension_ui_response',
      )!
      expect(reply.id).toBe('original-display')
      expect(
        method === 'select' ? reply.value === longer : reply.confirmed === true,
      ).toBe(true)
      if (method === 'select') {
        expect(question.options.map((option) => option.label)).toEqual([
          '[REDACTED]',
          '[REDACTED]',
          '[REDACTED]',
        ])
        expect(new Set(question.options.map((option) => option.id)).size).toBe(
          3,
        )
      }
    },
  )
  it('Q7, 35, 45: ordinary cancellation commits expiry before it completes', async () => {
    const q = await question('select', { options: ['One'] })
    await q.handle.cancel()
    expect(await q.receipt.completion).toMatchObject({ status: 'interrupted' })
    expect(
      q.f.records
        .filter((r) => r.body.type === 'ui_request')
        .map((r) => r.body.type === 'ui_request' && r.body.status),
    ).toEqual(['pending', 'expired'])
    expect(
      q.f.events
        .filter((e) => e.type === 'request_cancelled')
        .map((e) => e.requestId),
    ).toEqual([q.request.requestId])
    const wire = await q.f.wire()
    expect(
      wire.filter((frame) => frame.type === 'extension_ui_response'),
    ).toEqual([
      {
        type: 'extension_ui_response',
        id: 'original-native-id',
        cancelled: true,
      },
    ])
    expect(wire.filter((frame) => frame.type === 'abort')).toHaveLength(1)
  })
  it.each(['maxQuestions', 'maxRequestIds'] as const)(
    '35, 50: native %s exhaustion disables the generation without replying',
    async (key) => {
      const q = await question('input', {}, { limits: { [key]: 1 } })
      if (key === 'maxRequestIds')
        await q.answer({ type: 'free_text', text: 'first' })
      await q.f.control({
        events: [
          {
            type: 'extension_ui_request',
            id: 'second-native',
            method: 'input',
            title: 'Second',
          },
        ],
      })
      expect(await q.receipt.completion).toMatchObject({
        status: 'failed',
        code: 'PI_REQUEST_LIMIT',
      })
      expect(
        (await q.f.wire()).filter(
          (frame) =>
            frame.type === 'extension_ui_response' &&
            frame.id === 'second-native',
        ),
      ).toEqual([])
    },
  )
  it.each([
    ['select', { options: ['Same', 'Same'] }, 'selected', 'Same'],
    ['confirm', { message: 'Confirm?' }, 'selected', true],
    ['input', {}, 'free_text', ''],
    ['editor', { prefill: 'Original' }, 'free_text', 'Edited'],
  ] as const)(
    '34: submits exact native %s reply and commits submitted state',
    async (method, fields, answerType, value) => {
      const { f, request, answer } = await question(method, fields)
      await answer(
        answerType === 'selected'
          ? {
              type: 'selected',
              optionIds: [request.questions[0]!.options[0]!.id],
            }
          : { type: 'free_text', text: String(value) },
      )
      const response = await f.wait(
        async () =>
          (await f.wire()).find(
            (command) => command.type === 'extension_ui_response',
          ) ?? false,
      )
      expect(response).toEqual({
        type: 'extension_ui_response',
        id: 'original-native-id',
        ...(method === 'confirm' ? { confirmed: value } : { value }),
      })
      expect(
        f.records.find((record) => record.body.type === 'ui_reply')?.body,
      ).toMatchObject({ status: 'submitted', requestId: request.requestId })
    },
  )
  it('34: explicit no sends false and skipped sends cancellation', async () => {
    const no = await question('confirm', { message: 'Confirm?' })
    await no.answer({
      type: 'selected',
      optionIds: [no.request.questions[0]!.options[1]!.id],
    })
    await no.f.wait(
      async () =>
        (await no.f.wire()).some((command) => command.confirmed === false) ||
        false,
    )
    const skip = await question('input')
    await skip.answer({ type: 'skipped' })
    expect(
      await skip.f.wait(
        async () =>
          (await skip.f.wire()).find((command) => command.cancelled) ?? false,
      ),
    ).toMatchObject({ cancelled: true })
  })
  it('34: explicit cancel uses the held original native ID', async () => {
    const { f, handle, request } = await question('editor', { prefill: 'Keep' })
    await handle.cancelQuestion(request.requestId)
    expect(
      await f.wait(
        async () =>
          (await f.wire()).find((command) => command.cancelled) ?? false,
      ),
    ).toMatchObject({ id: 'original-native-id', cancelled: true })
  })
  it.each([
    { type: 'selected', optionIds: ['unknown'] },
    { type: 'free_text', text: 'not a selection' },
    { type: 'selected_with_text', optionIds: [], text: 'mixed' },
    { type: 'selected', optionIds: [] },
  ] satisfies QuestionAnswer[])(
    '35: invalid answers retain a usable request: %j',
    async (invalid) => {
      const { f, request, answer } = await question('select', {
        options: ['One', 'Two'],
      })
      await expect(answer(invalid)).rejects.toThrow()
      expect(
        (await f.wire()).some(
          (command) => command.type === 'extension_ui_response',
        ),
      ).toBe(false)
      await answer({
        type: 'selected',
        optionIds: [request.questions[0]!.options[1]!.id],
      })
      expect(
        await f.wait(
          async () =>
            (await f.wire()).find(
              (command) => command.type === 'extension_ui_response',
            ) ?? false,
        ),
      ).toMatchObject({ value: 'Two' })
    },
  )
  it('35: submission waits for persistence and rejects a duplicate throughout', async () => {
    const held = latch()
    const entered = latch()
    const q = await question(
      'input',
      {},
      {
        persistRecord: async (_owner, _binding, record) => {
          if (record.body.type === 'ui_reply') {
            entered.resolve()
            await held.promise
          }
        },
      },
    )
    const reply = q.answer({ type: 'free_text', text: '' })
    await entered.promise
    expect(await pending(Promise.resolve(reply))).toBe(true)
    await expect(
      q.answer({ type: 'free_text', text: 'duplicate' }),
    ).rejects.toThrow('PI_REQUEST_UNAVAILABLE')
    held.resolve()
    await reply
    expect(
      (await q.f.wire()).filter(
        (command) => command.type === 'extension_ui_response',
      ),
    ).toHaveLength(1)
  })
  it('35: silent native expiry remains submission-only and is never retried', async () => {
    const q = await question('input')
    await q.f.control({ silentExpire: 'original-native-id' })
    await q.answer({ type: 'free_text', text: 'late but locally valid' })
    await q.f.wait(async () => {
      try {
        return JSON.parse(
          await readFile(join(q.f.directory, 'last-native-reply.json'), 'utf8'),
        ) as object
      } catch {
        return false
      }
    })
    expect(
      JSON.parse(
        await readFile(join(q.f.directory, 'last-native-reply.json'), 'utf8'),
      ),
    ).toEqual({ id: 'original-native-id', handled: false })
    expect(
      q.f.records.find((record) => record.body.type === 'ui_reply')?.body,
    ).toMatchObject({ status: 'submitted' })
    await expect(
      q.answer({ type: 'free_text', text: 'retry' }),
    ).rejects.toThrow('PI_REQUEST_UNAVAILABLE')
  })
  it('35: a native timeout within the safety margin expires before a reply', async () => {
    const q = await question('input', { timeout: 100 })
    await expect(q.answer({ type: 'free_text', text: '' })).rejects.toThrow(
      'PI_REQUEST_UNAVAILABLE',
    )
    expect(
      (await q.f.wire()).some(
        (command) => command.type === 'extension_ui_response',
      ),
    ).toBe(false)
    expect(q.f.events.some((event) => event.type === 'request_cancelled')).toBe(
      true,
    )
  })
  it('35: persistence failure after submission closes ownership without a second native write', async () => {
    const q = await question(
      'input',
      {},
      {
        persistRecord: async (_owner, _binding, record) => {
          if (record.body.type === 'ui_reply') throw new Error('commit failed')
        },
      },
    )
    await expect(
      q.answer({ type: 'free_text', text: 'once' }),
    ).rejects.toThrow()
    await expect(
      q.answer({ type: 'free_text', text: 'twice' }),
    ).rejects.toThrow('PI_REQUEST_UNAVAILABLE')
    expect(
      (await q.f.wire()).filter(
        (command) => command.type === 'extension_ui_response',
      ),
    ).toHaveLength(1)
    expect(await q.receipt.completion).toMatchObject({ status: 'failed' })
  })
  it('36: fire-and-forget UI metadata creates no reply resolver', async () => {
    const f = await fixture({ behavior: 'manual' })
    owned.push(f)
    const { handle } = await f.start()
    const receipt = handle.prompt('metadata')
    await receipt.acceptance
    await f.control({
      events: [
        {
          type: 'extension_ui_request',
          id: 'a',
          method: 'notify',
          message: 'Hello',
        },
        {
          type: 'extension_ui_request',
          id: 'b',
          method: 'setStatus',
          statusKey: 'key',
          statusText: 'value',
        },
        {
          type: 'extension_ui_request',
          id: 'c',
          method: 'setWidget',
          widgetKey: 'key',
          widgetLines: ['line'],
        },
        {
          type: 'extension_ui_request',
          id: 'd',
          method: 'setTitle',
          title: 'Title',
        },
        {
          type: 'extension_ui_request',
          id: 'e',
          method: 'set_editor_text',
          text: 'Suggestion',
        },
      ],
    })
    await f.wait(() => f.records.length === 5 || false)
    expect(f.events.some((event) => event.type === 'question_requested')).toBe(
      false,
    )
    expect(
      (await f.wire()).some(
        (command) => command.type === 'extension_ui_response',
      ),
    ).toBe(false)
    await f.control({
      events: [
        {
          type: 'extension_ui_request',
          id: 'unknown',
          method: 'customTerminal',
        },
      ],
    })
    expect(await receipt.completion).toMatchObject({
      status: 'failed',
      code: 'PI_UNSUPPORTED_EXTENSION_UI',
    })
  })
})
