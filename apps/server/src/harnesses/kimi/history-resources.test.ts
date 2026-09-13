import { expect, test, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { KimiHostOwner, type KimiLease } from './host.js'
import { KimiBudget, jsonBytes } from './limits.js'
import * as nativeRecords from './records.js'
import {
  readHistoryPage,
  preserveMessage,
  readKimiHistory,
} from './discovery.js'
import type { KimiLaunchAuthority, KimiRecordSink } from './types.js'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const binding = {
  provider: 'kimi',
  accountId: 'synthetic',
  cwd: '/inert',
  providerSessionId: 'native',
}
function fixture(host = new KimiHostOwner(), sessionId = 'v2-history') {
  const budget = new KimiBudget(host.budget.limits)
  const records = new nativeRecords.KimiRecords(
    { sessionId, runtimeGeneration: sessionId, binding },
    budget,
    host,
    async (input) => ({
      ordinal: input.expectedOrdinal + 1,
      disposition: 'committed',
    }),
    () => {},
    new AbortController().signal,
  )
  return { host, budget, records }
}
const message = (text = 'a'.repeat(1048576)) => ({
  id: 'message',
  session_id: 'native',
  role: 'assistant',
  content: [{ type: 'text', text }],
})

test('two retained history owners refuse message construction at exact shared exhaustion, then retain independent outputs', async () => {
  const host = new KimiHostOwner(),
    a = fixture(host, 'home-a'),
    b = fixture(host, 'home-b')
  const pages = await Promise.all(
    [a, b].map((f) =>
      readHistoryPage(
        {} as KimiLease,
        host,
        f.budget,
        '/synthetic',
        f.records.signal,
        performance.now() + 10000,
        async () => ({ items: [message()], has_more: false }),
      ),
    ),
  )
  const before = host.budget.count('hostRetainedBytes')
  const releaseOther = host.budget.reserve(
    'hostRetainedBytes',
    host.budget.limits.hostRetainedBytes - before,
  )
  const record = vi.spyOn(nativeRecords, 'record')
  const outputs: { release(): void }[] = []
  try {
    const localBefore = a.budget.count('retainedBytes')
    await expect(
      preserveMessage(
        (pages[0].value.items as unknown[])[0],
        'snapshot',
        a.records,
        {} as KimiLease,
        host,
        async () => {
          throw new Error('No media')
        },
      ),
    ).rejects.toMatchObject({ code: 'kimi_resource_limit' })
    expect(record).not.toHaveBeenCalled()
    expect(a.budget.count('retainedBytes')).toBe(localBefore)
    expect(host.budget.count('hostRetainedBytes')).toBe(
      host.budget.limits.hostRetainedBytes,
    )
    releaseOther()
    for (const [index, f] of [a, b].entries()) {
      const output = await preserveMessage(
        (pages[index].value.items as unknown[])[0],
        'snapshot',
        f.records,
        {} as KimiLease,
        host,
        async () => {
          throw new Error('No media')
        },
      )
      outputs.push(output)
      expect(output.records).toHaveLength(1)
    }
    expect(host.budget.count('hostRetainedBytes')).toBeGreaterThan(before)
    for (const output of outputs) output.release()
    expect(host.budget.count('hostRetainedBytes')).toBe(before)
  } finally {
    record.mockRestore()
    releaseOther()
    outputs.forEach((output) => output.release())
    pages.forEach((page) => page.release())
    a.records.close()
    b.records.close()
    await host.close()
    await tick()
  }
  expect(host.budget.count('hostRetainedBytes')).toBe(0)
})

test('failed message hashing rolls back its transform lease without releasing the page', async () => {
  const f = fixture(),
    page = await readHistoryPage(
      {} as KimiLease,
      f.host,
      f.budget,
      '/synthetic',
      f.records.signal,
      performance.now() + 10000,
      async () => ({ items: [message()], has_more: false }),
    )
  const before = f.host.budget.count('hostRetainedBytes')
  const record = vi
    .spyOn(nativeRecords, 'record')
    .mockImplementationOnce(() => {
      expect(f.host.budget.count('hostRetainedBytes')).toBeGreaterThan(before)
      throw new Error('Synthetic transform failure')
    })
  try {
    await expect(
      preserveMessage(
        (page.value.items as unknown[])[0],
        'snapshot',
        f.records,
        {} as KimiLease,
        f.host,
        async () => {
          throw new Error('No media')
        },
      ),
    ).rejects.toThrow('Synthetic transform failure')
    expect(f.host.budget.count('hostRetainedBytes')).toBe(before)
  } finally {
    record.mockRestore()
    page.release()
    f.records.close()
    await f.host.close()
    await tick()
  }
  expect(f.host.budget.count('hostRetainedBytes')).toBe(0)
})

test('a timed-out media transform retains sink input until actual callback settlement', async () => {
  const f = fixture(),
    gate = deferred(),
    entered = deferred()
  const baseline = f.host.budget.count('hostRetainedBytes')
  let consumed = false
  const work = preserveMessage(
    {
      id: 'media',
      session_id: 'native',
      role: 'tool',
      content: [
        {
          type: 'image',
          source: { kind: 'base64', media_type: 'image/png', data: 'YWJj' },
        },
      ],
    },
    'snapshot',
    f.records,
    {} as KimiLease,
    f.host,
    async (input) => {
      entered.resolve()
      await gate.promise
      for await (const bytes of input.bytes) {
        expect([...bytes]).toEqual([97, 98, 99])
        consumed = true
      }
      return { attachmentId: 'stored' }
    },
    undefined,
    undefined,
    performance.now() + 20,
  )
  void work.catch(() => {})
  try {
    await entered.promise
    const held = f.host.budget.count('hostRetainedBytes')
    expect(held).toBeGreaterThan(baseline)
    await expect(work).rejects.toMatchObject({ code: 'kimi_deadline' })
    expect(f.host.budget.count('hostRetainedBytes')).toBe(held)
    expect(f.host.budget.count('sinkCalls')).toBe(1)
    expect(f.host.budget.count('hostAttachmentBytes')).toBe(3)
    gate.resolve()
    await tick()
    expect(consumed).toBe(true)
    expect(f.host.budget.count('hostRetainedBytes')).toBe(baseline)
  } finally {
    gate.resolve()
    await work.catch(() => {})
    f.records.close()
    await f.host.close()
    await tick()
  }
  for (const key of [
    'hostRetainedBytes',
    'hostAttachmentBytes',
    'sinkCalls',
  ] as const)
    expect(f.host.budget.count(key)).toBe(0)
})

test.each(['transcript', 'messages'] as const)(
  'public cold %s import refuses page hashing before construction at shared exhaustion',
  async (kind) => {
    const path = await mkdtemp(
        '/var/tmp/forge-comet-kimi-review-correction-v2-history-',
      ),
      host = new KimiHostOwner()
    const authority = {
      provider: 'kimi',
      credentialPolicy: 'configured-native',
      account: {
        id: 'synthetic',
        harnessKey: 'kimi',
        kind: 'kimi',
        adapterKind: 'native',
        homePath: path,
        disabledAt: null,
      },
      harness: {
        command: process.execPath,
        args: [],
        env: {},
        adapterKind: 'native',
        enabled: true,
      },
      environment: {},
    } as unknown as KimiLaunchAuthority
    const nativeBinding = { ...binding, cwd: path },
      session = { id: 'native', metadata: { cwd: path } }
    const transcript = {
      agent_id: 'main',
      seq: 1,
      has_more: false,
      items: [
        {
          kind: 'turn',
          turnId: 't1',
          ordinal: 1,
          state: 'completed',
          origin: { kind: 'user' },
          steps: [
            {
              stepId: 't1.1',
              ordinal: 1,
              state: 'completed',
              frames: [
                {
                  kind: 'text',
                  frameId: 'frame',
                  role: 'assistant',
                  text: 'x'.repeat(131072),
                },
              ],
            },
          ],
        },
      ],
    }
    const messages = { items: [message('x'.repeat(131072))], has_more: false }
    const target = kind === 'transcript' ? transcript : messages
    const targetBytes = jsonBytes(
      target,
      host.budget.limits,
      host.budget.limits.httpJsonBytes,
    )
    const originalReserve = host.budget.reserve.bind(host.budget)
    let filled = false,
      releaseOther = () => {},
      records: nativeRecords.KimiRecords | undefined
    const reserve = vi
      .spyOn(host.budget, 'reserve')
      .mockImplementation((key, amount = 1) => {
        const free = originalReserve(key, amount)
        if (!filled && key === 'hostRetainedBytes' && amount === targetBytes) {
          filled = true
          releaseOther = originalReserve(
            'hostRetainedBytes',
            host.budget.limits.hostRetainedBytes -
              host.budget.count('hostRetainedBytes'),
          )
        }
        return free
      })
    const acquire = vi.spyOn(host, 'acquire').mockImplementation(
      async () =>
        ({
          lane: 'synthetic',
          server: {
            http: async (_lane: string, route: string) => {
              if (route.endsWith('/snapshot'))
                return { session, epoch: 'epoch', as_of_seq: 1 }
              if (route.includes('/transcript?'))
                return kind === 'transcript'
                  ? transcript
                  : { agent_id: 'main', seq: 1, has_more: false, items: [] }
              if (route.includes('/messages?')) return messages
              return session
            },
          },
          resident: () => () => {},
          ingestion: async (
            _native: string,
            _session: string,
            create: () => {
              records: nativeRecords.KimiRecords
              ready: Promise<void>
            },
          ) => {
            const result = create()
            records = result.records
            await result.ready
            return records
          },
          close: async () => {
            records?.close()
            await tick()
          },
        }) as unknown as KimiLease,
    )
    const digest = vi.spyOn(nativeRecords, 'digest'),
      record = vi.spyOn(nativeRecords, 'record')
    const sink: KimiRecordSink = async (input) => ({
      ordinal: input.expectedOrdinal + 1,
      disposition: 'committed',
    })
    try {
      await expect(
        readKimiHistory({
          authority,
          host,
          binding: nativeBinding,
          importScope: { sessionId: 'v2-cold', importId: 'import' },
          readState: async () => ({
            committed: { ordinal: 0 },
            owners: [],
            pending: [],
            checkpoint: { transcripts: {} },
          }),
          commitRecords: sink,
          storeAttachment: async () => {
            throw new Error('No media')
          },
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: 'kimi_resource_limit' })
      expect(filled).toBe(true)
      expect(
        digest.mock.calls.filter(([value]) => value === target.items),
      ).toHaveLength(0)
      expect(
        record.mock.calls.filter(([, domain, , recordKind]) =>
          kind === 'messages'
            ? domain === 'message'
            : recordKind === 'history.turn',
        ),
      ).toHaveLength(0)
    } finally {
      releaseOther()
      reserve.mockRestore()
      acquire.mockRestore()
      digest.mockRestore()
      record.mockRestore()
      records?.close()
      await host.close()
      await tick()
      await rm(path, { recursive: true, force: true })
    }
    expect(host.budget.count('hostRetainedBytes')).toBe(0)
  },
)
