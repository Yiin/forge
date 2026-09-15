import { createHash } from 'node:crypto'
import { expect, test, vi } from 'vitest'
import { createAcpContent } from './content.js'
import { createAcpNativeSource } from './native-source.js'
import { captureNumbers } from './numbers.js'
import { AcpResourceHost } from './limits.js'
import type { AcpContentOwner, AcpContentStore } from './ingestion.js'
import { deferred } from '../transport-test-helpers.js'

function subject(): AcpContentOwner {
  return {
    owner: {
      phase: 'live',
      sessionId: 'session',
      providerInstanceId: 'provider',
      account: { kind: 'native-default', configurationId: 'profile' },
      runtimeGeneration: 'generation',
      runId: 'original-run',
      turnId: 'original-turn',
      binding: {
        provider: 'provider',
        providerSessionId: 'native',
        accountId: null,
        cwd: '/workspace',
      },
    },
    itemId: 'item',
    childId: 'child',
    intervalId: 'interval',
  }
}
function setup(held?: Promise<void>) {
  const host = new AcpResourceHost(),
    entered = deferred<void>()
  const store: AcpContentStore = {
    put: vi.fn(async (input) => {
      entered.resolve()
      await held
      return {
        artifactId: 'artifact',
        mime: input.mime,
        bytes: input.bytes.length,
        sha256: createHash('sha256').update(input.bytes).digest('hex'),
      }
    }),
    discard: vi.fn(async () => {}),
  }
  const content = createAcpContent({ store, host, instanceId: 'provider' })
  const source = createAcpNativeSource({
    content,
    host,
    instanceId: 'provider',
  })
  return { host, store, content, source, entered: entered.promise }
}
const signal = () => new AbortController().signal

test('child and extension evidence preserves exact unsafe, overflow, signed-zero, and nullable native values', async () => {
  const f = setup()
  const wire =
    '{"id":9,"params":{"_meta":{"subagent_id":18446744073709551615},"duration_ns":1e400,"cost":-0,"zero":0,"nullable":null,"data":"extension data"}}'
  try {
    const result = await f.source.source(
      subject(),
      '_x.ai/session/update',
      JSON.parse(wire).params,
      captureNumbers(wire),
      signal(),
    )
    expect(result).toMatchObject({
      subject: { itemId: 'item', childId: 'child', intervalId: 'interval' },
      value: {
        kind: 'disposition',
        status: 'ignored',
        code: 'native_source_only',
      },
      sourceRefs: [{ artifactId: 'artifact' }],
    })
    const stored = vi.mocked(f.store.put).mock.calls[0]![0]
    const metadata = JSON.parse(Buffer.from(stored.bytes).toString())
    expect(metadata.params).toEqual({
      _meta: { subagent_id: '18446744073709551615' },
      duration_ns: '1e400',
      cost: '-0',
      zero: '0',
      nullable: null,
      data: 'extension data',
    })
    expect(
      metadata.numbers.map((token: { text: string }) => token.text),
    ).toEqual(['18446744073709551615', '1e400', '-0', '0'])
    expect(
      metadata.numbers.every((token: { path: string }) =>
        token.path.startsWith('/params/'),
      ),
    ).toBe(true)
    expect(stored.owner.owner).toMatchObject({ runId: 'original-run' })
  } finally {
    await f.content.close()
  }
})

test.each([
  ['missing token', { value: 1 }, { numbers: [] }],
  ['changed token', { value: 2 }, captureNumbers('{"params":{"value":1}}')],
  ['unused token', { value: '1' }, captureNumbers('{"params":{"value":1}}')],
  [
    'duplicate token',
    { value: 1 },
    {
      numbers: [
        { path: '/params/value', text: '1', offset: 0 },
        { path: '/params/value', text: '1', offset: 0 },
      ],
    },
  ],
])('rejects %s before external storage', async (_name, params, numbers) => {
  const f = setup()
  try {
    await expect(
      f.source.source(subject(), 'extension', params, numbers, signal()),
    ).rejects.toThrow()
    expect(f.store.put).not.toHaveBeenCalled()
  } finally {
    await f.content.close()
  }
})

test('rejects accessors and recognized binary payloads without stripping ordinary metadata names', async () => {
  const f = setup()
  let getters = 0
  try {
    await expect(
      f.source.source(
        subject(),
        'extension',
        {
          get secret() {
            getters++
            return 1
          },
        },
        { numbers: [] },
        signal(),
      ),
    ).rejects.toThrow('accessors')
    expect(getters).toBe(0)
    await expect(
      f.source.source(
        subject(),
        'extension',
        { type: 'image', data: 'aGVsbG8=' },
        { numbers: [] },
        signal(),
      ),
    ).rejects.toThrow('content artifact')
    expect(f.store.put).not.toHaveBeenCalled()
    await f.source.source(
      subject(),
      'extension',
      { data: 'plain', content: 'metadata' },
      { numbers: [] },
      signal(),
    )
    expect(f.store.put).toHaveBeenCalledTimes(1)
  } finally {
    await f.content.close()
  }
})

test('captures original subjects and params before a held store callback', async () => {
  const held = deferred<void>(),
    f = setup(held.promise)
  const original = subject(),
    params = { label: 'original' }
  const pending = f.source.source(
    original,
    'extension',
    params,
    { numbers: [] },
    signal(),
  )
  ;(original as { itemId: string }).itemId = 'replacement'
  params.label = 'replacement'
  try {
    await f.entered
    held.resolve()
    const result = await pending
    expect(result.subject?.itemId).toBe('item')
    const stored = vi.mocked(f.store.put).mock.calls[0]![0]
    expect(JSON.parse(Buffer.from(stored.bytes).toString()).params.label).toBe(
      'original',
    )
  } finally {
    held.resolve()
    await f.content.close()
  }
})

test('aborted late puts retain physical content ownership until original discard settles', async () => {
  const held = deferred<void>(),
    f = setup(held.promise),
    controller = new AbortController()
  const pending = f.source.source(
    subject(),
    'extension',
    { value: 'original' },
    { numbers: [] },
    controller.signal,
  )
  const rejected = expect(pending).rejects.toThrow()
  try {
    await f.entered
    controller.abort()
    await rejected
    expect(() => f.host.reserve('provider', 'artifacts', 8)).toThrow(
      'resource limit',
    )
    let closed = false
    const closing = f.content.close().then(() => {
      closed = true
    })
    expect(closed).toBe(false)
    held.resolve()
    await closing
    expect(f.store.discard).toHaveBeenCalledWith('artifact', subject())
    const release = f.host.reserve('provider', 'retained', 128 * 1024 * 1024)
    release()
  } finally {
    held.resolve()
    await f.content.close()
  }
})
