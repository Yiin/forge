import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import type * as SDK from '@cursor/sdk'
import { CursorFixtureStore } from '../../../test/fixtures/cursor-store.js'
import { CursorSidecarRuntime } from './sidecar-runtime.js'
import { CursorNormalizer } from './normalize.js'
import { CursorResources, cursorLimits } from './limits.js'
import type { CursorOwner, CursorSelectedRecords } from './contracts.js'
import { deferred } from '../transport-test-helpers.js'
import { cursorTransport, type CursorFrame } from './wire.js'
import { inputDigest } from './input.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true })
})
async function runtime(
  config: {
    maximumOwner?: boolean
    output?: (frame: CursorFrame) => Promise<void>
  } = {},
) {
  const root = await mkdtemp('/tmp/forge-cursor-runtime-correction-')
  roots.push(root)
  await mkdir(join(root, 'sdk'))
  await mkdir(join(root, 'native-data'))
  const resources = new CursorResources(),
    limits = cursorLimits()
  const shortOwner: CursorOwner = {
    forgeSessionId: 'session',
    provider: 'cursor',
    accountId: 'account',
    cwd: root,
    storeId: 'store',
    generation: 'generation',
    attemptId: 'attempt',
    runId: 'run',
    turnId: 'turn',
  }
  const owner = config.maximumOwner
    ? (Object.fromEntries(
        Object.keys(shortOwner).map((key) => [
          key,
          '"'.repeat(key === 'cwd' ? limits.argValueBytes : limits.idBytes),
        ]),
      ) as CursorOwner)
    : shortOwner
  const sdk = {
    JsonlLocalAgentStore: CursorFixtureStore,
    InteractionUpdateSchema: { parse: (value: unknown) => value },
    ConversationStepSchema: { parse: (value: unknown) => value },
    Agent: {
      create: vi.fn(async () => {
        throw new Error('synthetic create boundary')
      }),
      resume: vi.fn(async () => {
        throw new Error('synthetic resume boundary')
      }),
    },
  } as unknown as typeof SDK
  const frames: any[] = []
  const instance = new CursorSidecarRuntime(
    sdk,
    { accountEnv: {}, settingSources: [] } as unknown as CursorSelectedRecords,
    join(root, 'sdk'),
    owner,
    limits,
    async (frame) => {
      frames.push(frame)
      await config.output?.(frame)
    },
    resources,
    true,
    {
      version: 1,
      reservationId: 'reservation',
      creationOwner: owner,
      sdkVersion: '1.0.28',
      storeRelativePath: 'sessions/store/sdk',
      state: 'creation-started',
    },
  )
  ;(instance as any).models = [{ id: 'test', displayName: 'Test' }]
  return { instance, sdk, owner, resources, limits, frames }
}
it.each(['scan', 'resume-drain'])(
  'prevents native preparation after cancellation at the held %s boundary',
  async (phase) => {
    const value = await runtime(),
      held = deferred<void>(),
      entered = deferred<void>()
    const scanner = (value.instance as any).scanner
    if (phase === 'scan') {
      const request = scanner.request.bind(scanner)
      vi.spyOn(scanner, 'request').mockImplementation(async () => {
        entered.resolve()
        await held.promise
        return request()
      })
    } else {
      vi.spyOn(value.instance.store, 'drain').mockImplementation(async () => {
        entered.resolve()
        await held.promise
        return {
          rows: {
            agents: [
              { agentId: 'existing', status: 'idle', activeRunId: null },
            ],
          },
        } as any
      })
    }
    const work = value.instance.command({
      v: 1,
      generation: 'generation',
      type: 'prepare',
      requestId: '1',
      owner: value.owner,
      reservationId: 'reservation',
      digest: 'a'.repeat(64),
      model: { id: 'test' },
      options: { permissionMode: 'auto' },
      ...(phase === 'resume-drain' ? { agentId: 'existing' } : {}),
    })
    try {
      await entered.promise
      await value.instance.command({
        v: 1,
        generation: 'generation',
        type: 'cancel',
        requestId: '2',
      })
      expect(value.frames.some((frame) => frame.type === 'cancelled')).toBe(
        true,
      )
      held.resolve()
      await work
      expect(value.sdk.Agent.create).not.toHaveBeenCalled()
      expect(value.sdk.Agent.resume).not.toHaveBeenCalled()
      expect(value.frames).toContainEqual(
        expect.objectContaining({
          type: 'failure',
          code: 'cursor_preparation_cancelled',
        }),
      )
    } finally {
      held.resolve()
      await work
      await value.instance.command({
        v: 1,
        generation: 'generation',
        type: 'close',
        requestId: '3',
      })
    }
  },
)
it('holds maximum-owner escaped callback, correction, and final writes through callback and drain settlement', async () => {
  const output = new PassThrough(),
    physical: Array<{ frame: CursorFrame; callback: () => void }> = []
  let bypass = false
  class HeldWritable extends Writable {
    override write(
      chunk: any,
      encodingOrCallback?: any,
      suppliedCallback?: any,
    ): boolean {
      const callback =
        typeof encodingOrCallback === 'function'
          ? encodingOrCallback
          : suppliedCallback
      const frame = JSON.parse(chunk.toString()) as CursorFrame
      if (chunk.length < 1024 * 1024 || bypass) {
        callback()
        return true
      }
      physical.push({ frame, callback })
      return false
    }
  }
  const input = new HeldWritable()
  let transport: ReturnType<typeof cursorTransport>
  const value = await runtime({
    maximumOwner: true,
    output: (frame) => transport.send(frame),
  })
  transport = cursorTransport(
    input,
    output,
    value.owner.generation,
    value.limits,
    () => {},
  )
  const text = '\u0000'.repeat(value.limits.itemBytes),
    corrected = `${text.slice(0, -1)}Z`
  const now = Date.now(),
    message = { text: 'bounded physical output' }
  await value.instance.store.agents.create({
    agent: {
      agentId: 'agent',
      cwd: value.owner.cwd,
      createdAt: now,
      updatedAt: now,
      status: 'idle',
      activeRunId: null,
    },
  })
  value.instance.store.beginAttempt(value.owner.attemptId)
  ;(value.instance as any).prepared = {
    owner: value.owner,
    digest: inputDigest(message),
    model: { id: 'test' },
    policy: {},
  }
  ;(value.instance as any).agent = {
    agentId: 'agent',
    [Symbol.asyncDispose]: async () => {},
    send: async (_message: unknown, options: any) => ({
      id: 'n'.repeat(value.limits.idBytes),
      cancel: async () => {},
      stream: async function* () {},
      wait: async () => {
        await options.onStep({
          step: { type: 'assistantMessage', message: { text } },
        })
        return {
          id: 'n'.repeat(value.limits.idBytes),
          status: 'finished',
          result: corrected,
        }
      },
    }),
  }
  let settled = false
  const work = value.instance
    .command({
      v: 1,
      generation: value.owner.generation,
      type: 'submit',
      requestId: '1',
      reservationId: 'reservation',
      owner: value.owner,
      message,
    })
    .then(() => {
      settled = true
    })
  try {
    for (let index = 0; index < 5; index++) {
      await vi.waitFor(() => expect(physical.length).toBe(index + 1), {
        timeout: 10000,
      })
      expect(settled).toBe(false)
      const before = transport.state.queuedBytes
      expect(before).toBeGreaterThan(12 * 1024 * 1024)
      expect(before).toBeLessThanOrEqual(value.limits.queuedWireBytes)
      expect((value.instance as any).pendingCallbacks).toBe(index < 2 ? 1 : 0)
      physical[index].callback()
      await Promise.resolve()
      expect(transport.state.queuedBytes).toBe(before)
      expect(settled).toBe(false)
      input.emit('drain')
    }
    await work
    expect(physical.map((entry) => entry.frame.type)).toEqual([
      'event',
      'native_record',
      'event',
      'native_record',
      'result',
    ])
    expect((physical[3].frame.record as any).payload.result).toBe(corrected)
    expect((physical[4].frame.result as any).result).toBe(corrected)
    expect(transport.state.queuedBytes).toBe(0)
    expect((value.instance as any).callbackBytes).toBe(0)
  } finally {
    bypass = true
    if (transport.state.queuedFrames) physical.at(-1)?.callback()
    input.emit('drain')
    await work
    await value.instance.command({
      v: 1,
      generation: value.owner.generation,
      type: 'close',
      requestId: 'close',
    })
    await transport.close()
  }
}, 30000)
it('coalesces a callback burst and interval request while retaining the physical scan through shutdown', async () => {
  const value = await runtime(),
    held = deferred<void>(),
    entered = deferred<void>()
  const scan = value.resources.scan.bind(value.resources)
  let physical = 0,
    active = 0,
    peak = 0
  vi.spyOn(value.resources, 'scan').mockImplementation(
    (key, limits, operation) =>
      scan(key, limits, async () => {
        physical++
        active++
        peak = Math.max(peak, active)
        try {
          if (physical === 1) {
            entered.resolve()
            await held.promise
          }
          return await operation()
        } finally {
          active--
        }
      }),
  )
  const normalizer = new CursorNormalizer(
    value.owner,
    value.limits,
    () => {},
    () => {},
  )
  const promises = Array.from({ length: 32 }, () =>
    (value.instance as any).enqueue(
      normalizer,
      'delta',
      { type: 'text-delta', text: 'x' },
      async () => {},
    ),
  )
  try {
    await entered.promise
    const interval = (value.instance as any).scanner.request()
    await Promise.all(promises)
    expect(physical).toBe(1)
    expect(value.resources.snapshot().scans).toBe(1)
    let closed = false
    const closing = value.instance
      .command({
        v: 1,
        generation: 'generation',
        type: 'close',
        requestId: 'close',
      })
      .then(() => {
        closed = true
      })
    await Promise.resolve()
    expect(closed).toBe(false)
    held.resolve()
    await interval
    await closing
    expect(physical).toBe(2)
    expect(peak).toBe(1)
    expect(active).toBe(0)
    expect(value.resources.snapshot().scans).toBe(0)
  } finally {
    held.resolve()
    await Promise.allSettled(promises)
    await (value.instance as any).scanner.stop()
  }
})
