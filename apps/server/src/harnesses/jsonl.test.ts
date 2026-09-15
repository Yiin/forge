import { getEventListeners } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import { JsonlTransport } from './jsonl.js'
import { JsonlRpcTransport, type JsonRpcRequest } from './jsonrpc.js'
import {
  bytePayload,
  deferred,
  startFixture,
} from './transport-test-helpers.js'

function streams() {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const writes: unknown[] = []
  stdin.on('data', (chunk) => writes.push(JSON.parse(String(chunk))))
  return { stdin, stdout, writes }
}
function rpcStreams(
  options: Partial<ConstructorParameters<typeof JsonlRpcTransport>[0]> = {},
) {
  const io = streams()
  const transport = new JsonlRpcTransport({
    ...io,
    runtimeGeneration: 'run-1',
    ...options,
  })
  return { ...io, transport }
}
const frame = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`)

class SlowWriter extends Writable {
  readonly writes: Buffer[] = []
  readonly callbacks: ((error?: Error | null) => void)[] = []
  constructor() {
    super({ highWaterMark: 1 })
  }
  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.writes.push(chunk)
    this.callbacks.push(callback)
  }
  release(error?: Error) {
    this.callbacks.shift()!(error)
  }
}

describe('owned JSONL byte streams', () => {
  it('runs fake executables with Node production semantics', () => {
    expect(process.release.name).toBe('node')
    expect(process.platform).toBe('linux')
  })

  it('keeps split multibyte UTF-8, multiframe chunks, and a partial next frame', async () => {
    const seen: unknown[] = []
    const bytes = Buffer.from(
      '{"text":"café 😀  "}\r\n\n  \r\n{"n":2}\n{"n":3}',
    )
    const split = bytes.indexOf(Buffer.from('é')) + 1
    const { process: runtime, value: wire } = await startFixture(
      'bytes',
      async (runtime) => {
        const wire = new JsonlTransport({
          stdin: runtime.child.stdin,
          stdout: runtime.child.stdout,
          onValue: (value) => {
            seen.push(value)
          },
        })
        runtime.ownTransport(wire)
        return wire
      },
      {},
      bytePayload([
        bytes.subarray(0, split),
        bytes.subarray(split, bytes.length - 2),
        bytes.subarray(bytes.length - 2),
      ]),
    )
    expect((await wire.done).message).toContain('ended')
    expect(seen).toEqual([{ text: 'café 😀  ' }, { n: 2 }, { n: 3 }])
    await runtime.done
  })

  it.each([
    ['invalid UTF-8', [Buffer.from([0xff, 10])], 'UTF-8'],
    ['truncated UTF-8 at EOF', [Buffer.from([0xc3])], 'UTF-8'],
    [
      'oversized terminated line',
      [Buffer.from('x'.repeat(129) + '\n')],
      'exceeds limit',
    ],
    [
      'oversized unfinished line',
      [Buffer.from('x'.repeat(129))],
      'exceeds limit',
    ],
    [
      'oversized partial next line',
      [Buffer.from('{}\n' + 'x'.repeat(129))],
      'exceeds limit',
    ],
    ['invalid JSON', [Buffer.from('{raw-secret}\n')], 'Malformed'],
    ['invalid final JSON', [Buffer.from('{raw-secret')], 'Malformed'],
  ])('fails %s without disclosing payloads', async (_name, chunks, error) => {
    const { process: runtime, value: wire } = await startFixture(
      'bytes',
      async (runtime) => {
        const wire = new JsonlTransport({
          stdin: runtime.child.stdin,
          stdout: runtime.child.stdout,
          maxLineBytes: 128,
          onValue: () => {},
        })
        runtime.ownTransport(wire)
        return wire
      },
      {},
      bytePayload(chunks as Buffer[]),
    )
    const reason = await wire.done
    expect(reason.message).toContain(error)
    expect(reason.message).not.toContain('raw-secret')
    expect(wire.state).toEqual({
      bufferedBytes: 0,
      queuedBytes: 0,
      queuedFrames: 0,
    })
    await runtime.done
  })

  it('accepts provider records without a JSON-RPC envelope', async () => {
    const values: unknown[] = []
    const { value: wire } = await startFixture(
      'bytes',
      async (runtime) => {
        const wire = new JsonlTransport({
          stdin: runtime.child.stdin,
          stdout: runtime.child.stdout,
          onValue: (value) => {
            values.push(value)
          },
        })
        runtime.ownTransport(wire)
        return wire
      },
      {},
      bytePayload([frame({ type: 'response', id: 'pi-1', success: true })]),
    )
    await wire.done
    expect(values).toEqual([{ type: 'response', id: 'pi-1', success: true }])
  })
})

describe('JSONL writes', () => {
  it('skips serialization when the frame queue is already full', async () => {
    const stdin = new SlowWriter()
    const wire = new JsonlTransport({
      stdin,
      stdout: new PassThrough(),
      maxQueuedFrames: 1,
      onValue: () => {},
    })
    const first = wire.send(1).catch(() => {})
    const toJSON = vi.fn(() => ({ value: 2 }))
    try {
      await expect(wire.send({ toJSON })).rejects.toThrow('queue is full')
      expect(toJSON).not.toHaveBeenCalled()
    } finally {
      await wire.close()
      await first
    }
  })

  it.each(['line', 'queue'])(
    'rejects oversized %s bytes before Buffer allocation',
    async (limit) => {
      const io = streams()
      const wire = new JsonlTransport({
        ...io,
        maxLineBytes: limit === 'line' ? 128 : 32 * 1024 * 1024,
        maxQueuedBytes: 128,
        onValue: () => {},
      })
      const value = 'x'.repeat(16 * 1024 * 1024)
      const from = vi.spyOn(Buffer, 'from')
      try {
        const sent = wire.send(value)
        const allocations = from.mock.calls.slice()
        from.mockRestore()
        await expect(sent).rejects.toThrow(
          limit === 'line' ? 'exceeds limit' : 'queue is full',
        )
        expect(allocations).toEqual([])
        expect(wire.state.queuedFrames).toBe(0)
        expect(io.writes).toEqual([])
      } finally {
        from.mockRestore()
        await wire.close()
      }
    },
  )

  it.each(['cancel', 'close', 'end'])(
    'rechecks %s after user serialization',
    async (action) => {
      const io = streams()
      const wire = new JsonlTransport({ ...io, onValue: () => {} })
      const controller = new AbortController()
      const outcome = wire
        .send(
          {
            toJSON() {
              if (action === 'cancel') controller.abort()
              else if (action === 'close') void wire.close()
              else io.stdin.end()
              return { never: 'write' }
            },
          },
          { signal: controller.signal },
        )
        .then(
          () => 'sent',
          (error: Error) => error.message,
        )
      try {
        expect(wire.state.queuedFrames).toBe(0)
        expect(await outcome).toMatch(/cancelled|closed/)
        expect(io.writes).toEqual([])
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
      } finally {
        await wire.close()
        await outcome
      }
    },
  )

  it('rechecks capacity after a reentrant send during serialization', async () => {
    const stdin = new SlowWriter()
    const wire = new JsonlTransport({
      stdin,
      stdout: new PassThrough(),
      maxQueuedFrames: 1,
      onValue: () => {},
    })
    let nested: Promise<void> | undefined
    try {
      await expect(
        wire.send({
          toJSON() {
            nested = wire.send(1).catch(() => {})
            return 2
          },
        }),
      ).rejects.toThrow('queue is full')
      expect(wire.state.queuedFrames).toBe(1)
      expect(stdin.writes.map(String)).toEqual(['1\n'])
    } finally {
      await wire.close()
      await nested
    }
  })

  it('honors write(false), delayed drain, and callbacks before the next write', async () => {
    const stdin = new SlowWriter()
    const stdout = new PassThrough()
    const wire = new JsonlTransport({ stdin, stdout, onValue: () => {} })
    try {
      let complete = 0
      const first = wire.send({ n: 1 }).then(() => {
        complete++
      })
      const second = wire.send({ n: 2 }).then(() => {
        complete++
      })
      await delay(10)
      expect(stdin.writes).toHaveLength(1)
      expect(complete).toBe(0)
      stdin.release()
      await first
      expect(stdin.writes).toHaveLength(2)
      stdin.release()
      await second
      expect(complete).toBe(2)
      expect(wire.state.queuedBytes).toBe(0)
      expect(stdin.listenerCount('drain')).toBe(0)
    } finally {
      await wire.close()
    }
  })

  it('settles failed and queued writes when asynchronous EPIPE arrives with stdout open', async () => {
    const stdin = new SlowWriter()
    const stdout = new PassThrough()
    const wire = new JsonlTransport({ stdin, stdout, onValue: () => {} })
    const first = wire.send({ n: 1 }).catch((error: Error) => error.message)
    const second = wire.send({ n: 2 }).catch((error: Error) => error.message)
    expect(stdout.readableEnded).toBe(false)
    stdin.release(
      Object.assign(new Error('EPIPE raw-secret'), { code: 'EPIPE' }),
    )
    expect(await first).toContain('write failed')
    expect(await second).toContain('write failed')
    await wire.done
    await delay(0)
    expect(stdin.listenerCount('drain')).toBe(0)
    expect(stdin.listenerCount('error')).toBe(0)
    expect(stdout.listenerCount('error')).toBe(0)
  })

  it('gets EPIPE from an owned child that keeps stdout open', async () => {
    const ready = deferred<void>()
    const { process: runtime, value: wire } = await startFixture(
      'epipe',
      async (runtime) => {
        const wire = new JsonlTransport({
          stdin: runtime.child.stdin,
          stdout: runtime.child.stdout,
          onValue: () => ready.resolve(),
        })
        runtime.ownTransport(wire)
        await ready.promise
        return wire
      },
    )
    expect(runtime.child.stdout.readableEnded).toBe(false)
    await expect(wire.send({ n: 1 })).rejects.toThrow('write failed')
    await runtime.done
  })

  it('bounds queued bytes and frames without retaining rejected writes', async () => {
    const stdin = new SlowWriter()
    const wire = new JsonlTransport({
      stdin,
      stdout: new PassThrough(),
      maxQueuedFrames: 2,
      maxQueuedBytes: 16,
      onValue: () => {},
    })
    const first = wire.send(1).catch(() => {})
    const second = wire.send(2).catch(() => {})
    await expect(wire.send(3)).rejects.toThrow('queue is full')
    expect(wire.state).toMatchObject({ queuedFrames: 2, queuedBytes: 4 })
    await wire.close()
    await Promise.all([first, second])
    const other = new JsonlTransport({
      stdin: new SlowWriter(),
      stdout: new PassThrough(),
      maxQueuedBytes: 3,
      onValue: () => {},
    })
    await expect(other.send('too large')).rejects.toThrow('queue is full')
    expect(other.state.queuedFrames).toBe(0)
    await other.close()
  })

  it('waits for the write callback even if drain arrives first', async () => {
    const stdin = new SlowWriter()
    const wire = new JsonlTransport({
      stdin,
      stdout: new PassThrough(),
      onValue: () => {},
    })
    let done = false
    const write = wire.send(1).then(() => {
      done = true
    })
    stdin.emit('drain')
    await delay(0)
    expect(done).toBe(false)
    stdin.release()
    await write
    await wire.close()
  })

  it('cleans listeners when streams have already closed', async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    stdin.destroy()
    stdout.destroy()
    await delay(0)
    const wire = new JsonlTransport({ stdin, stdout, onValue: () => {} })
    await wire.done
    expect(stdin.listenerCount('error')).toBe(0)
    expect(stdout.listenerCount('error')).toBe(0)
    expect(stdin.listenerCount('close')).toBe(0)
    expect(stdout.listenerCount('close')).toBe(0)
  })

  it('fails an async raw-frame callback without leaving a rejected promise', async () => {
    const io = streams()
    const wire = new JsonlTransport({
      ...io,
      onValue: async () => {
        throw new Error('raw payload')
      },
    })
    io.stdout.write(frame({ event: 'test' }))
    expect((await wire.done).message).toContain('must be synchronous')
  })

  it('rejects unserializable values without writing protocol noise', async () => {
    const io = streams()
    const wire = new JsonlTransport({ ...io, onValue: () => {} })
    try {
      await expect(wire.send(1n)).rejects.toThrow('Cannot encode')
      await expect(wire.send(undefined)).rejects.toThrow('Cannot encode')
      expect(io.writes).toEqual([])
    } finally {
      await wire.close()
    }
  })
})

describe.each(['standard', 'unversioned'] as const)(
  'JSON-RPC routing (%s)',
  (wireProfile) => {
    const rpc = (
      options: Partial<ConstructorParameters<typeof JsonlRpcTransport>[0]> = {},
    ) => rpcStreams({ wireProfile, ...options })
    const frame = (value: unknown) => {
      if (
        wireProfile === 'unversioned' &&
        value &&
        typeof value === 'object' &&
        'jsonrpc' in value &&
        value.jsonrpc === '2.0'
      ) {
        const { jsonrpc: _version, ...envelope } = value
        return Buffer.from(`${JSON.stringify(envelope)}\n`)
      }
      return Buffer.from(`${JSON.stringify(value)}\n`)
    }
    const fixtureMode =
      wireProfile === 'unversioned' ? 'rpc-unversioned' : 'rpc'

    it.each(['result', 'error'])(
      'rejects a late %s before the timer callback runs',
      async (kind) => {
        const io = rpc()
        const controller = new AbortController()
        const request = io.transport.request('deadline', undefined, {
          timeoutMs: 10,
          signal: controller.signal,
        })
        const assertion = expect(request).rejects.toThrow('timed out')
        const id = (io.writes[0] as { id: string }).id
        const until = performance.now() + 30
        while (performance.now() < until) {
          /* Delay timer delivery. */
        }
        io.stdout.write(
          frame({
            jsonrpc: '2.0',
            id,
            ...(kind === 'result'
              ? { result: 'late' }
              : { error: { code: -1, message: 'late' } }),
          }),
        )
        try {
          await assertion
          expect(io.transport.state.pendingRequests).toBe(0)
          expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
        } finally {
          await io.transport.close()
        }
      },
    )

    it('rejects an expired queued request before starting its write', async () => {
      const stdin = new SlowWriter()
      const io = rpc({ stdin })
      const active = io.transport.notify('active').catch(() => {})
      const request = io.transport.request('expired', undefined, {
        timeoutMs: 10,
      })
      const assertion = expect(request).rejects.toThrow('timed out')
      const until = performance.now() + 30
      while (performance.now() < until) {
        /* Delay timer delivery. */
      }
      stdin.release()
      try {
        await active
        await assertion
        expect(stdin.writes).toHaveLength(1)
        expect(io.transport.state).toMatchObject({
          queuedBytes: 0,
          queuedFrames: 0,
          pendingRequests: 0,
        })
      } finally {
        await io.transport.close()
      }
    })

    it('rejects a request whose serialization consumes its deadline', async () => {
      const io = rpc()
      try {
        await expect(
          io.transport.request(
            'expired',
            {
              toJSON() {
                const until = performance.now() + 30
                while (performance.now() < until) {
                  /* Delay timer delivery. */
                }
                return {}
              },
            },
            { timeoutMs: 10 },
          ),
        ).rejects.toThrow('timed out')
        expect(io.writes).toEqual([])
        expect(io.transport.state.pendingRequests).toBe(0)
      } finally {
        await io.transport.close()
      }
    })

    it.each([undefined, () => {}, { toJSON: () => undefined }])(
      'keeps the request handle after an omitted serialized result: %j',
      async (result) => {
        const received: JsonRpcRequest[] = []
        const io = rpc({
          onIncoming: (message) => {
            if (message.type === 'request') received.push(message)
          },
        })
        try {
          io.stdout.write(frame({ jsonrpc: '2.0', id: 1, method: 'ask' }))
          await expect(
            io.transport.respond(received[0]!, result),
          ).rejects.toThrow('envelope')
          expect(io.transport.state.incomingRequests).toBe(1)
          expect(io.writes).toEqual([])
          await io.transport.respond(received[0]!, null)
          expect(io.writes).toHaveLength(1)
          expect(io.transport.state.incomingRequests).toBe(0)
        } finally {
          await io.transport.close()
        }
      },
    )

    it.each([
      null,
      1,
      'secret',
      { toJSON: () => null },
      { toJSON: () => 'secret' },
    ])('validates actual serialized params: %j', async (params) => {
      const io = rpc()
      try {
        await expect(io.transport.notify('invalid', params)).rejects.toThrow(
          'envelope',
        )
        await expect(io.transport.request('invalid', params)).rejects.toThrow(
          'envelope',
        )
        expect(io.writes).toEqual([])
        expect(io.transport.state.pendingRequests).toBe(0)
        await io.transport.notify('valid', { toJSON: () => [] })
        expect(io.writes).toHaveLength(1)
      } finally {
        await io.transport.close()
      }
    })

    it('keeps 300 notifications flowing while an incoming request awaits a nested RPC', async () => {
      let notifications = 0
      let transport!: JsonlRpcTransport
      const { value } = await startFixture(fixtureMode, async (runtime) => {
        transport = new JsonlRpcTransport({
          wireProfile,
          stdin: runtime.child.stdin,
          stdout: runtime.child.stdout,
          runtimeGeneration: 'generation-1',
          onIncoming: (message) => {
            if (message.type === 'notification') {
              notifications++
              return
            }
            return transport
              .request('nested')
              .then((result) => transport.respond(message, result))
          },
        })
        runtime.ownTransport(transport)
        return transport.request('outer')
      })
      expect(value).toBe('nested result')
      expect(notifications).toBe(300)
      expect(transport.state).toMatchObject({
        pendingRequests: 0,
        incomingRequests: 0,
      })
    })

    it('drains more than 256 async notification handlers before a nested reply', async () => {
      let notifications = 0
      let transport!: JsonlRpcTransport
      const { value } = await startFixture(fixtureMode, async (runtime) => {
        transport = new JsonlRpcTransport({
          wireProfile,
          stdin: runtime.child.stdin,
          stdout: runtime.child.stdout,
          runtimeGeneration: 'async-test',
          onIncoming: async (message) => {
            if (message.type === 'notification') {
              notifications++
              return
            }
            const value = await transport.request('nested')
            await transport.respond(message, value)
          },
        })
        runtime.ownTransport(transport)
        return transport.request('outer')
      })
      expect(value).toBe('nested result')
      expect(notifications).toBe(300)
    })

    it('correlates replies out of order without confusing equal IDs across directions', async () => {
      const requests: JsonRpcRequest[] = []
      const io = rpc({
        onIncoming: (message) => {
          if (message.type === 'request') requests.push(message)
        },
      })
      try {
        const first = io.transport.request('first')
        const second = io.transport.request('second')
        await delay(0)
        const [one, two] = io.writes as { id: string }[]
        io.stdout.write(
          frame({ jsonrpc: '2.0', id: one!.id, method: 'approval' }),
        )
        io.stdout.write(frame({ jsonrpc: '2.0', id: two!.id, result: 2 }))
        io.stdout.write(frame({ jsonrpc: '2.0', id: one!.id, result: 1 }))
        expect(await Promise.all([first, second])).toEqual([1, 2])
        await io.transport.respond(requests[0]!, true)
        expect(io.writes).toHaveLength(3)
      } finally {
        await io.transport.close()
      }
    })

    it('runs notification handlers concurrently with requests and replies', async () => {
      const waiting = deferred<void>()
      let transport!: JsonlRpcTransport
      let count = 0
      const io = rpc({
        onIncoming: (message) => {
          count++
          if (message.method === 'wait')
            return transport.request('nested').then(() => waiting.resolve())
        },
      })
      transport = io.transport
      try {
        io.stdout.write(frame({ jsonrpc: '2.0', method: 'wait' }))
        io.stdout.write(frame({ jsonrpc: '2.0', method: 'tick' }))
        const nested = io.writes[0] as { id: string }
        io.stdout.write(frame({ jsonrpc: '2.0', id: nested.id, result: true }))
        await waiting.promise
        expect(count).toBe(2)
      } finally {
        await transport.close()
      }
    })

    it.each([
      null,
      [],
      1,
      {},
      { jsonrpc: '1.0', method: 'x' },
      { jsonrpc: '2.0', id: true, method: 'x' },
      { jsonrpc: '2.0', method: 1 },
      { jsonrpc: '2.0', id: 1 },
      { jsonrpc: '2.0', id: 1, result: 1, error: {} },
      { jsonrpc: '2.0', id: 1, error: { message: 'raw-secret' } },
      { jsonrpc: '2.0', method: 'x', params: 'raw-secret' },
      { jsonrpc: '2.0', method: 'x', result: 1 },
    ])('rejects malformed envelope %j from an executable', async (envelope) => {
      const { value: transport } = await startFixture(
        'bytes',
        async (runtime) => {
          const transport = new JsonlRpcTransport({
            wireProfile,
            stdin: runtime.child.stdin,
            stdout: runtime.child.stdout,
            runtimeGeneration: 'test',
          })
          runtime.ownTransport(transport)
          return transport
        },
        {},
        bytePayload([frame(envelope)]),
      )
      const pending = transport
        .request('pending')
        .catch((error: Error) => error.message)
      expect(await pending).toBe('Malformed JSON-RPC envelope')
      expect((await transport.done).message).not.toContain('raw-secret')
    })

    it('bounds pending requests, clears timers, and removes abort listeners on every settlement', async () => {
      const io = rpc({ maxPendingRequests: 1 })
      const controller = new AbortController()
      try {
        const request = io.transport.requestWithSubmission(
          'pending',
          undefined,
          {
            signal: controller.signal,
          },
        )
        await expect(io.transport.request('overflow')).rejects.toThrow(
          'limit reached',
        )
        expect(io.transport.state.pendingRequests).toBe(1)
        const id = (io.writes[0] as { id: string }).id
        io.stdout.write(frame({ jsonrpc: '2.0', id, result: 1 }))
        expect(await request.response).toBe(1)
        expect(await request.submission).toMatchObject({ status: 'written' })
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
        const timed = io.transport.request('timeout', undefined, {
          signal: controller.signal,
          timeoutMs: 10,
        })
        await expect(timed).rejects.toThrow('timed out')
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
        expect(io.transport.state.pendingRequests).toBe(0)
      } finally {
        await io.transport.close()
      }
    })

    it('removes a cancelled queued request before it reaches stdin and settles it once', async () => {
      const stdin = new SlowWriter()
      const io = rpc({ stdin })
      const controller = new AbortController()
      let settled = 0
      try {
        const active = io.transport.notify('active').catch(() => {})
        const request = io.transport
          .request('never-write', undefined, { signal: controller.signal })
          .catch((error: Error) => {
            settled++
            return error.message
          })
        expect(io.transport.state.queuedFrames).toBe(2)
        controller.abort()
        expect(await request).toContain('cancelled')
        expect(io.transport.state.queuedFrames).toBe(1)
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
        stdin.release()
        await active
        await io.transport.close()
        expect(stdin.writes).toHaveLength(1)
        expect(settled).toBe(1)
        expect(io.transport.state.pendingRequests).toBe(0)
      } finally {
        await io.transport.close()
      }
    })

    it('does not enqueue pre-aborted requests', async () => {
      const io = rpc()
      const controller = new AbortController()
      controller.abort()
      await expect(
        io.transport.request('secret-method', undefined, {
          signal: controller.signal,
        }),
      ).rejects.toThrow('cancelled')
      expect(io.writes).toEqual([])
      await io.transport.close()
    })

    it('fails explicitly on incoming request and handler overflow', async () => {
      for (const kind of ['requests', 'handlers']) {
        const waiting = deferred<void>()
        const io = rpc({
          maxIncomingRequests: 1,
          maxIncomingHandlers: 1,
          maxQueuedIncomingFrames: 1,
          onIncoming: () => (kind === 'handlers' ? waiting.promise : undefined),
        })
        const first = {
          jsonrpc: '2.0',
          method: 'wait',
          ...(kind === 'requests' ? { id: 1 } : {}),
        }
        const second = { ...first, ...(kind === 'requests' ? { id: 2 } : {}) }
        io.stdout.write(
          Buffer.concat([frame(first), frame(second), frame(second)]),
        )
        expect((await io.transport.done).message).toContain('limit reached')
        expect(io.transport.state).toMatchObject({
          incomingRequests: 0,
          incomingHandlers: 0,
          pendingRequests: 0,
        })
        waiting.resolve()
        await io.transport.close()
      }
    })

    it.each(['throw', 'reject'])(
      'handles incoming handler %s without an unhandled rejection',
      async (kind) => {
        const io = rpc({
          onIncoming: () => {
            if (kind === 'throw') throw new Error('raw-secret')
            return Promise.reject(new Error('raw-secret'))
          },
        })
        io.stdout.write(frame({ jsonrpc: '2.0', method: 'bad' }))
        expect((await io.transport.done).message).toBe(
          'JSON-RPC incoming handler failed',
        )
      },
    )

    it('does not retain a handler that closes its transport before awaiting work', async () => {
      const waiting = deferred<void>()
      const io = rpc({
        onIncoming: () => {
          void io.transport.close()
          return waiting.promise
        },
      })
      io.stdout.write(frame({ jsonrpc: '2.0', method: 'close' }))
      await io.transport.done
      expect(io.transport.state.incomingHandlers).toBe(0)
      waiting.reject(new Error('late private failure'))
      await delay(0)
      expect(io.transport.state.incomingHandlers).toBe(0)
    })

    it('keeps numeric and string request IDs distinct and rejects duplicate incoming IDs', async () => {
      const received: JsonRpcRequest[] = []
      const io = rpc({
        onIncoming: (message) => {
          if (message.type === 'request') received.push(message)
        },
      })
      io.stdout.write(frame({ jsonrpc: '2.0', id: 1, method: 'first' }))
      io.stdout.write(frame({ jsonrpc: '2.0', id: '1', method: 'second' }))
      expect(received).toHaveLength(2)
      io.stdout.write(frame({ jsonrpc: '2.0', id: 1, method: 'duplicate' }))
      expect((await io.transport.done).message).toBe(
        'Malformed JSON-RPC envelope',
      )
      expect(received.every((message) => message.signal.aborted)).toBe(true)
    })

    it('allows an error reply and preserves a request after local serialization failure', async () => {
      const received: JsonRpcRequest[] = []
      const io = rpc({
        onIncoming: (message) => {
          if (message.type === 'request') received.push(message)
        },
      })
      try {
        io.stdout.write(frame({ jsonrpc: '2.0', id: 1, method: 'first' }))
        await expect(io.transport.respond(received[0]!, 1n)).rejects.toThrow(
          'Cannot encode',
        )
        expect(io.transport.state.incomingRequests).toBe(1)
        await io.transport.respondError(
          received[0]!,
          -32601,
          'Unsupported method',
        )
        expect(io.writes).toEqual([
          JSON.parse(
            String(
              frame({
                jsonrpc: '2.0',
                id: 1,
                error: { code: -32601, message: 'Unsupported method' },
              }),
            ),
          ),
        ])
        expect(io.transport.state.incomingRequests).toBe(0)
      } finally {
        await io.transport.close()
      }
    })

    it('rejects stale request handles and ignores responses from another generation', async () => {
      const old: JsonRpcRequest[] = []
      const current: JsonRpcRequest[] = []
      const first = rpc({
        runtimeGeneration: 'old',
        onIncoming: (message) => {
          if (message.type === 'request') old.push(message)
        },
      })
      const second = rpc({
        runtimeGeneration: 'new',
        onIncoming: (message) => {
          if (message.type === 'request') current.push(message)
        },
      })
      try {
        first.stdout.write(frame({ jsonrpc: '2.0', id: 7, method: 'ask' }))
        const abandoned = first.transport.request('abandoned').catch(() => {})
        const oldId = (first.writes[0] as { id: string }).id
        await first.transport.close()
        await abandoned
        expect(old[0]!.signal.aborted).toBe(true)
        second.stdout.write(frame({ jsonrpc: '2.0', id: 7, method: 'ask' }))
        await expect(second.transport.respond(old[0]!, true)).rejects.toThrow(
          'stale',
        )
        const pending = second.transport.request('new')
        const newId = (second.writes[0] as { id: string }).id
        second.stdout.write(frame({ jsonrpc: '2.0', id: oldId, result: 'old' }))
        expect(second.transport.state.pendingRequests).toBe(1)
        second.stdout.write(frame({ jsonrpc: '2.0', id: newId, result: 'new' }))
        expect(await pending).toBe('new')
        await second.transport.respond(current[0]!, true)
        await expect(
          second.transport.respond(current[0]!, true),
        ).rejects.toThrow('already answered')
      } finally {
        await first.transport.close()
        await second.transport.close()
      }
    })

    it('settles early EOF and reader failure without hanging close', async () => {
      for (const kind of ['end', 'error']) {
        const io = rpc()
        const controller = new AbortController()
        let count = 0
        const pending = io.transport
          .request('pending', undefined, { signal: controller.signal })
          .catch((error: Error) => {
            count++
            return error.message
          })
        if (kind === 'end') io.stdout.end()
        else io.stdout.destroy(new Error('raw-secret'))
        expect(await pending).toContain(
          kind === 'end' ? 'ended' : 'read failed',
        )
        await io.transport.close()
        await io.transport.close()
        controller.abort()
        expect(count).toBe(1)
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
      }
    })

    it('bounds incoming queues by bytes and count while replies bypass blocked handlers', async () => {
      const waiting = deferred<void>()
      const io = rpc({
        maxIncomingHandlers: 1,
        maxQueuedIncomingFrames: 2,
        maxQueuedIncomingBytes: 200,
        onIncoming: () => waiting.promise,
      })
      const request = io.transport.request('pending')
      const id = (io.writes[0] as { id: string }).id
      io.stdout.write(frame({ jsonrpc: '2.0', method: 'block' }))
      io.stdout.write(frame({ jsonrpc: '2.0', method: 'queued' }))
      expect(io.transport.state).toMatchObject({
        incomingHandlers: 1,
        queuedIncomingFrames: 1,
      })
      expect(io.transport.state.queuedIncomingBytes).toBeGreaterThan(0)
      io.stdout.write(
        frame({ jsonrpc: '2.0', id, result: 'reply bypasses queue' }),
      )
      expect(await request).toBe('reply bypasses queue')
      io.stdout.write(
        frame({
          jsonrpc: '2.0',
          method: 'large',
          params: { text: 'x'.repeat(200) },
        }),
      )
      expect((await io.transport.done).message).toContain('queue limit reached')
      expect(io.transport.state).toMatchObject({
        incomingHandlers: 0,
        queuedIncomingFrames: 0,
        queuedIncomingBytes: 0,
      })
      waiting.resolve()
    })

    it('fails executable notification floods with bounded active and queued work', async () => {
      const waiting = deferred<void>()
      const values = Array.from({ length: 4 }, () =>
        frame({ jsonrpc: '2.0', method: 'block' }),
      )
      const { value: transport } = await startFixture(
        'bytes',
        async (runtime) => {
          const transport = new JsonlRpcTransport({
            wireProfile,
            stdin: runtime.child.stdin,
            stdout: runtime.child.stdout,
            runtimeGeneration: 'overflow-test',
            maxIncomingHandlers: 1,
            maxQueuedIncomingFrames: 2,
            onIncoming: () => waiting.promise,
          })
          runtime.ownTransport(transport)
          return transport
        },
        {},
        bytePayload([Buffer.concat(values)]),
      )
      expect((await transport.done).message).toContain('queue limit reached')
      expect(transport.state).toMatchObject({
        incomingHandlers: 0,
        queuedIncomingFrames: 0,
      })
      waiting.resolve()
    })

    it('keeps a request slot reserved until its queued reply finishes', async () => {
      const stdin = new SlowWriter()
      const received: JsonRpcRequest[] = []
      const io = rpc({
        stdin,
        maxIncomingRequests: 1,
        onIncoming: (message) => {
          if (message.type === 'request') received.push(message)
        },
      })
      io.stdout.write(frame({ jsonrpc: '2.0', id: 1, method: 'first' }))
      const reply = io.transport
        .respond(received[0]!, true)
        .catch((error: Error) => error.message)
      await expect(io.transport.respond(received[0]!, true)).rejects.toThrow(
        'already answered',
      )
      expect(io.transport.state.incomingRequests).toBe(1)
      io.stdout.write(frame({ jsonrpc: '2.0', id: 2, method: 'second' }))
      expect((await io.transport.done).message).toContain(
        'incoming request limit reached',
      )
      expect(await reply).toContain('incoming request limit reached')
    })

    it('clears a timed-out request from a blocked write queue', async () => {
      const stdin = new SlowWriter()
      const io = rpc({ stdin })
      const first = io.transport.notify('block').catch(() => {})
      const pending = io.transport.request('never-write', undefined, {
        timeoutMs: 10,
      })
      await expect(pending).rejects.toThrow('timed out')
      expect(io.transport.state.queuedFrames).toBe(1)
      stdin.release()
      await first
      expect(stdin.writes).toHaveLength(1)
      await io.transport.close()
    })

    it('keeps a large final reply while the child exits and closes stdin first', async () => {
      const { process: runtime, value: transport } = await startFixture(
        fixtureMode,
        async (runtime) => {
          const transport = new JsonlRpcTransport({
            wireProfile,
            stdin: runtime.child.stdin,
            stdout: runtime.child.stdout,
            runtimeGeneration: 'large-test',
          })
          runtime.ownTransport(transport)
          return transport
        },
      )
      await expect(
        transport.request('large-exit', undefined, { signal: runtime.signal }),
      ).resolves.toBe('x'.repeat(500_000))
      await runtime.done
    })

    it('delivers the buffered final RPC reply when the executable exits', async () => {
      const { process: runtime, value: transport } = await startFixture(
        fixtureMode,
        async (runtime) => {
          const transport = new JsonlRpcTransport({
            wireProfile,
            stdin: runtime.child.stdin,
            stdout: runtime.child.stdout,
            runtimeGeneration: 'test',
          })
          runtime.ownTransport(transport)
          return transport
        },
      )
      await expect(transport.request('exit')).resolves.toBe('final reply')
      await runtime.done
    })
  },
)

describe('RPC wire profiles', () => {
  it.each([undefined, '1.0', null, 2])(
    'requires the standard version by default: %j',
    async (version) => {
      const io = rpcStreams()
      io.stdout.write(
        frame({
          ...(version === undefined ? {} : { jsonrpc: version }),
          method: 'notification',
        }),
      )
      expect((await io.transport.done).message).toBe(
        'Malformed JSON-RPC envelope',
      )
    },
  )

  it.each(['2.0', '1.0', null])(
    'requires an omitted version for unversioned traffic: %j',
    async (version) => {
      const io = rpcStreams({ wireProfile: 'unversioned' })
      io.stdout.write(frame({ jsonrpc: version, method: 'notification' }))
      expect((await io.transport.done).message).toBe(
        'Malformed JSON-RPC envelope',
      )
    },
  )

  it('uses unversioned initialization, notifications, successful replies, and error replies on an owned wire', async () => {
    const writes: Record<string, unknown>[] = []
    let approvals = 0
    const { value: transport } = await startFixture(
      'rpc-unversioned',
      async (runtime) => {
        const write = runtime.child.stdin.write.bind(runtime.child.stdin)
        vi.spyOn(runtime.child.stdin, 'write').mockImplementation(
          (...args: Parameters<typeof write>) => {
            writes.push(JSON.parse(String(args[0])))
            return write(...args)
          },
        )
        const transport: JsonlRpcTransport = new JsonlRpcTransport({
          stdin: runtime.child.stdin,
          stdout: runtime.child.stdout,
          runtimeGeneration: 'unversioned-audit',
          wireProfile: 'unversioned',
          onIncoming: (message) => {
            if (message.type === 'request') {
              approvals++
              return approvals === 1
                ? transport.respond(message, 'approved')
                : transport.respondError(message, -32601, 'Unsupported method')
            }
          },
        })
        runtime.ownTransport(transport)
        expect(
          await transport.request('initialize', {
            clientInfo: { name: 'owned-fixture', version: '1' },
          }),
        ).toEqual({ clientInfo: { name: 'owned-fixture', version: '1' } })
        return transport
      },
    )
    await transport.notify('initialized')
    expect(await transport.request('outer')).toBe('approved')
    await expect(transport.request('outer')).rejects.toThrow(
      'Unsupported method (code -32601)',
    )
    expect(writes.every((value) => !Object.hasOwn(value, 'jsonrpc'))).toBe(true)
    expect(
      writes.map(
        (value) =>
          value.method ?? ('error' in value ? 'error reply' : 'success reply'),
      ),
    ).toEqual([
      'initialize',
      'initialized',
      'outer',
      'success reply',
      'outer',
      'error reply',
    ])
    await transport.close()
  })
})
