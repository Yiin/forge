import { afterEach, describe, expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { harnessEventSchema } from '@forge/protocol/harness'
import { foldTimeline } from '@forge/protocol/timeline'
import { createPiAdapter, type PiAdapterOptions } from './index.js'
import {
  fixture,
  assistant,
  pending,
  latch,
  png,
  imageLoader,
  waitPhysicalIdle,
  type PeerConfig,
} from './fixtures/test-support.js'
import { MiB, physicalState, reservePhysical } from './wire.js'

const owned: Array<Awaited<ReturnType<typeof fixture>>> = []
async function peer(config?: PeerConfig) {
  const f = await fixture(config)
  owned.push(f)
  return f
}
afterEach(async () => {
  for (const f of owned.splice(0)) await f.close()
  await waitPhysicalIdle()
})
async function active(
  f: Awaited<ReturnType<typeof fixture>>,
  overrides?: Partial<PiAdapterOptions>,
) {
  const { handle } = await f.start(overrides)
  const receipt = handle.prompt('hello')
  await receipt.acceptance
  await f.control({ events: [{ type: 'agent_start' }] })
  await f.wait(
    () => f.events.some((event) => event.type === 'run_started') || false,
  )
  return { handle, receipt }
}
describe('Pi raw process contract', () => {
  it('E1, 33: failed queued-image admission creates no durable ordinal or physical charge', async () => {
    const f = await peer({ behavior: 'manual' })
    const { handle, receipt } = await active(f)
    await f.control({
      events: [
        {
          type: 'message_end',
          message: {
            role: 'custom',
            customType: 'first',
            content: '',
            display: false,
            timestamp: 0,
          },
        },
      ],
    })
    await f.wait(() => f.records.length === 1 || false)
    const releases = [reservePhysical('image'), reservePhysical('image')]
    try {
      await f.control({
        events: [
          {
            type: 'message_end',
            message: {
              role: 'user',
              timestamp: 0,
              content: [
                {
                  type: 'image',
                  mimeType: 'image/png',
                  data: png.toString('base64'),
                },
              ],
            },
          },
        ],
      })
      expect(await receipt.completion).toMatchObject({
        status: 'failed',
        code: 'PI_PHYSICAL_WORK_CAPACITY',
      })
      await handle.kill()
      expect(f.records.map((r) => r.source.ordinal)).toEqual([1])
      expect(f.images).toEqual([])
      expect(physicalState().classes.image).toBe(2)
      expect(physicalState().bytes).toBe(130 * MiB)
    } finally {
      releases.forEach((release) => release())
      await waitPhysicalIdle()
    }
  })
  it.each([false, true])(
    'Q1, 15: native agent_end willRetry=%s never settles alone',
    async (willRetry) => {
      const f = await peer({ behavior: 'manual' })
      const { receipt } = await active(f)
      await f.control({
        state: { isStreaming: false },
        events: [
          { type: 'message_end', message: assistant() },
          { type: 'agent_end', messages: [assistant()], willRetry },
        ],
      })
      expect(await pending(receipt.completion)).toBe(true)
      await f.control({ events: [{ type: 'agent_settled' }] })
      expect(await receipt.completion).toMatchObject({ status: 'completed' })
      expect(f.events.filter((e) => e.type === 'turn_completed')).toHaveLength(
        1,
      )
    },
  )
  it.each(['success', 'exhausted', 'cancelled'] as const)(
    'Q2, Q3, 15, 41: repeated source-shaped retries end in %s',
    async (outcome) => {
      const f = await peer({ behavior: 'manual' })
      const { handle, receipt } = await active(f)
      for (let attempt = 1; attempt <= 2; attempt++) {
        await f.control({
          events: [
            { type: 'message_end', message: assistant([], 'error') },
            { type: 'agent_end', messages: [], willRetry: true },
            {
              type: 'auto_retry_start',
              attempt,
              maxAttempts: 2,
              delayMs: 0,
              errorMessage: 'Retryable fixture error',
            },
            ...(outcome === 'cancelled' && attempt === 2
              ? []
              : [{ type: 'agent_start' }]),
          ],
        })
        expect(await pending(receipt.completion)).toBe(true)
      }
      if (outcome === 'cancelled') {
        await f.control({
          state: { isStreaming: false },
          events: [
            {
              type: 'auto_retry_end',
              success: false,
              attempt: 2,
              finalError: 'Retry cancelled',
            },
          ],
        })
        await handle.cancel()
      } else {
        const final = assistant([], outcome === 'success' ? 'stop' : 'error')
        await f.control({
          state: { isStreaming: false },
          events: [
            { type: 'message_end', message: final },
            ...(outcome === 'success'
              ? [{ type: 'auto_retry_end', success: true, attempt: 2 }]
              : []),
            { type: 'agent_end', messages: [final], willRetry: false },
            ...(outcome === 'exhausted'
              ? [
                  {
                    type: 'auto_retry_end',
                    success: false,
                    attempt: 2,
                    finalError: 'Retry exhausted',
                  },
                ]
              : []),
            { type: 'compaction_start', reason: 'threshold' },
            {
              type: 'compaction_end',
              reason: 'threshold',
              aborted: false,
              willRetry: false,
              errorMessage: 'Synthetic compaction failure',
            },
            { type: 'agent_settled' },
          ],
        })
      }
      expect(await receipt.completion).toMatchObject({
        status:
          outcome === 'success'
            ? 'completed'
            : outcome === 'exhausted'
              ? 'failed'
              : 'interrupted',
      })
      expect(f.events.filter((e) => e.type === 'run_started')).toHaveLength(1)
      expect(f.events.filter((e) => e.type === 'turn_completed')).toHaveLength(
        1,
      )
      expect(
        f.events.filter(
          (e) => e.type === 'diagnostic' && e.code === 'PI_AUTO_RETRY',
        ),
      ).toHaveLength(2)
    },
  )
  it.each([true, false])(
    'Q3, 15: omitted compaction result retains aborted=%s',
    async (aborted) => {
      const f = await peer({ behavior: 'manual' })
      const { receipt } = await active(f)
      await f.control({
        state: { isStreaming: false },
        events: [
          { type: 'message_end', message: assistant() },
          { type: 'agent_end', messages: [], willRetry: false },
          { type: 'compaction_start', reason: 'threshold' },
          {
            type: 'compaction_end',
            reason: 'threshold',
            aborted,
            willRetry: false,
            ...(aborted
              ? {}
              : { errorMessage: 'Synthetic compaction failure' }),
          },
          { type: 'agent_settled' },
        ],
      })
      expect(await receipt.completion).toMatchObject({ status: 'completed' })
      expect(
        f.records.some(
          (r) =>
            r.body.type === 'custom' &&
            r.body.customType === 'forge.pi.progress',
        ),
      ).toBe(true)
    },
  )
  it.each(['message', 'question', 'open-message'] as const)(
    'Q4, 54: settlement drains a later owned %s after the captured ordinal commits',
    async (kind) => {
      const f = await peer({ behavior: 'manual' })
      const firstHeld = latch(),
        secondHeld = latch(),
        firstEntered = latch(),
        secondEntered = latch(),
        barrier = latch()
      let states = 0
      const { handle } = await f.start({
        persistRecord: async (...args) => {
          if (args[2].source.ordinal === 1) {
            firstEntered.resolve()
            await firstHeld.promise
          }
          if (args[2].source.ordinal === 2) {
            secondEntered.resolve()
            await secondHeld.promise
          }
          await f.options.persistRecord(...args)
        },
        persistSnapshot: async (...args) => {
          if (args[1].kind === 'state' && ++states === 3) barrier.resolve()
          await f.options.persistSnapshot(...args)
        },
      })
      const receipt = handle.prompt('Drain every owned record')
      try {
        await receipt.acceptance
        await f.control({ events: [{ type: 'agent_start' }] })
        await f.settle()
        await firstEntered.promise
        await barrier.promise
        await new Promise<void>((resolve) => setImmediate(resolve))
        const message = {
          role: 'custom',
          customType: 'late',
          content: 'Persist before completion',
          display: false,
          timestamp: 2,
        }
        await f.control({
          events:
            kind === 'open-message'
              ? [{ type: 'message_start', message }]
              : kind === 'message'
                ? [
                    { type: 'message_start', message },
                    { type: 'message_end', message },
                  ]
                : [
                    {
                      type: 'extension_ui_request',
                      id: 'late-question',
                      method: 'input',
                      title: 'Late question',
                    },
                  ],
        })
        firstHeld.resolve()
        if (kind === 'open-message') {
          expect(await receipt.completion).toMatchObject({
            status: 'failed',
            code: 'PI_INCOMPLETE_MESSAGE',
          })
          expect(f.records.map((record) => record.source.ordinal)).toEqual([1])
          return
        }
        await secondEntered.promise
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(f.records.map((r) => r.source.ordinal)).toEqual([1])
        expect(await pending(receipt.completion)).toBe(true)
        secondHeld.resolve()
        expect(await receipt.completion).toMatchObject({ status: 'completed' })
        expect(f.records.map((r) => r.source.ordinal)).toEqual(
          kind === 'message' ? [1, 2] : [1, 2, 3],
        )
      } finally {
        firstHeld.resolve()
        secondHeld.resolve()
      }
    },
  )
  it('E1, 33: queued images reserve capacity before entering the ordered drain', async () => {
    const f = await peer({ behavior: 'manual' })
    const entered = latch(),
      held = latch()
    const { handle } = await f.start({
      persistRecord: async (...args) => {
        if (args[2].source.ordinal === 1) {
          entered.resolve()
          await held.promise
        }
        await f.options.persistRecord(...args)
      },
    })
    const receipt = handle.prompt('Held record')
    try {
      await receipt.acceptance
      await f.control({
        events: [
          { type: 'agent_start' },
          {
            type: 'message_end',
            message: {
              role: 'custom',
              customType: 'held',
              content: '',
              display: false,
              timestamp: 0,
            },
          },
        ],
      })
      await entered.promise
      const data = Buffer.alloc(2 * MiB)
      png.copy(data)
      await f.control({
        events: [
          {
            type: 'message_end',
            message: {
              role: 'user',
              content: [
                {
                  type: 'image',
                  mimeType: 'image/png',
                  data: data.toString('base64'),
                },
              ],
              timestamp: 1,
            },
          },
          { type: 'message_start', message: assistant() },
          {
            type: 'message_update',
            assistantMessageEvent: {
              type: 'text_delta',
              contentIndex: 0,
              delta: 'queued-image-observed',
            },
          },
        ],
      })
      await f.wait(() => f.events.some((e) => e.type === 'text_delta') || false)
      expect(physicalState().classes.image).toBe(1)
      expect(physicalState().bytes).toBeGreaterThanOrEqual(65 * MiB)
      expect(f.images).toHaveLength(0)
      const releaseOther = reservePhysical('image')
      try {
        expect(() => reservePhysical('image')).toThrow(
          'PI_PHYSICAL_WORK_CAPACITY',
        )
      } finally {
        releaseOther()
      }
      held.resolve()
      await f.settle()
      expect(await receipt.completion).toMatchObject({ status: 'completed' })
      expect(f.records.map((r) => r.source.ordinal)).toEqual([1, 2, 3])
    } finally {
      held.resolve()
      await handle.kill()
    }
  })
  it('E5, 22: a silent automatic epoch expires and closes its actual process', async () => {
    const f = await peer({ behavior: 'manual' })
    const { handle } = await f.start({ limits: { operationMs: 40 } })
    const { pid } = await f.started()
    await f.control({
      state: { isStreaming: true },
      events: [{ type: 'agent_start' }],
    })
    const event = await f.wait(
      () => f.events.find((e) => e.type === 'turn_completed') ?? false,
    )
    expect(event).toMatchObject({
      outcome: { status: 'failed', code: 'PI_OPERATION_DEADLINE' },
    })
    await handle.kill()
    await expect(readFile(`/proc/${pid}/stat`)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(f.events.filter((e) => e.type === 'turn_completed')).toHaveLength(1)
  })
  it('E4, Q7, 45: paused stdin cannot extend cancellation to the command deadline', async () => {
    const f = await peer({ behavior: 'manual', pauseInput: true })
    const data = Buffer.alloc(2 * MiB)
    png.copy(data)
    const written = latch()
    const { handle } = await f.start({
      limits: { commandMs: 1500 },
      loadImage: imageLoader(data),
      persistRecord: async (...args) => {
        await f.options.persistRecord(...args)
        if (
          args[2].body.type === 'custom' &&
          args[2].body.customType === 'forge.pi.input'
        )
          written.resolve()
      },
    })
    const root = handle.prompt('Root')
    await root.acceptance
    await f.wait(async () => {
      try {
        await readFile(join(f.directory, 'stdin-paused'))
        return true
      } catch {
        return false
      }
    })
    await f.control({
      events: [
        { type: 'agent_start' },
        {
          type: 'extension_ui_request',
          id: 'paused-ui',
          method: 'input',
          title: 'Question',
        },
      ],
    })
    const queue = handle.followUp([
      { type: 'text', text: 'queued' },
      { type: 'attachment', attachmentId: 'owned', mime: 'image/png' },
    ])
    await written.promise
    expect(physicalState().classes.attachment).toBe(1)
    const start = performance.now()
    await Promise.resolve(handle.cancel()).catch((error) =>
      expect(error.code).toBe('PI_DEADLINE'),
    )
    expect(performance.now() - start).toBeLessThan(1000)
    expect(await root.completion).toMatchObject({ status: 'interrupted' })
    expect(await queue.completion).toMatchObject({ status: 'interrupted' })
    expect(f.events.filter((e) => e.type === 'request_cancelled')).toHaveLength(
      1,
    )
    expect(
      f.records
        .filter((r) => r.body.type === 'ui_request')
        .map((r) => r.body.type === 'ui_request' && r.body.status),
    ).toEqual(['pending', 'expired'])
    expect(physicalState().classes.attachment).toBe(0)
  })
  it('01, 03, 04: discovers and confirms a native binding without model access claims', async () => {
    const f = await peer({
      emptyModels: true,
      splitAt: 13,
      crlf: true,
      startupEffect: true,
    })
    const { handle } = await f.start()
    expect(handle.binding).toMatchObject({
      providerSessionId: 'native-session',
      cwd: f.cwd,
      accountId: 'pi-account',
    })
    expect(handle.binding?.sessionFile).toBe(
      join(f.home, 'sessions', 'native-session.jsonl'),
    )
    expect(handle.getCatalog().models).toEqual([])
    expect(f.events).toEqual([])
    expect((await f.wire()).map((command) => command.type)).toEqual([
      'get_state',
      'get_available_models',
      'get_available_thinking_levels',
      'get_commands',
      'get_state',
    ])
    const { args } = await f.started()
    expect(args).toContain('--offline')
    expect(args).toContain('--fixture-dir')
    expect(args).not.toContain('--no-extensions')
    expect(args).not.toContain('--approve')
    expect(
      await readFile(join(f.directory, 'unforwarded-startup-effect'), 'utf8'),
    ).toBe('hook ran')
  })
  it.each([
    { startupDialog: true },
    { startupHang: true },
    { startupExit: 0 },
    { startupRaw: Buffer.from('{broken}\n').toString('base64') },
    { startupRaw: Buffer.from([255, 10]).toString('base64') },
  ])(
    '02, 51: rejects broken startup and closes its owned process: %j',
    async (config) => {
      const f = await peer(config)
      await expect(f.start({ limits: { startupMs: 150 } })).rejects.toThrow()
      expect(f.events.some((event) => event.type === 'prompt_accepted')).toBe(
        false,
      )
      expect(
        (await f.wire()).some(
          (command) => command.type === 'extension_ui_response',
        ),
      ).toBe(false)
    },
  )
  it('02: rejects unsupported installed versions before launch', async () => {
    const f = await peer()
    await writeFile(
      join(f.directory, 'package', 'package.json'),
      JSON.stringify({
        name: '@earendil-works/pi-coding-agent',
        version: '99.0.0',
      }),
    )
    await expect(f.start()).rejects.toThrow('PI_VERSION_UNSUPPORTED')
    expect(await f.wire()).toEqual([])
  })
  it('13: rejects failed native preflight without a fabricated running turn', async () => {
    const f = await peer({ behavior: 'preflight' })
    const { handle } = await f.start()
    const receipt = handle.prompt('bad')
    expect(await receipt.acceptance).toMatchObject({ status: 'rejected' })
    expect(await receipt.completion).toMatchObject({
      status: 'failed',
      code: 'PI_NATIVE_PREFLIGHT_REJECTED',
    })
    expect(f.events.map((event) => event.type)).toEqual(['turn_completed'])
  })
  it('06, 53: native credential failure produces no Forge retry, installer, or credential repair', async () => {
    const f = await peer({
      behavior: 'preflight',
      envKeys: [
        'OPENAI_API_KEY',
        'MY_PI_KEY',
        'AWS_PROFILE',
        'GOOGLE_CLOUD_PROJECT',
      ],
    })
    const env = {
      OPENAI_API_KEY: 'fake-known',
      MY_PI_KEY: 'fake-custom',
      AWS_PROFILE: 'fake-aws',
      GOOGLE_CLOUD_PROJECT: 'fake-google',
    }
    const { handle } = await f.start({
      env,
      launch: { ...f.options.launch, selectedEnvOverrides: env },
    })
    const receipt = handle.prompt('native rejects its stored credential')
    expect(await receipt.completion).toMatchObject({
      status: 'failed',
      code: 'PI_NATIVE_PREFLIGHT_REJECTED',
    })
    expect(
      (await f.wire()).filter((command) => command.type === 'prompt'),
    ).toHaveLength(1)
    expect((await f.started()).env).toEqual(env)
    expect((await f.started()).args).toContain('--offline')
  })
  it('14, 29, 37, 42: completes a real raw stream once after authoritative replacement', async () => {
    const f = await peer()
    const { handle } = await f.start()
    const receipt = handle.prompt('hello')
    expect(await receipt.acceptance).toEqual({
      status: 'accepted',
      command: 'prompt',
    })
    expect(await receipt.completion).toMatchObject({ status: 'completed' })
    expect(await receipt.delivery).toEqual({
      status: 'agent_work_observed',
      scope: 'session_operation',
    })
    expect(
      f.events.filter((event) => event.type === 'turn_completed'),
    ).toHaveLength(1)
    expect(
      f.events.find(
        (event) =>
          event.type === 'content_snapshot' &&
          event.contentType === 'text' &&
          event.role !== 'user',
      ),
    ).toMatchObject({ text: 'done' })
    for (const event of f.events)
      expect(harnessEventSchema.safeParse(event).success).toBe(true)
    expect(new Set(f.events.map((event) => event.deliveryId)).size).toBe(
      f.events.length,
    )
    const timeline = foldTimeline(
      f.events.map((event, index) => ({
        kind: 'delta',
        cursor: index + 1,
        event,
      })),
    )
    expect(timeline.events).toEqual(f.events)
    expect(timeline.terminal).toBe('completed')
    expect(f.records.map((record) => record.source.ordinal)).toEqual([1, 2])
  })
  it('15, 21: unmatched nested starts poison admission before any newer operation', async () => {
    const f = await peer({ behavior: 'manual' })
    const { handle, receipt } = await active(f)
    await f.control({
      events: [
        { type: 'agent_end', messages: [], willRetry: false },
        { type: 'agent_start' },
        { type: 'agent_settled' },
      ],
    })
    expect(await receipt.completion).toMatchObject({
      status: 'failed',
      code: 'PI_ACTIVITY_OWNERSHIP_UNCERTAIN',
    })
    const newer = handle.prompt('C')
    expect(await newer.completion).toMatchObject({ status: 'failed' })
    expect(
      (await f.wire()).filter((command) => command.type === 'prompt'),
    ).toHaveLength(1)
  })
  it('21: inner and delayed outer settlements cannot complete a reentrant newer dispatch', async () => {
    const f = await peer({ behavior: 'manual' })
    let newer: ReturnType<import('./index.js').PiHandle['prompt']> | undefined
    const adapter = createPiAdapter(f.options)
    const handle = f.track(
      await adapter.spawn(f.session, (event) => {
        f.emit(event)
        if (
          event.type === 'turn_completed' &&
          event.outcome.status === 'failed'
        )
          newer = handle.prompt('C')
      }),
    )
    const receipt = handle.prompt('A')
    await receipt.acceptance
    await f.control({
      events: [
        { type: 'agent_start' },
        { type: 'agent_end', messages: [], willRetry: false },
        { type: 'agent_start' },
        { type: 'agent_settled' },
        { type: 'agent_settled' },
      ],
    })
    expect(await receipt.completion).toMatchObject({
      status: 'failed',
      code: 'PI_ACTIVITY_OWNERSHIP_UNCERTAIN',
    })
    expect(await newer!.completion).toMatchObject({
      status: 'failed',
      code: 'PI_ACTIVITY_OWNERSHIP_UNCERTAIN',
    })
    expect(
      (await f.wire()).filter((command) => command.type === 'prompt'),
    ).toHaveLength(1)
  })
  it('15: agent_end is insufficient and one retry permit allows the next native start', async () => {
    const f = await peer({ behavior: 'manual' })
    const { receipt } = await active(f)
    await f.control({
      events: [
        { type: 'message_end', message: assistant([], 'error') },
        { type: 'agent_end', messages: [], willRetry: true },
      ],
    })
    expect(await pending(receipt.completion)).toBe(true)
    await f.control({
      events: [
        {
          type: 'auto_retry_start',
          attempt: 1,
          maxAttempts: 2,
          delayMs: 0,
          errorMessage: 'Retry',
        },
        { type: 'agent_start' },
      ],
    })
    await f.control({
      state: { isStreaming: false },
      events: [
        { type: 'message_end', message: assistant() },
        { type: 'auto_retry_end', success: true, attempt: 1 },
        { type: 'agent_end', messages: [assistant()], willRetry: false },
        { type: 'agent_settled' },
      ],
    })
    expect(await receipt.completion).toMatchObject({ status: 'completed' })
    expect(
      f.events.filter((event) => event.type === 'run_started'),
    ).toHaveLength(1)
  })
  it('15: compaction without restart waits for actual settlement', async () => {
    const f = await peer({ behavior: 'manual' })
    const { receipt } = await active(f)
    await f.control({
      events: [
        { type: 'message_end', message: assistant() },
        { type: 'agent_end', messages: [], willRetry: false },
        { type: 'compaction_start', reason: 'threshold' },
        {
          type: 'compaction_end',
          reason: 'threshold',
          aborted: false,
          willRetry: false,
          errorMessage: 'Synthetic compaction failure',
        },
      ],
    })
    expect(await pending(receipt.completion)).toBe(true)
    await f.control({
      state: { isStreaming: false },
      events: [{ type: 'agent_settled' }],
    })
    expect(await receipt.completion).toMatchObject({ status: 'completed' })
  })
  it('16: holds native settlement until the delayed prompt acknowledgement', async () => {
    const f = await peer({ lateAck: true })
    const { handle } = await f.start()
    const receipt = handle.prompt('late')
    await f.wait(
      () => f.events.some((event) => event.type === 'usage') || false,
    )
    expect(await pending(receipt.completion)).toBe(true)
    await f.control({ release: 'prompt' })
    expect(await receipt.completion).toMatchObject({ status: 'completed' })
  })
  it('17: busy state prevents extension-only completion before delayed native start', async () => {
    const f = await peer({ behavior: 'manual' })
    const { handle } = await f.start()
    const receipt = handle.prompt('delayed')
    await receipt.acceptance
    await f.wait(
      async () =>
        (await f.wire()).filter((command) => command.type === 'get_state')
          .length >= 3 || false,
    )
    expect(await pending(receipt.completion)).toBe(true)
    await f.control({ events: [{ type: 'agent_start' }] })
    await f.settle()
    expect(await receipt.completion).toMatchObject({ status: 'completed' })
  })
  it.each([
    ['handled', '/handled'],
    ['handled', 'ordinary input'],
    ['extension-error', '/handled'],
    ['extension-error', 'ordinary input'],
  ])(
    '18, 19, 20: handles extension-only input truthfully: %s %s',
    async (behavior, message) => {
      const f = await peer({ behavior })
      const { handle } = await f.start()
      const receipt = handle.prompt(message)
      expect(await receipt.acceptance).toMatchObject({ status: 'accepted' })
      expect(await receipt.completion).toMatchObject({
        status: behavior === 'handled' ? 'completed' : 'failed',
      })
      expect(await receipt.delivery).toEqual({
        status: 'handled_without_agent',
        scope: 'command',
      })
      expect(f.events.some((event) => event.type === 'run_started')).toBe(false)
    },
  )
  it('22: automatic work receives a new actual root', async () => {
    const f = await peer({ behavior: 'handled' })
    const { handle } = await f.start()
    const receipt = handle.prompt('handled')
    await receipt.completion
    await f.control({
      state: { isStreaming: true },
      events: [{ type: 'agent_start' }],
    })
    await f.settle()
    const automatic = await f.wait(
      () => f.events.find((event) => event.type === 'run_started') ?? false,
    )
    expect(automatic.runId).not.toBe(receipt.runId)
  })
  it.each(['steer', 'followUp'] as const)(
    '23, 24, 25: uses native %s with unconfirmed queued delivery',
    async (method) => {
      const f = await peer({ behavior: 'manual' })
      const { handle, receipt } = await active(f)
      const queued = handle[method]('same text')
      expect(await queued.acceptance).toMatchObject({
        status: 'accepted',
        command: method === 'steer' ? 'steer' : 'follow_up',
      })
      const rejected = handle[method]('another')
      expect(await rejected.acceptance).toMatchObject({ status: 'rejected' })
      await f.settle()
      expect(await receipt.completion).toMatchObject({ status: 'completed' })
      expect(await queued.completion).toMatchObject({ status: 'completed' })
      expect(await queued.delivery).toMatchObject({ status: 'unconfirmed' })
      expect(
        (await f.wire()).filter(
          (command) =>
            command.type === (method === 'steer' ? 'steer' : 'follow_up'),
        ),
      ).toHaveLength(1)
    },
  )
  it('26: queue residue reports accounting uncertainty', async () => {
    const f = await peer({ behavior: 'manual' })
    const { handle, receipt } = await active(f)
    const queued = handle.followUp('input')
    await queued.acceptance
    await f.control({
      state: { isStreaming: false, pendingMessageCount: 1 },
      events: [
        { type: 'queue_update', steering: [], followUp: [''] },
        { type: 'message_end', message: assistant() },
        { type: 'agent_end', messages: [], willRetry: false },
        { type: 'agent_settled' },
      ],
    })
    expect(await receipt.completion).toMatchObject({
      status: 'failed',
      code: 'PI_QUEUE_ACCOUNTING_UNCERTAIN',
    })
    expect(await queued.delivery).toMatchObject({ status: 'unconfirmed' })
  })
  it('27, 28: reserves admission before getters and snapshots caller values', async () => {
    const f = await peer()
    const { handle } = await f.start()
    let reentered: ReturnType<typeof handle.prompt> | undefined
    const input = [
      {
        type: 'text' as const,
        get text() {
          reentered = handle.prompt('nested')
          return 'original'
        },
      },
    ]
    const identity = { runId: 'original-run', turnId: 'original-turn' }
    const receipt = handle.prompt(input, { permissionMode: 'manual' }, identity)
    identity.runId = 'mutated'
    expect(await reentered!.acceptance).toMatchObject({ status: 'rejected' })
    expect(await receipt.completion).toMatchObject({
      status: 'completed',
      runId: 'original-run',
    })
    expect(
      (await f.wire()).find((command) => command.type === 'prompt'),
    ).toMatchObject({ message: 'original' })
  })
  it.each(['cancel', 'setter'] as const)(
    '27: option getter reentry through %s cannot submit an unintended prompt',
    async (action) => {
      const f = await peer({ behavior: 'handled' })
      const { handle } = await f.start()
      let reentry: Promise<unknown> | undefined
      const receipt = handle.prompt(
        'original',
        {
          get permissionMode() {
            reentry = Promise.resolve(
              action === 'cancel'
                ? handle.cancel()
                : handle.setConfigOption!('thinking', 'high'),
            )
            void reentry.catch(() => {})
            return 'manual' as const
          },
        },
        { runId: 'captured-run', turnId: 'captured-turn' },
      )
      if (action === 'cancel') {
        await reentry
        expect(await receipt.completion).toMatchObject({
          status: 'interrupted',
          runId: 'captured-run',
        })
        expect((await f.wire()).some((frame) => frame.type === 'prompt')).toBe(
          false,
        )
      } else {
        await expect(reentry).rejects.toThrow('PI_CONFIGURATION_BUSY')
        expect(await receipt.completion).toMatchObject({
          status: 'completed',
          runId: 'captured-run',
        })
        expect(
          (await f.wire()).some((frame) => frame.type === 'set_thinking_level'),
        ).toBe(false)
      }
    },
  )
  it.each(['retry', 'compaction', 'preflight-ui'] as const)(
    '45, 46: cancellation during %s closes the owned generation exactly once',
    async (phase) => {
      const f = await peer({ behavior: 'manual' })
      const { handle, receipt } = await active(f)
      await f.control({
        events:
          phase === 'retry'
            ? [
                { type: 'message_end', message: assistant([], 'error') },
                { type: 'agent_end', messages: [], willRetry: true },
                {
                  type: 'auto_retry_start',
                  attempt: 1,
                  maxAttempts: 2,
                  delayMs: 1,
                  errorMessage: 'synthetic',
                },
              ]
            : phase === 'compaction'
              ? [{ type: 'compaction_start', reason: 'manual' }]
              : [
                  {
                    type: 'extension_ui_request',
                    id: 'cancel-ui',
                    method: 'input',
                    title: 'Input',
                  },
                ],
      })
      await handle.cancel()
      expect(await receipt.completion).toMatchObject({ status: 'interrupted' })
      expect(
        f.events.filter(
          (event) =>
            event.type === 'turn_completed' && event.runId === receipt.runId,
        ),
      ).toHaveLength(1)
      expect(
        (await f.wire()).filter((frame) => frame.type === 'abort'),
      ).toHaveLength(1)
      expect(await handle.prompt('later').delivery).toMatchObject({
        status: 'not_sent',
      })
    },
  )
  it.each(['error', 'aborted', 'length', 'deferred', 'pending', 'toolUse'])(
    '41: retains terminal outcome %s',
    async (stopReason) => {
      const f = await peer({ behavior: 'manual' })
      const { receipt } = await active(f)
      await f.settle(stopReason)
      expect(await receipt.completion).toMatchObject({
        status:
          stopReason === 'length'
            ? 'completed'
            : stopReason === 'aborted'
              ? 'interrupted'
              : 'failed',
      })
    },
  )
  it('43: applies confirmed options, supports off and resets to startup baseline', async () => {
    const f = await peer({ behavior: 'handled' })
    const { handle } = await f.start()
    const first = handle.prompt('one', {
      permissionMode: 'manual',
      model: '["fake","model/two"]',
      reasoning: 'high',
    })
    expect(await first.completion).toMatchObject({ status: 'completed' })
    const second = handle.prompt('two', {
      permissionMode: 'manual',
      model: null,
      reasoning: null,
    })
    expect(await second.completion).toMatchObject({ status: 'completed' })
    expect(
      handle.configOptions!().find((option) => option.id === 'thinking')
        ?.currentValue,
    ).toBe('off')
    expect(
      (await f.wire()).filter((command) => command.type === 'set_model'),
    ).toHaveLength(2)
  })
  it('44: a lost response remains unknown and sends no retry', async () => {
    const f = await peer({ hold: ['prompt'] })
    const { handle } = await f.start({ limits: { commandMs: 100 } })
    const receipt = handle.prompt('lost')
    expect(await receipt.acceptance).toMatchObject({ status: 'unknown' })
    expect(await receipt.completion).toMatchObject({ status: 'failed' })
    expect(
      (await f.wire()).filter((command) => command.type === 'prompt'),
    ).toHaveLength(1)
  })
  it.each(['clamp', 'reject', 'no-baseline'] as const)(
    '43: rejects %s settings before prompt submission',
    async (kind) => {
      const f = await peer({
        behavior: 'handled',
        clamp: kind === 'clamp',
        reject: kind === 'reject' ? ['set_thinking_level'] : [],
        noModel: kind === 'no-baseline',
      })
      const { handle } = await f.start()
      const receipt = handle.prompt('settings', {
        permissionMode: 'manual',
        ...(kind === 'no-baseline' ? { model: null } : { reasoning: 'high' }),
      })
      expect(await receipt.completion).toMatchObject({ status: 'failed' })
      expect(await receipt.delivery).toMatchObject({ status: 'not_sent' })
      expect(
        (await f.wire()).some((command) => command.type === 'prompt'),
      ).toBe(false)
    },
  )
  it('24, 43: active setters, changed queue options and compacting queues reject before image loading', async () => {
    const f = await peer({ behavior: 'manual' })
    let loads = 0
    const { handle } = await active(f, {
      loadImage: async () => {
        loads++
        throw new Error('Unexpected loader')
      },
    })
    await expect(handle.setConfigOption!('thinking', 'high')).rejects.toThrow(
      'PI_CONFIGURATION_BUSY',
    )
    const input = [
      { type: 'text' as const, text: 'queued' },
      { type: 'attachment' as const, attachmentId: 'owned', mime: 'image/png' },
    ]
    const changed = handle.steer(input, {
      permissionMode: 'manual',
      reasoning: 'high',
    })
    expect(await changed.acceptance).toMatchObject({
      status: 'rejected',
      code: 'PI_QUEUE_CONFIGURATION_CHANGED',
    })
    await f.control({
      events: [{ type: 'compaction_start', reason: 'manual' }],
    })
    const compacting = handle.followUp(input)
    expect(await compacting.acceptance).toMatchObject({ status: 'rejected' })
    expect(loads).toBe(0)
    await handle.cancel()
  })
  it.each(['set_thinking_level', 'follow_up'] as const)(
    '44: lost %s reply remains uncertain with exactly one write',
    async (command) => {
      const f = await peer({ behavior: 'manual', hold: [command] })
      const { handle } = await f.start({ limits: { commandMs: 200 } })
      const root = handle.prompt('root', {
        permissionMode: 'manual',
        ...(command === 'set_thinking_level' ? { reasoning: 'high' } : {}),
      })
      let queued: ReturnType<typeof handle.followUp> | undefined
      if (command === 'follow_up') {
        await root.acceptance
        await f.control({ events: [{ type: 'agent_start' }] })
        await f.wait(
          () => f.events.some((event) => event.type === 'run_started') || false,
        )
        queued = handle.followUp('queued')
      }
      expect(await root.completion).toMatchObject({
        status: 'failed',
        code: 'PI_COMMAND_DELIVERY_UNKNOWN',
      })
      if (queued)
        expect(await queued.acceptance).toMatchObject({ status: 'unknown' })
      expect(
        (await f.wire()).filter((frame) => frame.type === command),
      ).toHaveLength(1)
    },
  )
  it('45, 46: cancellation wins over abort acknowledgement and later process death', async () => {
    const f = await peer({ behavior: 'manual' })
    const { handle, receipt } = await active(f)
    await handle.cancel()
    expect(await receipt.completion).toMatchObject({ status: 'interrupted' })
    expect(
      (await f.wire()).filter((command) => command.type === 'abort'),
    ).toHaveLength(1)
    expect(
      f.events.filter((event) => event.type === 'turn_completed'),
    ).toHaveLength(1)
    expect(handle.binding).not.toBeNull()
  })
  it('46: exit code zero never proves completion', async () => {
    const f = await peer({ behavior: 'manual' })
    const { receipt } = await active(f)
    await f.control({ exit: 0 })
    expect(await receipt.completion).toMatchObject({ status: 'failed' })
  })
  it('47: owned descendants that ignore SIGTERM cannot retain the native process group', async () => {
    const f = await peer({ descendant: true, ignoreTerm: true })
    const { handle } = await f.start()
    const descendant = Number(
      await readFile(join(f.directory, 'descendant'), 'utf8'),
    )
    await handle.kill()
    try {
      const status = await readFile(`/proc/${descendant}/stat`, 'utf8')
      expect(status.slice(status.lastIndexOf(')') + 2).split(' ')[0]).toBe('Z')
    } catch (error) {
      expect((error as { code?: string }).code).toBe('ENOENT')
    }
  })
  it('50: fast sinks cannot refund publication count', async () => {
    const f = await peer({ behavior: 'manual' })
    const { receipt } = await active(f, {
      limits: { operationPublications: 8 },
    })
    await f.control({
      events: [
        { type: 'message_start', message: assistant([], 'pending') },
        ...Array.from({ length: 20 }, () => ({
          type: 'message_update',
          assistantMessageEvent: {
            type: 'text_delta',
            contentIndex: 0,
            delta: '',
          },
        })),
      ],
    })
    expect(await receipt.completion).toMatchObject({
      status: 'failed',
      code: 'PI_PUBLICATION_LIMIT',
    })
  })
  it.each([
    'maxItems',
    'maxTools',
    'maxContentBytes',
    'maxBlockBytes',
    'maxRecordBytes',
  ] as const)(
    '50: enforces the retained %s ceiling on actual native records',
    async (key) => {
      const f = await peer({ behavior: 'manual' })
      const { receipt } = await active(f, {
        limits: { [key]: key === 'maxRecordBytes' ? 256 : 1 },
      })
      const events =
        key === 'maxTools'
          ? [
              {
                type: 'tool_execution_start',
                toolCallId: 'one',
                toolName: 'test',
                args: {},
              },
              {
                type: 'tool_execution_start',
                toolCallId: 'two',
                toolName: 'test',
                args: {},
              },
            ]
          : key === 'maxRecordBytes'
            ? [
                {
                  type: 'message_end',
                  message: {
                    role: 'custom',
                    customType: 'test',
                    display: false,
                    content: 'x'.repeat(300),
                    timestamp: 1,
                  },
                },
              ]
            : [
                {
                  type: 'message_end',
                  message: assistant([
                    { type: 'text', text: 'first' },
                    { type: 'thinking', thinking: 'second' },
                  ]),
                },
              ]
      await f.control({ events })
      expect(await receipt.completion).toMatchObject({
        status: 'failed',
        code:
          key === 'maxTools'
            ? 'PI_TOOL_LIMIT'
            : key === 'maxItems'
              ? 'PI_ITEM_LIMIT'
              : key === 'maxRecordBytes'
                ? 'PI_RECORD_QUEUE_LIMIT'
                : 'PI_CONTENT_LIMIT',
      })
    },
  )
  it('50: command and receipt tombstones remain bounded across completed roots', async () => {
    for (const limits of [{ maxCommands: 5 }, { maxReceipts: 1 }]) {
      const f = await peer({ behavior: 'handled' })
      const { handle } = await f.start({ limits })
      if ('maxReceipts' in limits) await handle.prompt('first').completion
      const receipt = handle.prompt('capacity')
      expect(await receipt.completion).toMatchObject({
        status: 'failed',
        code:
          'maxCommands' in limits ? 'PI_CONTROL_CAPACITY' : 'PI_RECEIPT_LIMIT',
      })
    }
  })
  it.each(['idle', 'generation'] as const)(
    '50: repeated unchanged state snapshots consume %s lifetime capacity',
    async (kind) => {
      const f = await peer()
      const { handle } = await f.start({
        limits:
          kind === 'idle'
            ? { idlePublications: 3 }
            : { generationPublications: 3 },
      })
      await handle.getState()
      await expect(handle.getState()).rejects.toThrow('PI_PUBLICATION_LIMIT')
    },
  )
  it('50: repeated same-item replacements consume publication bytes with fast sinks', async () => {
    const f = await peer({ behavior: 'manual' })
    const { receipt } = await active(f, {
      limits: { operationPublicationBytes: 4096 },
    })
    await f.control({
      events: [
        { type: 'message_start', message: assistant([], 'pending') },
        ...Array.from({ length: 12 }, (_, index) => ({
          type: 'message_update',
          assistantMessageEvent: {
            type: 'text_end',
            contentIndex: 0,
            content: String(index % 2).repeat(600),
          },
        })),
      ],
    })
    expect(await receipt.completion).toMatchObject({
      status: 'failed',
      code: 'PI_PUBLICATION_LIMIT',
    })
  })
  it('21: the retry permit cannot authorize an overlapping or extra restart', async () => {
    const f = await peer({ behavior: 'manual' })
    const { receipt, handle } = await active(f)
    await f.control({
      events: [
        { type: 'message_end', message: assistant([], 'error') },
        { type: 'agent_end', messages: [], willRetry: true },
        {
          type: 'auto_retry_start',
          attempt: 1,
          maxAttempts: 2,
          delayMs: 0,
          errorMessage: 'retry',
        },
        { type: 'agent_start' },
        { type: 'agent_end', messages: [], willRetry: false },
        { type: 'agent_start' },
        { type: 'agent_settled' },
      ],
    })
    expect(await receipt.completion).toMatchObject({
      status: 'failed',
      code: 'PI_ACTIVITY_OWNERSHIP_UNCERTAIN',
    })
    expect(await handle.prompt('newer').acceptance).toMatchObject({
      status: 'rejected',
    })
  })
  it('33, 54: blocked record sinks retain shared capacity across cancelled factories', async () => {
    const held = latch()
    let callbacks = 0
    const handles = []
    try {
      for (let index = 0; index < 2; index++) {
        const entered = latch()
        const f = await peer()
        const { handle } = await f.start({
          persistRecord: async () => {
            callbacks++
            entered.resolve()
            await held.promise
          },
        })
        handles.push(handle)
        const receipt = handle.prompt('sink')
        await entered.promise
        await handle.kill()
        expect(await receipt.completion).toMatchObject({ status: 'failed' })
      }
      const f = await peer()
      let snapshots = 0
      await expect(
        f.start({
          persistSnapshot: async () => {
            snapshots++
          },
        }),
      ).rejects.toThrow('PI_PHYSICAL_WORK_CAPACITY')
      expect(snapshots).toBe(0)
      expect(callbacks).toBe(2)
    } finally {
      held.resolve()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  })
  it('54: settlement waits for the final contiguous native record commit', async () => {
    const f = await peer()
    const held = latch()
    const entered = latch()
    const { handle } = await f.start({
      persistRecord: async (owner, binding, record, signal) => {
        if (record.source.ordinal === 2) {
          entered.resolve()
          await held.promise
        }
        await f.options.persistRecord(owner, binding, record, signal)
      },
    })
    const receipt = handle.prompt('hello')
    await entered.promise
    expect(await pending(receipt.completion)).toBe(true)
    held.resolve()
    expect(await receipt.completion).toMatchObject({ status: 'completed' })
    expect(f.records.map((record) => record.source.ordinal)).toEqual([1, 2])
  })
  it('54: record persistence failure prevents successful settlement', async () => {
    const f = await peer()
    const { handle } = await f.start({
      persistRecord: async () => {
        throw new Error('storage failed')
      },
    })
    const receipt = handle.prompt('hello')
    expect(await receipt.completion).toMatchObject({ status: 'failed' })
    expect(await readFile(handle.binding!.sessionFile, 'utf8')).toContain(
      'native-session',
    )
  })
  it('52: requires concrete persistence functions before construction', async () => {
    const f = await peer()
    expect(() =>
      createPiAdapter({
        ...f.options,
        persistRecord: undefined,
      } as unknown as PiAdapterOptions),
    ).toThrow('PI_PERSISTENCE_REQUIRED')
  })
})
