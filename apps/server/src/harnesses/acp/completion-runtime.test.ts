import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import type { PrefixTransaction } from './ingestion.js'
import { describe, expect, test, vi } from 'vitest'
import type { HarnessHandle } from '../types.js'
import { expectStopped } from '../transport-test-helpers.js'
import { createGrokAdapter } from './providers.js'
import { acpProviderDescriptors } from './profiles.js'
import { sdkFixture } from './sdk-test-helpers.js'

async function withinTestBound<T>(promise: PromiseLike<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Error('Native completion did not settle within the test bound'),
            ),
          7000,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function completionFixture(rail: 'public' | 'comet', scenario: string) {
  const f = await sdkFixture('grok-completion')
  const gate = join(f.session.cwd, 'reply-gate')
  const sources = new Map<string, { method: string; params: unknown }>()
  const durable: PrefixTransaction[] = []
  const store = f.deps.contentStore
  f.deps.contentStore = {
    ...store,
    async put(input, signal) {
      const metadata =
        input.purpose === 'source_metadata' && input.mime === 'application/json'
          ? JSON.parse(Buffer.from(input.bytes).toString('utf8'))
          : undefined
      const acknowledgement = await store.put(input, signal)
      if (metadata) sources.set(acknowledgement.artifactId, metadata)
      return acknowledgement
    },
  }
  const ingestion = f.deps.ingestion
  f.deps.ingestion = {
    async open(input, signal) {
      const writer = await ingestion.open(input, signal)
      return {
        ...writer,
        async commit(transaction, commitSignal) {
          const acknowledgement = await writer.commit(transaction, commitSignal)
          durable.push(transaction)
          return acknowledgement
        },
      }
    },
  }
  f.deps.launch = {
    ...f.deps.launch,
    command: fileURLToPath(
      new URL('./__fixtures__/provider-agent.mjs', import.meta.url),
    ),
    args: acpProviderDescriptors.grok.args,
    env: {
      ...f.deps.launch.env,
      FORGE_ACP_TEST_COMPLETION: scenario,
      FORGE_ACP_TEST_RAIL: rail,
      FORGE_ACP_TEST_REPLY_GATE: gate,
    },
  }
  return {
    ...f,
    gate,
    hasDurableSource(frame: { method: string; params: unknown }) {
      return durable
        .flatMap((transaction) => transaction.records)
        .some(
          (record) =>
            record.value.kind === 'disposition' &&
            record.value.status === 'ignored' &&
            record.value.code === 'native_source_only' &&
            record.sourceRefs?.some((reference) => {
              const source = sources.get(reference.artifactId)
              return (
                source?.method === frame.method &&
                isDeepStrictEqual(source.params, frame.params)
              )
            }),
        )
    },
    adapter: createGrokAdapter({ ...f.deps, grokRail: rail }),
    async rows() {
      return (await readFile(join(f.session.cwd, 'wire.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    },
  }
}

describe.each(['public', 'comet'] as const)(
  'Grok %s original completion authority',
  (rail) => {
    test.each([
      'valid',
      'error',
      'missing',
      'foreign-session',
      'foreign-prompt',
      'response-first',
    ] as const)(
      'correlates %s completion with the exact native prompt',
      async (scenario) => {
        const f = await completionFixture(rail, scenario)
        let handle: HarnessHandle | undefined
        try {
          handle = await f.adapter.spawn(f.session, (event) =>
            f.events.push(event),
          )
          const receipt = await handle.prompt('Correlated completion')
          let settled = false
          void receipt.completion.then(
            () => {
              settled = true
            },
            () => {
              settled = true
            },
          )
          if (
            ['missing', 'foreign-session', 'foreign-prompt'].includes(scenario)
          ) {
            await vi.waitFor(async () =>
              expect(
                (await f.rows()).some((row) => row.event === 'completion_sent'),
              ).toBe(true),
            )
            const sent = (await f.rows()).find(
              (row) => row.event === 'completion_sent',
            )
            expect(sent.frame).toBeDefined()
            await vi.waitFor(() =>
              expect(f.hasDurableSource(sent.frame)).toBe(true),
            )
            expect(settled).toBe(false)
            await writeFile(f.gate, 'release original native reply')
          }
          const outcome = await withinTestBound(receipt.completion)
          const status = ['valid', 'response-first'].includes(scenario)
            ? 'completed'
            : 'failed'
          expect(outcome.status).toBe(status)
          if (scenario === 'error')
            expect(outcome).toMatchObject({ code: 'acp_error' })
          if (
            ['missing', 'foreign-session', 'foreign-prompt'].includes(scenario)
          )
            expect(outcome).toMatchObject({ code: 'acp_refusal' })
          const terminals = f.transactions
            .flatMap((transaction) => transaction.records)
            .filter(
              (record) =>
                record.value.kind === 'event' &&
                record.value.event.type === 'turn_completed',
            )
          expect(terminals).toHaveLength(1)
          expect(terminals[0]).toMatchObject({
            value: { kind: 'event', event: { outcome: { status } } },
          })
          const prompt = (await f.frames()).find(
            (frame) => frame.method === 'session/prompt',
          )
          expect(prompt.params._meta.promptId).toBe(receipt.receiptId)
          if (rail === 'comet')
            expect(prompt.params._meta.requestId).toBe(receipt.receiptId)
          else expect(prompt.params._meta.requestId).toBeUndefined()
        } finally {
          await f.cleanup(handle)
        }
      },
      15000,
    )

    test('retires a hung original RPC before loading the same session for the queued turn', async () => {
      const f = await completionFixture(rail, 'hung')
      let handle: HarnessHandle | undefined
      try {
        handle = await f.adapter.spawn(f.session, (event) =>
          f.events.push(event),
        )
        const binding = handle.binding
        const first = await handle.prompt('First hung native response')
        const second = await handle.prompt('Queued after original cleanup')
        expect((await first.completion).status).toBe('completed')
        expect((await second.completion).status).toBe('completed')
        const rows = await f.rows()
        const starts = rows.filter((row) => row.event === 'spawned')
        expect(starts).toHaveLength(2)
        await expectStopped(starts[0].pid)
        const load = rows.filter((row) => row.frame?.method === 'session/load')
        expect(load).toHaveLength(1)
        expect(load[0].frame.params.sessionId).toBe(binding!.providerSessionId)
        const prompts = rows.filter(
          (row) => row.frame?.method === 'session/prompt',
        )
        expect(prompts.map((row) => row.pid)).toEqual(
          starts.map((row) => row.pid),
        )
        expect(rows.indexOf(load[0])).toBeLessThan(rows.indexOf(prompts[1]))
        expect(
          f.events.filter((event) => event.type === 'turn_completed'),
        ).toMatchObject([
          { outcome: { status: 'completed' } },
          { outcome: { status: 'completed' } },
        ])
      } finally {
        await f.cleanup(handle)
      }
    }, 15000)
  },
)
