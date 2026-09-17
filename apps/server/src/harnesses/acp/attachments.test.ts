import { NativeCleanupError } from '../native-cleanup.js'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  createAcpAttachments,
  type AuthorizedAcpAttachment,
} from './attachments.js'
import { AcpResourceHost } from './limits.js'

const MiB = 1024 * 1024
const capabilities = { image: true, audio: true, embeddedContext: true }
const input = (attachmentId = 'file', mime = 'image/png') => ({
  type: 'attachment' as const,
  attachmentId,
  mime,
})
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function attachment(
  id = 'file',
  mime = 'image/png',
  bytes = Uint8Array.from([1, 2, 3]),
): AuthorizedAcpAttachment {
  return {
    sessionId: 'session',
    attachmentId: id,
    mime,
    size: bytes.byteLength,
    status: 'ready',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    uri: `attachment:${id}`,
    reader: {
      read: vi.fn(async () => ({ bytes, eof: true })),
      close: vi.fn(async () => {}),
    },
  }
}
const signal = () => new AbortController().signal
afterEach(() => vi.useRealTimers())

describe('ACP authorized input attachments', () => {
  test.each(['mime', 'read'] as const)(
    'rejects a %s accessor without invoking it and closes the original reader',
    async (key) => {
      const file = attachment(),
        original = file.reader
      let getters = 0
      Object.defineProperty(key === 'read' ? original : file, key, {
        enumerable: true,
        get() {
          getters++
          throw Error('getter ran')
        },
      })
      const helper = createAcpAttachments({
        host: new AcpResourceHost(),
        instanceId: 'instance',
        authorizedAttachment: async () => file,
      })
      await expect(
        helper.prepare('session', [input()], capabilities, signal()),
      ).rejects.toThrow(/accessor/)
      await helper.close()
      expect(getters).toBe(0)
      expect(original.close).toHaveBeenCalledTimes(1)
    },
  )
  test.each(['reader', 'close'] as const)(
    'retains unresolved reader ownership for an inaccessible %s descriptor',
    async (key) => {
      const file = attachment(),
        original = file.reader
      const host = new AcpResourceHost({ attachments: [1, 1] })
      let getters = 0
      Object.defineProperty(key === 'reader' ? file : original, key, {
        enumerable: true,
        get() {
          getters++
          return key === 'reader' ? original : async () => {}
        },
      })
      const helper = createAcpAttachments({
        host,
        instanceId: 'instance',
        authorizedAttachment: async () => file,
      })
      await expect(
        helper.prepare('session', [input()], capabilities, signal()),
      ).rejects.toThrow('reader')
      await expect(helper.close()).rejects.toThrow(
        'reader identity unavailable',
      )
      expect(getters).toBe(0)
      expect(original.read).not.toHaveBeenCalled()
      expect(() => host.reserve('replacement', 'attachments')).toThrow(
        'resource limit',
      )
    },
  )
  test('close settles pending prepare before its original read or reader close is released', async () => {
    const file = attachment(),
      heldRead = deferred<{ bytes: Uint8Array; eof: boolean }>(),
      heldClose = deferred<void>(),
      reading = deferred<void>(),
      closing = deferred<void>()
    const host = new AcpResourceHost({ attachments: [1, 1] })
    file.reader.read = () => {
      reading.resolve()
      return heldRead.promise
    }
    file.reader.close = () => {
      closing.resolve()
      return heldClose.promise
    }
    const helper = createAcpAttachments({
      host,
      instanceId: 'instance',
      authorizedAttachment: async () => file,
    })
    const pending = helper.prepare('session', [input()], capabilities, signal())
    const rejected = expect(pending).rejects.toThrow('released')
    await reading.promise
    const cleanup = helper.close()
    await rejected
    expect(() => host.reserve('replacement', 'attachments')).toThrow(
      'resource limit',
    )
    heldRead.resolve({ bytes: Uint8Array.from([1, 2, 3]), eof: true })
    await closing.promise
    expect(() => host.reserve('replacement', 'attachments')).toThrow(
      'resource limit',
    )
    heldClose.resolve()
    await cleanup
    host.reserve('replacement', 'attachments')()
  })
  test('retains a pending reader close after its logical deadline', async () => {
    vi.useFakeTimers()
    const host = new AcpResourceHost({ attachments: [1, 1] })
    const held = deferred<void>(),
      started = deferred<void>()
    const file = attachment()
    file.reader.close = () => {
      started.resolve()
      return held.promise
    }
    const helper = createAcpAttachments({
      host,
      instanceId: 'instance',
      authorizedAttachment: async () => file,
      limits: { deadlineMs: 20 },
    })
    const result = helper.prepare('session', [input()], capabilities, signal())
    const failed = expect(result).rejects.toThrow('deadline')
    await started.promise
    await vi.advanceTimersByTimeAsync(20)
    await failed
    expect(() => host.reserve('replacement', 'attachments')).toThrow(
      'resource limit',
    )
    held.resolve()
    await helper.close()
    host.reserve('replacement', 'attachments')()
  })
  test('registers original resolver ownership before synchronous close reentry', async () => {
    const file = attachment()
    let closing: Promise<void> | undefined
    const helper = createAcpAttachments({
      host: new AcpResourceHost(),
      instanceId: 'instance',
      authorizedAttachment: async () => {
        closing = helper.close()
        return file
      },
    })
    await expect(
      helper.prepare('session', [input()], capabilities, signal()),
    ).rejects.toThrow('released')
    await closing
    expect(file.reader.read).not.toHaveBeenCalled()
    expect(file.reader.close).toHaveBeenCalledTimes(1)
  })
  test('copies a pooled byte view before external close can mutate it', async () => {
    const pooled = new Uint8Array(8192)
    pooled.set([1, 2, 3], 12)
    const file = attachment('file', 'image/png', pooled.subarray(12, 15))
    file.reader.close = async () => {
      pooled.fill(9)
    }
    const helper = createAcpAttachments({
      host: new AcpResourceHost(),
      instanceId: 'instance',
      authorizedAttachment: async () => file,
    })
    const prepared = await helper.prepare(
      'session',
      [input()],
      capabilities,
      signal(),
    )
    expect(prepared.blocks[0]).toMatchObject({ data: 'AQID' })
    await prepared.release()
    await helper.close()
  })
  test('keeps mixed content order, exact bytes and authorized resource URIs', async () => {
    const files = [
      attachment(),
      attachment('sound', 'audio/wav'),
      attachment('blob', 'application/pdf'),
    ]
    const resolver = vi.fn(async (_session, id) =>
      files.find((file) => file.attachmentId === id)!,
    )
    const helper = createAcpAttachments({
      host: new AcpResourceHost(),
      instanceId: 'instance',
      authorizedAttachment: resolver,
    })
    const prepared = await helper.prepare(
      'session',
      [
        { type: 'text', text: 'before' },
        input(),
        { type: 'text', text: 'between' },
        input('sound', 'audio/wav'),
        input('blob', 'application/pdf'),
        {
          type: 'review_reference',
          url: 'https://example.test/review',
          title: 'Review',
        },
      ],
      capabilities,
      signal(),
    )
    expect(prepared.blocks).toEqual([
      { type: 'text', text: 'before' },
      { type: 'image', mimeType: 'image/png', data: 'AQID' },
      { type: 'text', text: 'between' },
      { type: 'audio', mimeType: 'audio/wav', data: 'AQID' },
      {
        type: 'resource',
        resource: {
          uri: 'attachment:blob',
          mimeType: 'application/pdf',
          blob: 'AQID',
        },
      },
      {
        type: 'resource_link',
        uri: 'https://example.test/review',
        name: 'Review',
      },
    ])
    expect(resolver.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ['session', 'file'],
      ['session', 'sound'],
      ['session', 'blob'],
    ])
    for (const file of files) expect(file.reader.close).toHaveBeenCalledTimes(1)
    await prepared.release()
    await helper.close()
  })
  test.each(['sessionId', 'attachmentId', 'status', 'mime', 'sha256'] as const)(
    'rejects mismatched %s and closes the original reader',
    async (key) => {
      const file = attachment()
      Object.assign(file, { [key]: 'wrong' })
      const helper = createAcpAttachments({
        host: new AcpResourceHost(),
        instanceId: 'instance',
        authorizedAttachment: async () => file,
      })
      await expect(
        helper.prepare('session', [input()], capabilities, signal()),
      ).rejects.toThrow('authorization')
      expect(file.reader.close).toHaveBeenCalledTimes(1)
      await helper.close()
    },
  )
  test.each(['size', 'eof', 'digest'])(
    'rejects wrong %s after reading',
    async (kind) => {
      const file = attachment()
      if (kind === 'size') file.size += 1
      if (kind === 'digest') file.sha256 = '0'.repeat(64)
      if (kind === 'eof')
        file.reader.read = vi.fn(async () => ({
          bytes: Uint8Array.from([1, 2, 3]),
          eof: false,
        }))
      const helper = createAcpAttachments({
        host: new AcpResourceHost(),
        instanceId: 'instance',
        authorizedAttachment: async () => file,
      })
      await expect(
        helper.prepare('session', [input()], capabilities, signal()),
      ).rejects.toThrow(/mismatch/)
      expect(file.reader.close).toHaveBeenCalledTimes(1)
      await helper.close()
    },
  )
  test('rejects capabilities before resolution', () => {
    const resolver = vi.fn()
    const helper = createAcpAttachments({
      host: new AcpResourceHost(),
      instanceId: 'instance',
      authorizedAttachment: resolver,
    })
    for (const mime of ['image/png', 'audio/wav', 'application/pdf'])
      expect(() =>
        helper.prepare('session', [input('file', mime)], {}, signal()),
      ).toThrow('capability')
    expect(resolver).not.toHaveBeenCalled()
  })
  test('supports 8 MiB plus 2 MiB decoded input and rejects one byte over the turn limit', async () => {
    const first = attachment('first', 'image/png', new Uint8Array(8 * MiB))
    const second = attachment('second', 'image/png', new Uint8Array(2 * MiB))
    const helper = createAcpAttachments({
      host: new AcpResourceHost(),
      instanceId: 'instance',
      authorizedAttachment: async (_, id) => (id === 'first' ? first : second),
    })
    const prepared = await helper.prepare(
      'session',
      [input('first'), input('second')],
      capabilities,
      signal(),
    )
    expect(
      prepared.blocks.map(
        (block) =>
          block.type === 'image' &&
          Buffer.from(block.data, 'base64').byteLength,
      ),
    ).toEqual([8 * MiB, 2 * MiB])
    await prepared.release()
    second.size += 1
    await expect(
      helper.prepare(
        'session',
        [input('first'), input('second')],
        capabilities,
        signal(),
      ),
    ).rejects.toThrow('decoded input')
    await helper.close()
  })
  test('bounds actual JSON escaping, not only raw text bytes', async () => {
    const helper = createAcpAttachments({
      host: new AcpResourceHost(),
      instanceId: 'instance',
      authorizedAttachment: vi.fn(),
      limits: { frameBytes: 10_000 },
    })
    await expect(
      helper.prepare('session', '\u0000'.repeat(1000), capabilities, signal()),
    ).rejects.toThrow('frame limit')
    const prepared = await helper.prepare(
      'session',
      'x'.repeat(1000),
      capabilities,
      signal(),
    )
    await prepared.release()
    await helper.close()
  })
  test('retains resolver capacity through timeout and closes a late reader without reading', async () => {
    vi.useFakeTimers()
    const host = new AcpResourceHost({ attachments: [1, 1] })
    const pending = deferred<AuthorizedAcpAttachment>()
    const started = deferred<void>()
    const helper = createAcpAttachments({
      host,
      instanceId: 'instance',
      authorizedAttachment: () => {
        started.resolve()
        return pending.promise
      },
      limits: { deadlineMs: 20 },
    })
    const result = helper.prepare('session', [input()], capabilities, signal())
    const failed = expect(result).rejects.toThrow('deadline')
    await started.promise
    await vi.advanceTimersByTimeAsync(20)
    await failed
    expect(() => host.reserve('replacement', 'attachments')).toThrow(
      'resource limit',
    )
    const file = attachment()
    pending.resolve(file)
    await helper.close()
    expect(file.reader.read).not.toHaveBeenCalled()
    expect(file.reader.close).toHaveBeenCalledTimes(1)
    host.reserve('replacement', 'attachments')()
  })
  test('retains a held read after cancellation and forbids late output', async () => {
    const host = new AcpResourceHost({ attachments: [1, 1] })
    const pending = deferred<{ bytes: Uint8Array; eof: boolean }>()
    const started = deferred<void>()
    const file = attachment()
    file.reader.read = () => {
      started.resolve()
      return pending.promise
    }
    const controller = new AbortController()
    const helper = createAcpAttachments({
      host,
      instanceId: 'instance',
      authorizedAttachment: async () => file,
    })
    const result = helper.prepare(
      'session',
      [input()],
      capabilities,
      controller.signal,
    )
    const failed = expect(result).rejects.toThrow('cancel')
    await started.promise
    controller.abort(Error('cancel'))
    await failed
    expect(() => host.reserve('replacement', 'attachments')).toThrow(
      'resource limit',
    )
    expect(file.reader.close).not.toHaveBeenCalled()
    pending.resolve({ bytes: Uint8Array.from([1, 2, 3]), eof: true })
    await helper.close()
    expect(file.reader.close).toHaveBeenCalledTimes(1)
    host.reserve('replacement', 'attachments')()
  })
  test('retains refused reader cleanup and retries only that original reader', async () => {
    const host = new AcpResourceHost({ attachments: [1, 1] })
    const file = attachment()
    let refuse = true
    file.reader.close = vi.fn(async () => {
      if (refuse) throw Error('held cleanup')
    })
    const resolver = vi.fn(async () => file)
    const helper = createAcpAttachments({
      host,
      instanceId: 'instance',
      authorizedAttachment: resolver,
    })
    await expect(
      helper.prepare('session', [input()], capabilities, signal()),
    ).rejects.toThrow('held cleanup')
    await expect(helper.close()).rejects.toThrow('held cleanup')
    expect(() => host.reserve('replacement', 'attachments')).toThrow(
      'resource limit',
    )
    refuse = false
    await helper.close()
    expect(resolver).toHaveBeenCalledTimes(1)
    expect(file.reader.read).toHaveBeenCalledTimes(1)
    host.reserve('replacement', 'attachments')()
  })
  test('captures input before waiting and releases prepared bytes only on explicit release', async () => {
    const host = new AcpResourceHost({ attachments: [1, 1] })
    const pending = deferred<AuthorizedAcpAttachment>()
    const helper = createAcpAttachments({
      host,
      instanceId: 'instance',
      authorizedAttachment: () => pending.promise,
    })
    const parts = [input()]
    const result = helper.prepare('session', parts, capabilities, signal())
    parts[0]!.attachmentId = 'foreign'
    pending.resolve(attachment())
    const prepared = await result
    expect(() => host.reserve('replacement', 'attachments')).toThrow(
      'resource limit',
    )
    await prepared.release()
    host.reserve('replacement', 'attachments')()
    await helper.close()
  })
  test('holds only two operations per session and shares host capacity across factories', async () => {
    const host = new AcpResourceHost({ attachments: [3, 3] })
    const make = () =>
      createAcpAttachments({
        host,
        instanceId: 'instance',
        authorizedAttachment: vi.fn(),
      })
    const first = make(),
      second = make()
    const a = await first.prepare('session', 'a', capabilities, signal())
    const b = await first.prepare('session', 'b', capabilities, signal())
    expect(() => first.prepare('session', 'c', capabilities, signal())).toThrow(
      'session attachment limit',
    )
    const c = await second.prepare('other', 'c', capabilities, signal())
    expect(() => second.prepare('third', 'd', capabilities, signal())).toThrow(
      'resource limit',
    )
    await Promise.all([a.release(), b.release(), c.release()])
    await Promise.all([first.close(), second.close()])
  })
})

test.each(['held', 'refused'] as const)(
  'retains metadata cleanup ownership before a reader exists: %s',
  async (mode) => {
    const held = deferred<void>()
    const cleanup = vi.fn(async () => {
      await held.promise
      if (mode === 'refused' && cleanup.mock.calls.length === 1)
        throw Error('original cleanup refused')
    })
    const failure = new NativeCleanupError(cleanup)
    const host = new AcpResourceHost({ attachments: [1, 1] })
    const helper = createAcpAttachments({
      host,
      instanceId: 'instance',
      authorizedAttachment: async () => {
        throw failure
      },
    })
    await expect(
      helper.prepare('session', [input()], capabilities, signal()),
    ).rejects.toBe(failure)
    expect(() => host.reserve('instance', 'attachments')).toThrow(
      'ACP resource limit',
    )
    const close = helper.close()
    expect(helper.close()).toBe(close)
    const observed = close.catch((error) => error)
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1))
    expect(() => host.reserve('instance', 'attachments')).toThrow(
      'ACP resource limit',
    )
    held.resolve()
    const result = await observed
    if (mode === 'refused') {
      expect(result).toBe(failure)
      expect(() => host.reserve('instance', 'attachments')).toThrow(
        'ACP resource limit',
      )
      await helper.close()
      expect(cleanup).toHaveBeenCalledTimes(2)
    } else expect(result).toBeUndefined()
    host.reserve('instance', 'attachments')()
    host.reserve('instance', 'retained', 128 * MiB)()
  },
)
