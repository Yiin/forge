import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test, vi } from 'vitest'
import type { HarnessHandle } from '../types.js'
import { expectStopped } from '../transport-test-helpers.js'
import { createDevinAdapter, createGrokAdapter } from './providers.js'
import { sdkFixture } from './sdk-test-helpers.js'

async function providerFixture(profile: 'grok' | 'devin') {
  const f = await sdkFixture(
    profile === 'devin' ? 'devin-advertisement' : 'grok-policy',
  )
  const gate = join(f.session.cwd, 'model-gate')
  f.deps.launch = {
    ...f.deps.launch,
    command: fileURLToPath(
      new URL('./__fixtures__/provider-agent.mjs', import.meta.url),
    ),
    args: profile === 'grok' ? ['agent', 'stdio'] : ['acp'],
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
})
