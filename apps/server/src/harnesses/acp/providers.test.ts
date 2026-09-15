import { describe, expect, test } from 'vitest'
import type { HarnessHandle } from '../types.js'
import { sdkFixture } from './sdk-test-helpers.js'
import {
  acpProviderDescriptors,
  createCustomAcpAdapter,
  createDevinAdapter,
  createGeminiAdapter,
  createGrokAdapter,
  createHermesAdapter,
} from './providers.js'

const providers = [
  ['grok', createGrokAdapter],
  ['gemini', createGeminiAdapter],
  ['devin', createDevinAdapter],
  ['hermes', createHermesAdapter],
  ['custom-acp', createCustomAcpAdapter],
] as const

describe('typed dedicated ACP constructors', () => {
  test.each(providers)(
    '%s owns a typed SDK prompt and its durable completion',
    async (profile, create) => {
      const f = await sdkFixture('normal')
      f.deps.launch = {
        ...f.deps.launch,
        args: [...acpProviderDescriptors[profile].args],
      }
      let handle: HarnessHandle | undefined
      try {
        const adapter = create({ ...f.deps, grokRail: 'comet' })
        expect(adapter.kind).toBe(profile === 'custom-acp' ? 'custom' : 'acp')
        expect(adapter.capabilities.loadSession).toBe(profile !== 'gemini')
        expect(typeof adapter.load).toBe(
          profile === 'gemini' ? 'undefined' : 'function',
        )
        handle = await adapter.spawn(f.session, (event) => f.events.push(event))
        const receipt = await handle.prompt('typed provider')
        expect(await receipt.completion).toEqual({
          status: 'completed',
          runId: receipt.runId,
          turnId: receipt.turnId,
        })
        expect(handle.binding).toMatchObject({
          provider: 'instance',
          accountId: null,
          providerSessionId: 'sdk-session-1',
        })
        expect(
          f.events.some(
            (event) =>
              event.type === 'text_delta' && event.text === 'Hello from SDK.',
          ),
        ).toBe(true)
        expect(
          f.transactions
            .flatMap((transaction) => transaction.records)
            .some(
              (record) =>
                record.value.kind === 'event' &&
                record.value.event.type === 'turn_completed',
            ),
        ).toBe(true)
        expect(f.failures).toEqual([])
      } finally {
        await f.cleanup(handle)
      }
    },
    15000,
  )

  test('rejects unsupported selected-account profiles before native startup', async () => {
    const f = await sdkFixture('normal')
    f.deps.launch = {
      ...f.deps.launch,
      account: {
        kind: 'selected-account',
        accountId: 'account',
        home: f.session.cwd,
      },
    }
    try {
      expect(() => createDevinAdapter(f.deps)).toThrow(
        'isolation is unsupported',
      )
      expect(() => createCustomAcpAdapter(f.deps)).toThrow(
        'isolation is unsupported',
      )
    } finally {
      await f.cleanup()
    }
  })
})
