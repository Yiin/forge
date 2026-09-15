import { describe, expect, test } from 'vitest'
import type { HarnessEvent, HarnessHandle } from '../types.js'
import { deferred } from '../transport-test-helpers.js'
import { createTypedAcpAdapter } from './runtime.js'
import { sdkFixture as fixture } from './sdk-test-helpers.js'
describe('installed SDK through the typed ACP runtime', () => {
  test('completes an SDK prompt only after its original terminal journal commit', async () => {
    const entered = deferred<void>(),
      held = deferred<void>()
    const f = await fixture('normal', async (transaction) => {
      if (
        transaction.records.some(
          (record) =>
            record.value.kind === 'event' &&
            record.value.event.type === 'turn_completed',
        )
      ) {
        entered.resolve()
        await held.promise
      }
    })
    let handle: HarnessHandle | undefined
    try {
      handle = await createTypedAcpAdapter(f.deps).spawn(f.session, (event) =>
        f.events.push(event),
      )
      const receipt = await handle.prompt('SDK prompt', undefined, {
        runId: 'sdk-root',
        turnId: 'sdk-turn',
      })
      let completed = false
      void receipt.completion.then(() => {
        completed = true
      })
      await entered.promise
      expect(completed).toBe(false)
      held.resolve()
      expect(await receipt.completion).toEqual({
        status: 'completed',
        runId: 'sdk-root',
        turnId: 'sdk-turn',
      })
      expect(
        f.events.filter((event) => event.type === 'text_delta'),
      ).toMatchObject([{ text: 'Hello from SDK.' }])
      expect(
        (await f.frames()).filter((frame) => frame.method === 'session/prompt'),
      ).toHaveLength(1)
      expect(f.failures).toEqual([])
    } finally {
      held.resolve()
      await f.cleanup(handle)
    }
  }, 15000)
  test('loads all 70 SDK replay records before returning the confirmed handle', async () => {
    const f = await fixture('resume-replay')
    let handle: HarnessHandle | undefined
    try {
      const binding = {
        provider: 'instance',
        accountId: null,
        cwd: f.session.cwd,
        providerSessionId: 'sdk-resume',
      }
      handle = await createTypedAcpAdapter(f.deps).load!(
        { ...f.session, binding },
        (event) => f.events.push(event),
      )
      expect(handle.binding).toEqual(binding)
      const records = f.transactions.flatMap(
        (transaction) => transaction.records,
      )
      const replay = records.filter((record) => record.value.kind === 'replay')
      expect(replay).toHaveLength(70)
      expect(
        replay.map((record) =>
          record.value.kind === 'replay' &&
          record.value.event.type === 'text_delta'
            ? record.value.event.text
            : null,
        ),
      ).toEqual(Array.from({ length: 70 }, (_, i) => `History ${i}.`))
      expect(
        records.some(
          (record) =>
            record.value.kind === 'disposition' &&
            record.value.status === 'replay_visible',
        ),
      ).toBe(true)
      expect(
        (await f.frames()).some((frame) => frame.method === 'session/new'),
      ).toBe(false)
      expect(
        (await (await handle.prompt('after replay')).completion).status,
      ).toBe('completed')
      expect(f.failures).toEqual([])
    } finally {
      await f.cleanup(handle)
    }
  }, 15000)
  test.each(['allow', 'cancel'] as const)(
    'handles SDK permission with explicit %s',
    async (mode) => {
      const f = await fixture('permission')
      const requested =
        deferred<Extract<HarnessEvent, { type: 'permission_requested' }>>()
      let handle: HarnessHandle | undefined
      try {
        handle = await createTypedAcpAdapter(f.deps).spawn(
          f.session,
          (event) => {
            f.events.push(event)
            if (event.type === 'permission_requested') requested.resolve(event)
          },
        )
        const receipt = await handle.prompt('SDK permission')
        const event = await requested.promise
        if (mode === 'allow')
          await handle.replyPermission!({
            type: 'selected',
            requestId: event.request.requestId,
            optionId: 'allow-once',
          })
        else await handle.cancel()
        expect((await receipt.completion).status).toBe(
          mode === 'allow' ? 'completed' : 'interrupted',
        )
        if (mode === 'cancel')
          expect(
            f.events.filter((value) => value.type === 'text_delta'),
          ).toHaveLength(0)
        else
          expect(
            f.events.some(
              (value) =>
                value.type === 'text_delta' && value.text === 'Hello from SDK.',
            ),
          ).toBe(true)
        const frames = await f.frames()
        expect(
          frames.filter((frame) => frame.method === 'session/prompt'),
        ).toHaveLength(1)
        if (mode === 'allow')
          expect(
            frames.filter(
              (frame) => frame.result?.outcome?.optionId === 'allow-once',
            ),
          ).toHaveLength(1)
      } finally {
        await f.cleanup(handle)
      }
    },
    15000,
  )
})
