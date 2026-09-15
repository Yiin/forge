import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test, vi } from 'vitest'
import type { HarnessHandle } from '../types.js'
import { expectStopped } from '../transport-test-helpers.js'
import {
  createDevinAdapter,
  createGrokAdapter,
  createGeminiAdapter,
  createCustomAcpAdapter,
} from './providers.js'
import { nativeModeSelectorId } from './config.js'
import { sdkFixture } from './sdk-test-helpers.js'
import { acpProviderDescriptors } from './profiles.js'

async function providerFixture(
  profile: 'grok' | 'devin' | 'gemini' | 'custom-acp',
) {
  const f = await sdkFixture(
    profile === 'devin'
      ? 'devin-advertisement'
      : profile === 'gemini'
        ? 'gemini-modes'
        : 'grok-policy',
  )
  const gate = join(f.session.cwd, 'model-gate')
  f.deps.launch = {
    ...f.deps.launch,
    command: fileURLToPath(
      new URL('./__fixtures__/provider-agent.mjs', import.meta.url),
    ),
    args: acpProviderDescriptors[profile].args,
    env: { ...f.deps.launch.env, FORGE_ACP_TEST_MODEL_GATE: gate },
  }
  return {
    ...f,
    gate,
    async rows() {
      return (await readFile(join(f.session.cwd, 'wire.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    },
  }
}

describe('provider policy and model selection through native ACP frames', () => {
  test('Grok rotates the original process and loads the exact session for each policy change', async () => {
    const f = await providerFixture('grok')
    let handle: HarnessHandle | undefined
    try {
      handle = await createGrokAdapter({ ...f.deps, grokRail: 'public' }).spawn(
        f.session,
        (event) => f.events.push(event),
      )
      const binding = handle.binding
      for (const permissionMode of ['manual', 'yolo', 'manual'] as const) {
        const receipt = await handle.prompt('Policy test', { permissionMode })
        expect((await receipt.completion).status).toBe('completed')
        expect(handle.binding?.providerSessionId).toBe(
          binding?.providerSessionId,
        )
        const rows = await f.rows()
        const starts = rows.filter((row) => row.event === 'spawned')
        for (const old of starts.slice(0, -1)) await expectStopped(old.pid)
      }
      const rows = await f.rows()
      const starts = rows.filter((row) => row.event === 'spawned')
      expect(starts).toHaveLength(3)
      for (const start of starts)
        expect(start.args).toEqual([
          '--no-auto-update',
          '--permission-mode',
          'ask',
          'agent',
          '--no-leader',
          'stdio',
        ])
      const sessionCalls = rows.filter((row) =>
        ['session/new', 'session/load'].includes(row.frame?.method),
      )
      expect(sessionCalls.map((row) => row.frame.method)).toEqual([
        'session/new',
        'session/load',
        'session/load',
      ])
      expect(sessionCalls.map((row) => row.frame.params._meta)).toEqual([
        expect.objectContaining({ yoloMode: false, autoMode: false }),
        expect.objectContaining({ yoloMode: true, autoMode: false }),
        expect.objectContaining({ yoloMode: false, autoMode: false }),
      ])
      for (const load of sessionCalls.slice(1))
        expect(load.frame.params.sessionId).toBe(binding?.providerSessionId)
      const prompts = rows.filter(
        (row) => row.frame?.method === 'session/prompt',
      )
      expect(prompts).toHaveLength(3)
      expect(prompts.map((row) => row.pid)).toEqual(
        starts.map((row) => row.pid),
      )
      for (let index = 0; index < prompts.length; index++)
        expect(rows.indexOf(sessionCalls[index])).toBeLessThan(
          rows.indexOf(prompts[index]),
        )
      const before = await f.frames()
      await expect(
        Promise.resolve().then(() =>
          handle!.prompt('Unsupported auto', { permissionMode: 'auto' }),
        ),
      ).rejects.toThrow()
      expect(await f.frames()).toEqual(before)
      expect(f.failures).toEqual([])
    } finally {
      await f.cleanup(handle)
    }
  }, 15000)

  test('Devin waits for the exact native effort advertisement before model selection', async () => {
    const f = await providerFixture('devin')
    let handle: HarnessHandle | undefined
    try {
      handle = await createDevinAdapter(f.deps).spawn(f.session, (event) =>
        f.events.push(event),
      )
      await vi.waitFor(async () =>
        expect(
          (await f.rows()).some(
            (row) => row.event === 'awaiting_advertisement',
          ),
        ).toBe(true),
      )
      let settled = false
      const selected = Promise.resolve().then(() =>
        handle!.setModel!('model-uid/reasoning-high'),
      )
      void selected.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        },
      )
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(settled).toBe(false)
      expect(
        (await f.frames()).some(
          (frame) => frame.method === 'session/set_config_option',
        ),
      ).toBe(false)
      await writeFile(f.gate, 'advertise')
      await selected
      const changes = (await f.frames()).filter(
        (frame) => frame.method === 'session/set_config_option',
      )
      expect(changes).toHaveLength(1)
      expect(changes[0].params).toEqual({
        sessionId: handle.binding!.providerSessionId,
        configId: 'native-model',
        value: 'model-uid/reasoning-high',
      })
      expect(f.failures).toEqual([])
    } finally {
      await f.cleanup(handle)
    }
  }, 15000)
  test('Devin rejects a missing advertisement after its bounded wait without dispatch', async () => {
    const f = await providerFixture('devin')
    let handle: HarnessHandle | undefined
    try {
      handle = await createDevinAdapter(f.deps).spawn(f.session, (event) =>
        f.events.push(event),
      )
      const began = performance.now()
      await expect(
        Promise.resolve().then(() =>
          handle!.setModel!('model-uid/reasoning-high'),
        ),
      ).rejects.toThrow(/advertis|model/i)
      expect(performance.now() - began).toBeGreaterThanOrEqual(9000)
      expect(
        (await f.frames()).some(
          (frame) =>
            frame.method === 'session/set_config_option' ||
            frame.method === 'session/set_model',
        ),
      ).toBe(false)
      expect(f.failures).toEqual([])
    } finally {
      await f.cleanup(handle)
    }
  }, 15000)
  test('Gemini preserves native edit-only and plan modes and rejects conflicting shared policies before dispatch', async () => {
    const f = await providerFixture('gemini')
    let handle: HarnessHandle | undefined
    try {
      const adapter = createGeminiAdapter(f.deps)
      expect(adapter.capabilities.loadSession).toBe(false)
      expect(adapter.load).toBeUndefined()
      handle = await adapter.spawn(f.session, (event) => f.events.push(event))
      for (const mode of ['autoEdit', 'plan']) {
        await handle.setConfigOption!(nativeModeSelectorId, mode)
        const receipt = await handle.prompt('Keep explicit native mode')
        expect((await receipt.completion).status).toBe('completed')
        const frames = await f.frames()
        expect(
          frames.filter((frame) => frame.method === 'session/set_mode').at(-1)
            .params.modeId,
        ).toBe(mode)
        expect(
          frames.some((frame) => frame.method === 'session/set_config_option'),
        ).toBe(false)
      }
      await handle.setConfigOption!(nativeModeSelectorId, 'autoEdit')
      for (const permissionMode of ['auto', 'yolo', 'manual'] as const) {
        const before = await f.frames()
        await expect(
          Promise.resolve().then(() =>
            handle!.prompt('Conflicting policy', { permissionMode }),
          ),
        ).rejects.toThrow()
        expect(await f.frames()).toEqual(before)
      }
      await handle.setConfigOption!(nativeModeSelectorId, 'default')
      expect(
        (
          await (
            await handle.prompt('Compatible manual', {
              permissionMode: 'manual',
            })
          ).completion
        ).status,
      ).toBe('completed')
      await handle.setConfigOption!(nativeModeSelectorId, 'yolo')
      expect(
        (
          await (
            await handle.prompt('Compatible yolo', { permissionMode: 'yolo' })
          ).completion
        ).status,
      ).toBe('completed')
      const rows = await f.rows()
      for (const prompt of rows.filter(
        (row) => row.frame?.method === 'session/prompt',
      )) {
        const before = rows.slice(0, rows.indexOf(prompt))
        expect(before.some((row) => row.event === 'mode_acknowledged')).toBe(
          true,
        )
      }
      expect(f.failures).toEqual([])
    } finally {
      await f.cleanup(handle)
    }
  }, 15000)
  test('Grok keeps two native response boundaries and source signatures within one original turn', async () => {
    const f = await providerFixture('grok')
    f.deps.launch = {
      ...f.deps.launch,
      env: { ...f.deps.launch.env, FORGE_ACP_TEST_SCENARIO: 'grok-responses' },
    }
    const sources: unknown[] = []
    const originalPut = f.deps.contentStore.put
    f.deps.contentStore.put = async (input, signal) => {
      if (input.purpose === 'source_metadata')
        sources.push(JSON.parse(Buffer.from(input.bytes).toString('utf8')))
      return originalPut(input, signal)
    }
    let handle: HarnessHandle | undefined
    try {
      handle = await createGrokAdapter({ ...f.deps, grokRail: 'public' }).spawn(
        f.session,
        (event) => f.events.push(event),
      )
      const receipt = await handle.prompt('Two native responses')
      expect((await receipt.completion).status).toBe('completed')
      const text = f.events.filter((event) => event.type === 'text_delta')
      expect(text.map((event) => event.text)).toEqual([
        'Response 1.',
        'Response 2.',
      ])
      const boundaries = f.events.filter(
        (event) => event.type === 'source_reference',
      )
      expect(boundaries.map((event) => event.boundary)).toEqual([
        'opened',
        'reasoning_closed',
        'closed',
        'opened',
        'reasoning_closed',
        'closed',
      ])
      const responseIds = boundaries.map((event) =>
        'responseId' in event.subject ? event.subject.responseId : undefined,
      )
      expect(responseIds[0]).toBeTruthy()
      expect(responseIds[3]).toBeTruthy()
      expect(responseIds[0]).not.toBe(responseIds[3])
      expect(responseIds.slice(0, 3)).toEqual(Array(3).fill(responseIds[0]))
      expect(responseIds.slice(3)).toEqual(Array(3).fill(responseIds[3]))
      const records = f.transactions.flatMap(
        (transaction) => transaction.records,
      )
      expect(
        records
          .filter(
            (record) =>
              record.value.kind === 'event' &&
              record.value.event.type === 'text_delta',
          )
          .map((record) => record.subject?.responseId),
      ).toEqual([responseIds[0], responseIds[3]])
      for (let index = 1; index <= 2; index++) {
        expect(sources).toContainEqual(
          expect.objectContaining({
            native: expect.objectContaining({
              update: expect.objectContaining({
                sessionUpdate: 'reasoning_completed',
                signature: `signature-${index}`,
              }),
            }),
          }),
        )
        expect(sources).toContainEqual(
          expect.objectContaining({
            native: expect.objectContaining({
              update: expect.objectContaining({
                sessionUpdate: 'response_completed',
                message_id: index === 1 ? 'native-one' : 'native-two',
                stop_sequence: `stop-${index}`,
              }),
            }),
          }),
        )
      }
      expect(
        f.events.filter((event) => event.type === 'turn_completed'),
      ).toHaveLength(1)
      expect(f.failures).toEqual([])
    } finally {
      await f.cleanup(handle)
    }
  }, 15000)
  test.each([
    ['end_turn', 'completed'],
    ['cancelled', 'interrupted'],
    ['refusal', 'failed'],
    ['max_tokens', 'failed'],
    ['max_turn_requests', 'failed'],
    ['unrecognized', 'failed'],
    ['rpc-error', 'failed'],
  ] as const)(
    'maps native %s to an authoritative %s result',
    async (stopReason, status) => {
      const f = await providerFixture('custom-acp')
      f.deps.launch = {
        ...f.deps.launch,
        env: { ...f.deps.launch.env, FORGE_ACP_TEST_STOP: stopReason },
      }
      let handle: HarnessHandle | undefined
      try {
        handle = await createCustomAcpAdapter(f.deps).spawn(
          f.session,
          (event) => f.events.push(event),
        )
        const receipt = await handle.prompt('Native terminal result')
        const result = await receipt.completion
        expect(result.status).toBe(status)
        const terminal = f.transactions
          .flatMap((transaction) => transaction.records)
          .filter(
            (record) =>
              record.value.kind === 'event' &&
              record.value.event.type === 'turn_completed',
          )
        expect(terminal).toHaveLength(1)
        expect(terminal[0]!.value).toMatchObject({
          kind: 'event',
          event: { outcome: { status } },
        })
        expect(
          f.events.filter((event) => event.type === 'turn_completed'),
        ).toMatchObject([{ outcome: { status } }])
        if (
          ['refusal', 'max_tokens', 'max_turn_requests'].includes(stopReason)
        ) {
          expect(result).toMatchObject({ code: `acp_${stopReason}` })
          expect(terminal[0]!.value).toMatchObject({
            kind: 'event',
            event: { outcome: { code: `acp_${stopReason}` } },
          })
        }
      } finally {
        await f.cleanup(handle)
      }
    },
    15000,
  )
})
