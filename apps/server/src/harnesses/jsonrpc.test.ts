import { getEventListeners } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import {
  JsonlRpcTransport,
  type JsonlRpcOptions,
  type JsonRpcIncoming,
  type JsonRpcRequest,
} from './jsonrpc.js'
import { deferred, startFixture } from './transport-test-helpers.js'

class ControlledWriter extends Writable {
  readonly writes: Record<string, unknown>[] = []
  private callback?: () => void
  constructor(private held = false) {
    super({ highWaterMark: 1 })
  }
  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: () => void,
  ) {
    this.writes.push(JSON.parse(String(chunk)))
    if (this.held) this.callback = callback
    else callback()
  }
  release() {
    this.held = false
    const callback = this.callback
    this.callback = undefined
    callback?.()
  }
}

const owned = new Set<JsonlRpcTransport>()
afterEach(async () => {
  await Promise.all([...owned].map((transport) => transport.close()))
  owned.clear()
})

describe.each(['standard', 'unversioned'] as const)(
  '%s RPC request dismissal',
  (wireProfile) => {
    function rpc(
      options: Partial<Omit<JsonlRpcOptions, 'stdin' | 'stdout'>> & {
        stdin?: ControlledWriter
      } = {},
    ) {
      const stdin = options.stdin ?? new ControlledWriter()
      const stdout = new PassThrough()
      const received: JsonRpcIncoming[] = []
      const transport = new JsonlRpcTransport({
        stdin,
        stdout,
        runtimeGeneration: 'dismissal-test',
        wireProfile,
        onIncoming: (message) => {
          received.push(message)
        },
        ...options,
      })
      owned.add(transport)
      return {
        transport,
        stdin,
        stdout,
        received,
        send(value: Record<string, unknown>) {
          stdout.write(
            `${JSON.stringify(wireProfile === 'standard' ? { jsonrpc: '2.0', ...value } : value)}\n`,
          )
        },
      }
    }
    const requestAt = (received: JsonRpcIncoming[], index = 0) => {
      const message = received[index]!
      expect(message.type).toBe('request')
      return message as JsonRpcRequest
    }

    it('dismisses only an original live handle and keeps each signal independent', async () => {
      const io = rpc()
      const foreign = rpc()
      io.send({ id: 7, method: 'number' })
      io.send({ id: '7', method: 'string' })
      io.send({ method: 'tick' })
      foreign.send({ id: 7, method: 'foreign' })
      const number = requestAt(io.received)
      const string = requestAt(io.received, 1)
      const notification = io.received[2]!
      const invalid = [
        null,
        undefined,
        {},
        7,
        { ...number },
        { ...number, runtimeGeneration: 'old' },
        requestAt(foreign.received),
      ]
      for (const handle of invalid) {
        expect(io.transport.dismiss(handle as JsonRpcRequest)).toBe(false)
        await expect(
          io.transport.respond(handle as JsonRpcRequest, true),
        ).rejects.toThrow('stale')
      }
      expect(io.transport.state.incomingRequests).toBe(2)
      expect(number.signal).not.toBe(string.signal)
      expect(number.signal).not.toBe(notification.signal)
      expect(io.transport.dismiss(number)).toBe(true)
      expect(io.transport.dismiss(number)).toBe(false)
      expect(number.signal.aborted).toBe(true)
      expect(string.signal.aborted).toBe(false)
      expect(notification.signal.aborted).toBe(false)
      expect(requestAt(foreign.received).signal.aborted).toBe(false)
      await expect(io.transport.respond(number, true)).rejects.toThrow('stale')
      await expect(
        io.transport.respondError(number, -32601, 'Unsupported'),
      ).rejects.toThrow('stale')
      await expect(
        io.transport.respondError(number, NaN, 'Unsupported'),
      ).rejects.toThrow('stale')
      expect(io.stdin.writes).toEqual([])
      await io.transport.respond(string, 'string reply')
      expect(io.stdin.writes).toEqual([
        expect.objectContaining({ id: '7', result: 'string reply' }),
      ])
      expect(io.transport.dismiss(string)).toBe(false)
      expect(string.signal.aborted).toBe(true)
      expect(notification.signal.aborted).toBe(false)
      expect(io.transport.state.incomingRequests).toBe(0)
    })

    it('rejects a previous generation handle even after native ID reuse', async () => {
      const old = rpc({ runtimeGeneration: 'old' })
      old.send({ id: 1, method: 'old' })
      const oldRequest = requestAt(old.received)
      await old.transport.close()
      const current = rpc({ runtimeGeneration: 'current' })
      current.send({ id: 1, method: 'current' })
      expect(old.transport.dismiss(oldRequest)).toBe(false)
      expect(current.transport.dismiss(oldRequest)).toBe(false)
      await expect(current.transport.respond(oldRequest, true)).rejects.toThrow(
        'stale',
      )
      expect(oldRequest.signal.aborted).toBe(true)
      expect(requestAt(current.received).signal.aborted).toBe(false)
      await current.transport.respond(requestAt(current.received), true)
    })

    it('releases admission across 300 native cancellation cycles at the default limits', async () => {
      const io = rpc()
      for (let cycle = 0; cycle < 300; cycle++) {
        io.send({ id: cycle % 2 === 0 ? 1 : '1', method: 'cancel' })
        const request = requestAt(io.received, cycle)
        expect(io.transport.dismiss(request)).toBe(true)
        expect(request.signal.aborted).toBe(true)
        expect(getEventListeners(request.signal, 'abort')).toHaveLength(0)
        expect(io.transport.state).toMatchObject({
          incomingRequests: 0,
          incomingHandlers: 0,
          queuedIncomingFrames: 0,
          queuedIncomingBytes: 0,
          queuedFrames: 0,
          queuedBytes: 0,
        })
      }
      expect(io.stdin.writes).toEqual([])
      await io.transport.notify('still-live')
      const outgoing = io.transport.request('echo')
      const sent = io.stdin.writes.find((value) => value.method === 'echo')!
      io.send({ id: sent.id, result: true })
      expect(await outgoing).toBe(true)
      expect(io.transport.wire.closed).toBe(false)
    })

    it.each(['result', 'error'])(
      'removes a queued %s reply while unrelated traffic survives backpressure',
      async (kind) => {
        const stdin = new ControlledWriter(true)
        const io = rpc({ stdin })
        const active = io.transport.notify('block')
        io.send({ id: 1, method: 'cancel' })
        io.send({ id: 2, method: 'keep' })
        const cancelled = requestAt(io.received)
        const kept = requestAt(io.received, 1)
        const reply =
          kind === 'result'
            ? io.transport.respond(cancelled, true)
            : io.transport.respondError(cancelled, -32601, 'Unsupported')
        const assertion = expect(reply).rejects.toThrow('cancelled')
        const outgoing = io.transport.request('outgoing')
        const keptReply = io.transport.respond(kept, 'kept')
        expect(io.transport.state.queuedFrames).toBe(4)
        expect(getEventListeners(cancelled.signal, 'abort')).toHaveLength(1)
        expect(io.transport.dismiss(cancelled)).toBe(true)
        expect(io.transport.state.queuedFrames).toBe(3)
        expect(getEventListeners(cancelled.signal, 'abort')).toHaveLength(0)
        expect(kept.signal.aborted).toBe(false)
        await assertion
        stdin.release()
        await Promise.all([active, keptReply])
        const sent = stdin.writes.find((value) => value.method === 'outgoing')!
        io.send({ id: sent.id, result: 'outgoing result' })
        expect(await outgoing).toBe('outgoing result')
        expect(stdin.writes).toHaveLength(3)
        expect(stdin.writes.some((value) => value.id === 1)).toBe(false)
        expect(io.transport.state).toMatchObject({
          incomingRequests: 0,
          pendingRequests: 0,
          queuedFrames: 0,
          queuedBytes: 0,
        })
        expect(io.transport.wire.closed).toBe(false)
      },
    )

    it.each([7, '7'])(
      'settles an in-flight dismissal before drain without retracting its frame or consuming reused ID %j',
      async (id) => {
        const stdin = new ControlledWriter(true)
        const io = rpc({ stdin })
        io.send({ id, method: 'old' })
        const old = requestAt(io.received)
        const reply = io.transport.respond(old, 'already written')
        const assertion = expect(reply).rejects.toThrow('cancelled')
        expect(stdin.writes).toEqual([
          expect.objectContaining({ id, result: 'already written' }),
        ])
        expect(io.transport.dismiss(old)).toBe(true)
        io.send({ id, method: 'replacement' })
        const replacement = requestAt(io.received, 1)
        expect(io.transport.dismiss(old)).toBe(false)
        await assertion
        expect(io.transport.state.queuedFrames).toBe(1)
        expect(io.transport.state.incomingRequests).toBe(1)
        expect(replacement.signal.aborted).toBe(false)
        stdin.release()
        await io.transport.respond(replacement, 'replacement')
        expect(stdin.writes).toEqual([
          expect.objectContaining({ id, result: 'already written' }),
          expect.objectContaining({ id, result: 'replacement' }),
        ])
        expect(io.transport.state).toMatchObject({
          incomingRequests: 0,
          queuedFrames: 0,
          queuedBytes: 0,
        })
        expect(io.transport.wire.closed).toBe(false)
      },
    )

    it('does not retire a replacement when an already completed write settles its reply', async () => {
      const stdin = new ControlledWriter(true)
      const io = rpc({ stdin })
      io.send({ id: 1, method: 'old' })
      const old = requestAt(io.received)
      const reply = io.transport.respond(old, 'written')
      stdin.release()
      // The writer has completed, but the reply's promise callback has not run.
      expect(io.transport.dismiss(old)).toBe(true)
      io.send({ id: 1, method: 'replacement' })
      await reply
      expect(io.transport.state.incomingRequests).toBe(1)
      const replacement = requestAt(io.received, 1)
      expect(replacement.signal.aborted).toBe(false)
      await io.transport.respond(replacement, 'replacement')
      expect(io.transport.dismiss(replacement)).toBe(false)
    })

    it('keeps validation failures answerable and cleans failed-send listeners before retry', async () => {
      const io = rpc()
      io.send({ id: 1, method: 'ask' })
      const request = requestAt(io.received)
      for (const invalid of [undefined, 1n, { toJSON: () => undefined }]) {
        await expect(io.transport.respond(request, invalid)).rejects.toThrow()
        expect(io.transport.state.incomingRequests).toBe(1)
        expect(request.signal.aborted).toBe(false)
        expect(getEventListeners(request.signal, 'abort')).toHaveLength(0)
        expect(io.stdin.writes).toEqual([])
      }
      await expect(
        io.transport.respondError(request, NaN, 'Unsupported'),
      ).rejects.toThrow('Invalid JSON-RPC error code')
      expect(request.signal.aborted).toBe(false)
      await io.transport.respondError(request, -32601, 'Unsupported')
      expect(io.stdin.writes).toEqual([
        expect.objectContaining({
          id: 1,
          error: { code: -32601, message: 'Unsupported' },
        }),
      ])
      expect(request.signal.aborted).toBe(true)
      expect(getEventListeners(request.signal, 'abort')).toHaveLength(0)
      expect(io.transport.state.incomingRequests).toBe(0)
    })

    it('retries a rejected full-queue send only while its original handle remains live', async () => {
      const stdin = new ControlledWriter(true)
      const io = rpc({ stdin, maxQueuedFrames: 1 })
      const active = io.transport.notify('block')
      io.send({ id: 1, method: 'retry' })
      const request = requestAt(io.received)
      await expect(io.transport.respond(request, true)).rejects.toThrow(
        'queue is full',
      )
      expect(request.signal.aborted).toBe(false)
      expect(getEventListeners(request.signal, 'abort')).toHaveLength(0)
      stdin.release()
      await active
      await io.transport.respond(request, true)
      expect(io.transport.dismiss(request)).toBe(false)
    })

    it.each(['result', 'error'])(
      'rejects reentrant dismissal during %s serialization before bytes can write',
      async (kind) => {
        const io = rpc()
        io.send({ id: 1, method: 'old' })
        const old = requestAt(io.received)
        const payload = {
          toJSON() {
            expect(io.transport.dismiss(old)).toBe(true)
            io.send({ id: 1, method: 'replacement' })
            return 'cancelled'
          },
        }
        const reply =
          kind === 'result'
            ? io.transport.respond(old, payload)
            : io.transport.respondError(
                old,
                -32601,
                payload as unknown as string,
              )
        await expect(reply).rejects.toThrow('cancelled')
        expect(io.stdin.writes).toEqual([])
        expect(io.transport.state.incomingRequests).toBe(1)
        const replacement = requestAt(io.received, 1)
        expect(replacement.signal.aborted).toBe(false)
        await io.transport.respond(replacement, 'replacement')
        expect(io.stdin.writes).toEqual([
          expect.objectContaining({ id: 1, result: 'replacement' }),
        ])
      },
    )

    it('keeps a cancelled handler slot until settlement and suppresses its dismissed queued request', async () => {
      const waiting = deferred<void>()
      const received: JsonRpcIncoming[] = []
      const io = rpc({
        maxIncomingHandlers: 1,
        onIncoming: (message) => {
          received.push(message)
          if (message.method === 'block') return waiting.promise
        },
      })
      try {
        io.send({ id: 1, method: 'block' })
        expect(io.transport.dismiss(requestAt(received))).toBe(true)
        io.send({ id: 2, method: 'queued-cancel' })
        io.send({ method: 'tick' })
        // A queued request is not delivered to onIncoming yet. Inspect its owned handle only for this admission test.
        const queue = (
          io.transport as unknown as {
            queue: { message: JsonRpcIncoming; bytes: number }[]
          }
        ).queue
        const queued = requestAt(queue.map((item) => item.message))
        const remainingBytes = queue[1]!.bytes
        expect(io.transport.dismiss(queued)).toBe(true)
        expect(queued.signal.aborted).toBe(true)
        expect(io.transport.state).toMatchObject({
          incomingRequests: 0,
          incomingHandlers: 1,
          queuedIncomingFrames: 1,
          queuedIncomingBytes: remainingBytes,
        })
        io.send({ id: 2, method: 'replacement' })
        expect(received.map((message) => message.method)).toEqual(['block'])
        expect(io.transport.state.incomingHandlers).toBe(1)
        waiting.resolve()
        await delay(0)
        expect(received.map((message) => message.method)).toEqual([
          'block',
          'tick',
          'replacement',
        ])
        expect(io.transport.state).toMatchObject({
          incomingHandlers: 0,
          queuedIncomingFrames: 0,
          queuedIncomingBytes: 0,
          incomingRequests: 1,
        })
        await io.transport.respond(requestAt(received, 2), true)
      } finally {
        waiting.resolve()
      }
    })

    it('ignores a synchronous handler throw after reentrant retirement and admits an ID replacement', async () => {
      const received: JsonRpcIncoming[] = []
      const io = rpc({
        onIncoming: (message) => {
          received.push(message)
          if (message.type === 'request' && message.method === 'retire') {
            expect(io.transport.dismiss(message)).toBe(true)
            io.send({ id: message.id, method: 'replacement' })
            throw new Error('retired handler failure')
          }
        },
      })
      io.send({ id: 1, method: 'retire' })
      io.send({ method: 'tick' })
      expect(received.map((message) => message.method)).toEqual([
        'retire',
        'replacement',
        'tick',
      ])
      expect(io.transport.state).toMatchObject({
        incomingRequests: 1,
        incomingHandlers: 0,
      })
      await io.transport.respond(requestAt(received, 1), true)
      expect(io.transport.wire.closed).toBe(false)
    })

    it('keeps traffic live when a handler rejects after its successful reply retires the request', async () => {
      const replied = deferred<void>()
      const received: JsonRpcIncoming[] = []
      const io = rpc({
        onIncoming: (message): void | Promise<void> => {
          received.push(message)
          if (message.type === 'request' && message.method === 'reply')
            return io.transport.respond(message, true).then(() => {
              replied.resolve()
              throw new Error('retired handler failure')
            })
        },
      })
      io.send({ id: 1, method: 'reply' })
      await replied.promise
      io.send({ id: 1, method: 'replacement' })
      await delay(0)
      expect(requestAt(received).signal.aborted).toBe(true)
      expect(io.transport.state).toMatchObject({
        incomingRequests: 1,
        incomingHandlers: 0,
      })
      await io.transport.respond(requestAt(received, 1), true)
      expect(io.transport.wire.closed).toBe(false)
    })

    it.each(['throw', 'reject'])(
      'still closes the router when a live request handler fails with %s',
      async (kind) => {
        let request!: JsonRpcRequest
        const io = rpc({
          onIncoming: (message) => {
            request = message as JsonRpcRequest
            if (kind === 'throw') throw new Error('private failure')
            return Promise.reject(new Error('private failure'))
          },
        })
        const outgoing = io.transport.request('pending')
        const assertion = expect(outgoing).rejects.toThrow(
          'JSON-RPC incoming handler failed',
        )
        io.send({ id: 1, method: 'fail' })
        expect((await io.transport.done).message).toBe(
          'JSON-RPC incoming handler failed',
        )
        await assertion
        expect(request.signal.aborted).toBe(true)
        expect(io.transport.dismiss(request)).toBe(false)
        expect(io.transport.state).toMatchObject({
          incomingRequests: 0,
          incomingHandlers: 0,
          pendingRequests: 0,
        })
      },
    )

    it('aborts requests and runtime notifications and clears queued writes and handlers on shutdown', async () => {
      const stdin = new ControlledWriter(true)
      const waiting = deferred<void>()
      const received: JsonRpcIncoming[] = []
      const io = rpc({
        stdin,
        maxIncomingHandlers: 3,
        onIncoming: (message) => {
          received.push(message)
          return waiting.promise
        },
      })
      io.send({ id: 1, method: 'first' })
      io.send({ id: 2, method: 'second' })
      io.send({ method: 'tick' })
      io.send({ id: 3, method: 'queued' })
      const queued = (
        io.transport as unknown as {
          queue: { message: JsonRpcIncoming }[]
        }
      ).queue[0]!.message
      const external = new AbortController()
      const outgoing = io.transport.request('pending', undefined, {
        signal: external.signal,
      })
      const first = requestAt(received)
      const second = requestAt(received, 1)
      const replies = [
        outgoing,
        io.transport.respond(first, 'queued'),
        io.transport.respondError(second, -32601, 'Unsupported'),
      ].map((promise) => promise.catch((error: Error) => error.message))
      expect(getEventListeners(first.signal, 'abort')).toHaveLength(1)
      expect(io.transport.state.queuedFrames).toBe(3)
      await io.transport.close()
      expect(await Promise.all(replies)).toEqual([
        'JSON-RPC transport closed',
        'JSON-RPC transport closed',
        'JSON-RPC transport closed',
      ])
      expect(
        [...received, queued].every((message) => message.signal.aborted),
      ).toBe(true)
      for (const message of received)
        expect(getEventListeners(message.signal, 'abort')).toHaveLength(0)
      expect(getEventListeners(external.signal, 'abort')).toHaveLength(0)
      expect(io.transport.state).toEqual({
        incomingRequests: 0,
        incomingHandlers: 0,
        pendingRequests: 0,
        queuedIncomingFrames: 0,
        queuedIncomingBytes: 0,
        queuedFrames: 0,
        queuedBytes: 0,
        bufferedBytes: 0,
      })
      waiting.reject(new Error('late retired handler failure'))
      await delay(0)
      expect(io.transport.state.incomingHandlers).toBe(0)
      expect(io.stdout.listenerCount('data')).toBe(0)
      expect(io.stdout.listenerCount('end')).toBe(0)
      expect(io.stdout.listenerCount('error')).toBe(0)
      expect(stdin.listenerCount('drain')).toBe(0)
      expect(stdin.listenerCount('error')).toBe(0)
      expect(io.stdout.destroyed).toBe(true)
      expect(stdin.destroyed).toBe(true)
      expect(stdin.writes).toHaveLength(1)
    })

    it('maps fake Codex native resolution to dismissal, then releases a rejecting handler without consuming its replacement', async () => {
      const native = new Map<string | number, JsonRpcRequest>()
      const aborted = deferred<void>()
      const finishOld = deferred<void>()
      const replacementReady = deferred<JsonRpcRequest>()
      const finishReplacement = deferred<void>()
      const unrelatedDone = deferred<void>()
      const tick = deferred<void>()
      let old!: JsonRpcRequest
      let notification!: JsonRpcIncoming
      const { value: transport } = await startFixture(
        wireProfile === 'standard' ? 'rpc' : 'rpc-unversioned',
        async (runtime) => {
          const transport: JsonlRpcTransport = new JsonlRpcTransport({
            wireProfile,
            stdin: runtime.child.stdin,
            stdout: runtime.child.stdout,
            runtimeGeneration: 'fake-codex-dismissal',
            maxIncomingHandlers: 2,
            onIncoming: (message) => {
              if (message.type === 'request') {
                native.set(message.id, message)
                if (message.method === 'dismissal/approval') {
                  old = message
                  const cancelled = deferred<void>()
                  message.signal.addEventListener(
                    'abort',
                    () => {
                      aborted.resolve()
                      void finishOld.promise.then(() =>
                        cancelled.reject(
                          new Error('cooperative handler cancelled'),
                        ),
                      )
                    },
                    { once: true },
                  )
                  return cancelled.promise
                }
                if (message.method === 'dismissal/replacement') {
                  replacementReady.resolve(message)
                  return finishReplacement.promise
                }
                return transport.respond(message, 'unrelated').then(() => {
                  native.delete(message.id)
                  unrelatedDone.resolve()
                })
              }
              if (message.method === 'serverRequest/resolved') {
                notification = message
                const params = message.params as {
                  requestId: string | number
                  threadId: string
                }
                expect(params.threadId).toBe('fixture-thread')
                const request = native.get(params.requestId)!
                expect(transport.dismiss(request)).toBe(true)
                native.delete(params.requestId)
              } else if (message.method === 'dismissal/tick') tick.resolve()
            },
          })
          runtime.ownTransport(transport)
          return transport
        },
      )
      try {
        expect(await transport.request('dismissal/start')).toBe(true)
        await aborted.promise
        const replacement = await replacementReady.promise
        expect(replacement.id).toBe(old.id)
        expect(native.get(old.id)).toBe(replacement)
        expect(transport.state).toMatchObject({
          incomingRequests: 2,
          incomingHandlers: 2,
          queuedIncomingFrames: 2,
        })
        expect(notification.signal.aborted).toBe(false)
        finishOld.resolve()
        await Promise.all([unrelatedDone.promise, tick.promise])
        expect(native.get(old.id)).toBe(replacement)
        expect(replacement.signal.aborted).toBe(false)
        expect(transport.state).toMatchObject({
          incomingRequests: 1,
          incomingHandlers: 1,
          queuedIncomingFrames: 0,
        })
        expect(transport.dismiss(old)).toBe(false)
        await transport.respond(replacement, 'replacement')
        native.delete(replacement.id)
        finishReplacement.resolve()
        await transport.notify('dismissal/client-note')
        expect(await transport.request('dismissal/report')).toEqual({
          replies: [
            { id: 8, result: 'unrelated' },
            { id: 7, result: 'replacement' },
          ],
          notifications: 1,
        })
        expect(transport.state).toMatchObject({
          incomingRequests: 0,
          incomingHandlers: 0,
          pendingRequests: 0,
          queuedIncomingFrames: 0,
        })
        expect(native.size).toBe(0)
        expect(transport.wire.closed).toBe(false)
      } finally {
        finishOld.resolve()
        finishReplacement.resolve()
        await transport.close()
      }
    })
  },
)
