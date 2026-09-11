import { afterEach, describe, expect, it, vi } from 'vitest'
import { deferred, expectStopped } from '../transport-test-helpers.js'
import {
  peer,
  turn,
  turnFrame,
  itemFrame,
  eventually,
  methods,
} from './test-helpers.js'

afterEach(() => vi.restoreAllMocks())
// Keep real timers and child IO. Only native 30-second deadlines become shorter.
function shortNativeDeadlines() {
  const original = globalThis.setTimeout
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    callback: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) =>
    original(
      callback,
      ms && ms >= 29000 && ms <= 30000 ? 50 : ms,
      ...args,
    )) as typeof setTimeout)
}
const attachment = [
  { type: 'attachment' as const, attachmentId: 'upload', mime: 'image/png' },
]
const file = {
  mime: 'image/png',
  name: 'fixture',
  path: '/missing-fixture-file',
  sizeBytes: 0,
}

describe('Codex delivery ownership and retirement', () => {
  it('2: split multibyte CRLF, combined frames, and an unterminated final frame use the native transport', async () => {
    const p = await peer([{ method: 'turn/start', result: { turn: turn() } }])
    const h = await p.start()
    const receipt = await h.prompt('input')
    const bytes = Buffer.from(
      JSON.stringify(
        itemFrame({ id: 'text', type: 'agentMessage', text: 'α😀' }),
      ) + '\r\n',
    )
    const split = bytes.indexOf(Buffer.from('😀')) + 1
    await p.raw(bytes.subarray(0, split))
    await p.raw(bytes.subarray(split))
    await p.raw(Buffer.from(JSON.stringify(turnFrame('completed'))))
    await p.exit()
    expect((await receipt.completion).status).toBe('completed')
    expect(
      p.events.find((event) => event.type === 'content_snapshot'),
    ).toMatchObject({ text: 'α😀' })
  })

  it.each(['cwd', 'home', 'ephemeral', 'missing-id', 'wrong-resume-id'])(
    '4, 7: invalid startup %s closes its owned process',
    async (kind) => {
      const p = await peer([], { load: kind === 'wrong-resume-id' })
      if (kind === 'home')
        p.startup[0]!.result = {
          codexHome: '/wrong',
          platformFamily: 'unix',
          platformOs: 'linux',
          userAgent: 'fixture',
        }
      else {
        const response = structuredClone(p.response)
        if (kind === 'cwd') response.cwd = '/wrong'
        if (kind === 'ephemeral') response.thread.ephemeral = true
        if (kind === 'missing-id') response.thread.id = ''
        if (kind === 'wrong-resume-id') response.thread.id = 'other'
        p.startup.at(-1)!.result = response
      }
      await p.save(p.startup)
      await expect(p.start()).rejects.toThrow()
      await expectStopped(
        (await p.trace()).find((frame) => frame.event === 'spawned')!
          .pid as number,
      )
      expect(p.events).toEqual([])
    },
  )

  it.each(['none', 'started', 'content', 'callback', 'completed'])(
    '61, 63: lost start reply with %s retires without acceptance or resend',
    async (activity) => {
      const before =
        activity === 'none'
          ? []
          : [
              turnFrame('started'),
              ...(activity === 'content'
                ? [
                    itemFrame({
                      id: 'message',
                      type: 'agentMessage',
                      text: 'unconfirmed',
                    }),
                  ]
                : []),
              ...(activity === 'callback'
                ? [
                    {
                      id: 'pending',
                      method: 'item/commandExecution/requestApproval',
                      params: {
                        threadId: 'root',
                        turnId: 't1',
                        itemId: 'tool',
                        startedAtMs: 1,
                      },
                    },
                  ]
                : []),
              ...(activity === 'completed' ? [turnFrame('completed')] : []),
            ]
      const p = await peer([{ method: 'turn/start', before }])
      const h = await p.start()
      shortNativeDeadlines()
      await expect(h.prompt('one copy')).rejects.toThrow('DELIVERY_UNKNOWN')
      await expect(h.prompt('later')).rejects.toThrow('UNAVAILABLE')
      expect(
        p.events.some(
          (event) =>
            event.type === 'prompt_accepted' || event.type === 'turn_completed',
        ),
      ).toBe(false)
      expect(
        (await methods(p)).filter((method) => method === 'turn/start'),
      ).toHaveLength(1)
      expect(h.binding?.providerSessionId).toBe('root')
      await expectStopped(
        (await p.trace()).find((frame) => frame.event === 'spawned')!
          .pid as number,
      )
    },
  )

  it.each(['none', 'started', 'content', 'callback', 'completed'])(
    '16, 62: cancellation before a lost start reply with %s keeps cancellation',
    async (activity) => {
      const before =
        activity === 'none'
          ? []
          : [
              turnFrame('started'),
              ...(activity === 'content'
                ? [
                    itemFrame({
                      id: 'unconfirmed',
                      type: 'agentMessage',
                      text: 'unconfirmed',
                    }),
                  ]
                : []),
              ...(activity === 'callback'
                ? [
                    {
                      id: 'unconfirmed',
                      method: 'item/commandExecution/requestApproval',
                      params: {
                        threadId: 'root',
                        turnId: 't1',
                        itemId: 'tool',
                        startedAtMs: 1,
                      },
                    },
                  ]
                : []),
              ...(activity === 'completed' ? [turnFrame('completed')] : []),
            ]
      const p = await peer([{ method: 'turn/start', before }])
      const h = await p.start()
      shortNativeDeadlines()
      const send = Promise.resolve(h.prompt('input'))
      const rejected = expect(send).rejects.toThrow('CANCELLED')
      await eventually(async () => (await methods(p)).includes('turn/start'))
      const first = h.cancel()
      expect(h.cancel()).toBe(first)
      await first
      await rejected
      expect(await methods(p)).not.toContain('turn/interrupt')
      expect(h.binding?.providerSessionId).toBe('root')
      expect(
        p.events.some(
          (event) =>
            event.type === 'prompt_accepted' || event.type === 'turn_completed',
        ),
      ).toBe(false)
    },
  )

  it('16: a cancelled pending start interrupts only its eventual native owner', async () => {
    const p = await peer([
      { method: 'turn/start', delay: 75, result: { turn: turn('submitted') } },
      {
        method: 'turn/interrupt',
        expected: { threadId: 'root', turnId: 'submitted' },
        result: {},
        after: [turnFrame('completed', 'submitted', 'interrupted')],
      },
    ])
    const h = await p.start()
    const send = Promise.resolve(h.prompt('input'))
    const rejected = expect(send).rejects.toThrow('CANCELLED')
    await eventually(async () => (await methods(p)).includes('turn/start'))
    await h.cancel()
    await rejected
    expect(
      p.events.find((event) => event.type === 'turn_completed'),
    ).toMatchObject({ outcome: { status: 'interrupted' } })
  })

  it('11, 64: a response naming a previously owned native turn keeps the first completion', async () => {
    const p = await peer([
      { method: 'turn/start', result: { turn: turn('previous', 'completed') } },
      { method: 'turn/start', result: { turn: turn('previous') } },
    ])
    const h = await p.start()
    const first = await h.prompt('first', undefined, {
      runId: 'first-run',
      turnId: 'first-turn',
    })
    await expect(
      h.prompt('second', undefined, {
        runId: 'second-run',
        turnId: 'second-turn',
      }),
    ).rejects.toThrow('DELIVERY_CONFLICT')
    expect((await first.completion).status).toBe('completed')
    expect(p.events.some((event) => event.runId === 'second-run')).toBe(false)
    expect(
      p.events.filter((event) => event.type === 'prompt_accepted'),
    ).toHaveLength(1)
  })

  it('65, 66: one in-flight unowned start gets one owner; the capture proves no start-only provenance', async () => {
    const p = await peer([
      {
        method: 'turn/start',
        before: [turnFrame('started', 'unknown-origin')],
        result: { turn: turn('unknown-origin') },
        after: [turnFrame('completed', 'unknown-origin')],
      },
    ])
    const h = await p.start()
    const receipt = await h.prompt('input')
    expect((await receipt.completion).status).toBe('completed')
    expect(
      p.events.filter((event) => event.type === 'turn_started'),
    ).toHaveLength(1)
    expect(
      p.events.filter((event) => event.type === 'prompt_accepted'),
    ).toHaveLength(1)
  })

  it('57, 58, 59: overlapping steer loaders cannot reorder or retarget after completion', async () => {
    const gate = deferred<typeof file>()
    let calls = 0
    const p = await peer([{ method: 'turn/start', result: { turn: turn() } }], {
      options: {
        loadAttachment: () => {
          calls++
          return gate.promise
        },
      },
    })
    const h = await p.start()
    const first = await h.prompt('first')
    const steering = Promise.resolve(h.steer!(attachment))
    const rejected = expect(steering).rejects.toThrow('CANCELLED')
    await expect(Promise.resolve(h.steer!(attachment))).rejects.toThrow('BUSY')
    await p.send([turnFrame('completed'), turnFrame('started', 'wake')])
    await first.completion
    await rejected
    gate.resolve(file)
    expect(calls).toBe(1)
    expect(await methods(p)).not.toContain('turn/steer')
  })

  it('54, 60, 72: cancelled loaders keep actual work admission until settlement', async () => {
    const gates = [deferred<typeof file>(), deferred<typeof file>()]
    let calls = 0
    const p = await peer([], {
      options: { loadAttachment: () => gates[calls++]!.promise },
    })
    const h = await p.start()
    for (let index = 0; index < 2; index++) {
      const pending = Promise.resolve(h.prompt(attachment))
      const rejected = expect(pending).rejects.toThrow('CANCELLED')
      await h.cancel()
      await rejected
    }
    await expect(
      h.prompt(attachment, undefined, {
        runId: 'reusable',
        turnId: 'reusable',
      }),
    ).rejects.toThrow('PREPARATIONS_LIMIT')
    expect(calls).toBe(2)
    await h.kill()
    for (const gate of gates) gate.resolve(file)
    expect(await methods(p)).not.toContain('turn/start')
  })

  it('18, 44: runtime death expires original callbacks and retains completed outcomes', async () => {
    const p = await peer([{ method: 'turn/start', result: { turn: turn() } }])
    const h = await p.start()
    const receipt = await h.prompt('input')
    await p.send([
      {
        id: 'permission',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'root',
          turnId: 't1',
          itemId: 'tool',
          startedAtMs: 1,
        },
      },
      turnFrame('completed'),
    ])
    await receipt.completion
    const request = p.events.find(
      (event) => event.type === 'permission_requested',
    )!.request
    await p.exit()
    await eventually(() =>
      p.events.some((event) => event.type === 'request_cancelled'),
    )
    await expect(
      Promise.resolve().then(() =>
        h.replyPermission!({ type: 'denied', requestId: request.requestId }),
      ),
    ).rejects.toThrow('STALE')
    expect((await receipt.completion).status).toBe('completed')
  })
})
