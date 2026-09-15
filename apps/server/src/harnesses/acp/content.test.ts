import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createAcpContent } from './content.js'
import { AcpResourceHost } from './limits.js'
import type { AcpContentOwner, AcpContentStore } from './ingestion.js'
import { deferred } from '../transport-test-helpers.js'
const owner = (): AcpContentOwner => ({
  owner: {
    phase: 'live',
    sessionId: 'session',
    providerInstanceId: 'provider',
    account: { kind: 'native-default', configurationId: 'config' },
    runtimeGeneration: 'generation',
    runId: 'run',
    turnId: 'turn',
    binding: {
      provider: 'provider',
      accountId: null,
      cwd: '/workspace',
      providerSessionId: 'native',
    },
  },
  itemId: 'item',
  responseId: 'response',
  childId: 'child',
  intervalId: 'interval',
})
type Input = Parameters<AcpContentStore['put']>[0]
const ack = (input: Input) => ({
  artifactId: 'artifact',
  mime: input.mime,
  bytes: input.bytes.byteLength,
  sha256: createHash('sha256').update(input.bytes).digest('hex'),
})
function setup(put: AcpContentStore['put'] = async (input) => ack(input)) {
  const store = { put: vi.fn(put), discard: vi.fn(async () => {}) }
  const host = new AcpResourceHost()
  const content = createAcpContent({ store, host, instanceId: 'provider' })
  return { store, host, content }
}
const signal = () => new AbortController().signal
const image = { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }
describe('ACP durable content', () => {
  it.each(['image', 'audio'])(
    'stores exact %s bytes before returning its reference',
    async (type) => {
      const { content, store } = setup()
      const result = await content.block(owner(), { ...image, type }, signal())
      expect(result).toEqual({
        block: {
          kind: type,
          artifactId: 'artifact',
          mime: 'image/png',
          bytes: 5,
          sha256: createHash('sha256').update('hello').digest('hex'),
        },
        sourceRefs: [],
      })
      expect(Buffer.from(store.put.mock.calls[0]![0].bytes).toString()).toBe(
        'hello',
      )
      expect(store.put.mock.calls[0]![0].owner).toEqual(owner())
      await content.close()
    },
  )
  it('accepts a binary block above the source-sidecar ceiling', async () => {
    const { content, store } = setup()
    const data = Buffer.alloc(1024 * 1024 + 1, 7)
    const result = await content.block(
      owner(),
      { ...image, data: data.toString('base64') },
      signal(),
    )
    expect(result.block).toMatchObject({
      bytes: data.byteLength,
      sha256: createHash('sha256').update(data).digest('hex'),
    })
    expect(store.put.mock.calls[0]![0].bytes.buffer.byteLength).toBe(
      data.byteLength,
    )
    await content.close()
  })
  it('retires completed root counters without resetting the handle budget', async () => {
    const { content } = setup()
    for (let index = 0; index < 129; index++) {
      const subject = owner()
      Object.assign(subject.owner, { runId: `run-${index}` })
      await content.block(subject, image, signal())
      content.retireRoot(subject.owner)
    }
    await content.close()
  })
  it('refuses root retirement while original physical storage remains', async () => {
    const pending = deferred<ReturnType<typeof ack>>()
    const { content, store } = setup(() => pending.promise)
    const subject = owner()
    const task = content.block(subject, image, signal())
    expect(() => content.retireRoot(subject.owner)).toThrow('physical work')
    pending.resolve(ack(store.put.mock.calls[0]![0]))
    await task
    content.retireRoot(subject.owner)
    await content.close()
  })
  it('discards stored content if its source sidecar fails', async () => {
    const { content, store } = setup(async (input) => {
      if (input.purpose === 'source_metadata') throw Error('sidecar failure')
      return ack(input)
    })
    await expect(
      content.block(
        owner(),
        { ...image, annotations: { priority: 1 } },
        signal(),
      ),
    ).rejects.toThrow('sidecar failure')
    expect(store.discard).toHaveBeenCalledWith('artifact', owner())
    await content.close()
  })
  it('refuses foreign root retirement and preserves its exhausted budget', async () => {
    const { content, store } = setup()
    const subject = owner()
    const large = {
      ...image,
      data: Buffer.alloc(8 * 1024 * 1024).toString('base64'),
    }
    for (let index = 0; index < 4; index++)
      await content.block(subject, large, signal())
    const foreign = owner()
    Object.assign(foreign.owner, { turnId: 'foreign-turn' })
    expect(() => content.retireRoot(foreign.owner)).toThrow('Foreign')
    await expect(content.block(subject, image, signal())).rejects.toThrow(
      'byte limit',
    )
    expect(store.put).toHaveBeenCalledTimes(4)
    content.retireRoot(subject.owner)
    await expect(content.block(subject, image, signal())).rejects.toThrow(
      'byte limit',
    )
    expect(store.put).toHaveBeenCalledTimes(4)
    await content.close()
  })
  it('coalesces synchronous same-owner cleanup reentry', async () => {
    const { content, store } = setup(async (input) => ({
      ...ack(input),
      mime: 'wrong',
    }))
    let reentered: Promise<void> | undefined
    store.discard.mockImplementationOnce(async () => {
      reentered = content.retryCleanup()
    })
    await expect(content.block(owner(), image, signal())).rejects.toThrow(
      'acknowledgement',
    )
    await reentered
    expect(store.discard).toHaveBeenCalledTimes(1)
    await content.close()
  })
  it('bounds logical storage time while retaining the original physical write', async () => {
    vi.useFakeTimers()
    const pending = deferred<ReturnType<typeof ack>>()
    const { content, store, host } = setup(() => pending.promise)
    try {
      const task = content.block(owner(), image, signal())
      const rejected = expect(task).rejects.toThrow('cancelled')
      await vi.advanceTimersByTimeAsync(15000)
      await rejected
      const remaining = host.reserve('provider', 'artifacts', 7)
      expect(() => host.reserve('provider', 'artifacts')).toThrow('limit')
      pending.resolve(ack(store.put.mock.calls[0]![0]))
      await content.close()
      const release = host.reserve('provider', 'artifacts')
      release()
      remaining()
      expect(store.discard).toHaveBeenCalledWith('artifact', owner())
    } finally {
      vi.useRealTimers()
    }
  })
  it('includes original storage in a synchronous close reentry', async () => {
    const pending = deferred<ReturnType<typeof ack>>()
    let closing: Promise<void> | undefined
    let settled = false
    const { content, store } = setup(() => {
      closing = content.close().then(() => {
        settled = true
      })
      return pending.promise
    })
    const task = content.block(owner(), image, signal())
    const rejected = expect(task).rejects.toThrow('cancelled')
    await Promise.resolve()
    expect(settled).toBe(false)
    pending.resolve(ack(store.put.mock.calls[0]![0]))
    await closing
    await rejected
    expect(store.discard).toHaveBeenCalledWith('artifact', owner())
  })
  it('retains unknown artifact ownership when a successful put omits its identity', async () => {
    const { content, store, host } = setup(async (input) => ({
      ...ack(input),
      artifactId: '',
    }))
    await expect(content.block(owner(), image, signal())).rejects.toThrow(
      'identity unavailable',
    )
    await expect(content.close()).rejects.toThrow('identity unavailable')
    await expect(content.retryCleanup()).rejects.toThrow('identity unavailable')
    expect(store.discard).not.toHaveBeenCalled()
    const remaining = host.reserve('provider', 'artifacts', 7)
    expect(() => host.reserve('provider', 'artifacts')).toThrow('limit')
    remaining()
  })
  it('preserves exact text resources, links, and unknown metadata without binary duplication', async () => {
    const { content, store } = setup()
    const text = 'α\n\u0000'
    const result = await content.block(
      owner(),
      {
        type: 'resource',
        resource: {
          uri: 'file:///a',
          mimeType: 'text/plain',
          text,
          extension: { exact: true },
        },
        annotations: { audience: ['user'] },
      },
      signal(),
    )
    expect(result.block).toEqual({
      kind: 'text_resource',
      uri: 'file:///a',
      mime: 'text/plain',
      text,
    })
    expect(
      JSON.parse(Buffer.from(store.put.mock.calls[0]![0].bytes).toString()),
    ).toEqual({
      annotations: { audience: ['user'] },
      resource: { extension: { exact: true } },
    })
    const link = await content.block(
      owner(),
      {
        type: 'resource_link',
        uri: 'x:test',
        name: 'name',
        title: 'title',
        description: 'description',
        mimeType: 'image/png',
        size: 0,
      },
      signal(),
    )
    expect(link.block).toEqual({
      kind: 'resource_link',
      uri: 'x:test',
      name: 'name',
      title: 'title',
      description: 'description',
      mime: 'image/png',
      size: 0,
    })
    await content.block(
      owner(),
      { ...image, annotations: { priority: 0 } },
      signal(),
    )
    expect(
      JSON.parse(Buffer.from(store.put.mock.calls[2]![0].bytes).toString()),
    ).toEqual({ annotations: { priority: 0 } })
    await content.close()
  })
  it('stores replay blobs under their exact load owner', async () => {
    const { content, store } = setup()
    const subject = owner()
    const {
      runId: _run,
      turnId: _turn,
      ...base
    } = subject.owner as Extract<AcpContentOwner['owner'], { phase: 'live' }>
    const replay: AcpContentOwner = {
      ...subject,
      owner: {
        ...base,
        phase: 'load_replay',
        loadId: 'load',
        requestedNativeSessionId: 'native',
      },
    }
    const result = await content.block(
      replay,
      { type: 'resource', resource: { uri: 'blob:a', blob: 'AA==' } },
      signal(),
    )
    expect(result.block).toMatchObject({
      kind: 'artifact_resource',
      mime: 'application/octet-stream',
      bytes: 1,
    })
    expect(store.put.mock.calls[0]![0]).toMatchObject({
      owner: replay,
      purpose: 'replay',
    })
    await content.close()
  })
  it.each(['a', 'a===', 'aG VsbG8=', 'aGVsbG9='])(
    'rejects invalid base64 %s before storage',
    async (data) => {
      const { content, store } = setup()
      await expect(
        content.block(owner(), { ...image, data }, signal()),
      ).rejects.toThrow('base64')
      expect(store.put).not.toHaveBeenCalled()
      await content.close()
    },
  )
  it('rejects text blocks, unsafe metadata, oversized UTF8 and foreign ownership before storage', async () => {
    const { content, store } = setup()
    await expect(
      content.block(owner(), { type: 'text', text: 'hello' }, signal()),
    ).rejects.toThrow('Unsupported')
    await expect(
      content.source(
        owner(),
        {
          get value() {
            throw Error('getter executed')
          },
        },
        signal(),
      ),
    ).rejects.toThrow('accessor')
    await expect(
      content.block(
        owner(),
        { type: 'resource', resource: { uri: 'a', text: 'α'.repeat(524289) } },
        signal(),
      ),
    ).rejects.toThrow('string')
    const foreign = owner()
    Object.assign(foreign.owner, { providerInstanceId: 'other' })
    await expect(content.block(foreign, image, signal())).rejects.toThrow(
      'Foreign',
    )
    expect(store.put).not.toHaveBeenCalled()
    await content.close()
  })
  it.each(['mime', 'bytes', 'sha256', 'extra'])(
    'discards an invalid %s acknowledgement under its original owner',
    async (field) => {
      const { content, store } = setup(async (input) => ({
        ...ack(input),
        [field]: 'wrong',
      }))
      await expect(content.block(owner(), image, signal())).rejects.toThrow()
      expect(store.discard).toHaveBeenCalledWith('artifact', owner())
      await content.close()
    },
  )
  it('retains physical capacity across aborted late put and failed discard until explicit retry', async () => {
    const pending = deferred<ReturnType<typeof ack>>()
    const { content, store, host } = setup(() => pending.promise)
    const controller = new AbortController(),
      subject = owner()
    const task = content.block(subject, image, controller.signal)
    const rejected = expect(task).rejects.toThrow('cancelled')
    Object.assign(subject, { itemId: 'changed' })
    Object.assign(subject.owner, { runId: 'changed' })
    controller.abort()
    await rejected
    const remaining = host.reserve('provider', 'artifacts', 7)
    expect(() => host.reserve('provider', 'artifacts')).toThrow('limit')
    store.discard.mockRejectedValueOnce(Error('disk failed'))
    pending.resolve(ack(store.put.mock.calls[0]![0]))
    await vi.waitFor(() => expect(store.discard).toHaveBeenCalledTimes(1))
    expect(store.discard).toHaveBeenCalledWith('artifact', owner())
    expect(() => host.reserve('provider', 'artifacts')).toThrow('limit')
    await content.retryCleanup()
    const release = host.reserve('provider', 'artifacts')
    release()
    remaining()
    await content.close()
  })
  it('rejects a third active session write and waits for original physical puts on close', async () => {
    const pending = deferred<ReturnType<typeof ack>>()
    const { content, store } = setup(() => pending.promise)
    const first = content
      .block(owner(), image, signal())
      .catch((error: Error) => error.message)
    const second = content
      .block(owner(), image, signal())
      .catch((error: Error) => error.message)
    await expect(content.block(owner(), image, signal())).rejects.toThrow(
      'session artifact limit',
    )
    let settled = false
    const closing = content.close().then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    pending.resolve(ack(store.put.mock.calls[0]![0]))
    await closing
    expect(await first).toContain('cancelled')
    expect(await second).toContain('cancelled')
    expect(store.discard).toHaveBeenCalledTimes(2)
  })
})
