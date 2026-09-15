import { PassThrough, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JsonlRpcTransport, type JsonRpcRequest } from './jsonrpc.js'
import { JsonlTransport } from './jsonl.js'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  vi.restoreAllMocks()
})
function controlled() {
  const stdin = new Writable({
    write(_chunk, _encoding, done) {
      done()
    },
  })
  const stdout = new PassThrough()
  const frames: Record<string, unknown>[] = []
  const callbacks: Array<(error?: Error | null) => void> = []
  vi.spyOn(stdin, 'write').mockImplementation((chunk, encoding, callback) => {
    frames.push(JSON.parse(String(chunk)))
    callbacks.push(typeof encoding === 'function' ? encoding : callback!)
    return false
  })
  return { stdin, stdout, frames, callbacks }
}
function rpc() {
  const io = controlled()
  const received: JsonRpcRequest[] = []
  const transport = new JsonlRpcTransport({
    ...io,
    runtimeGeneration: 'generation',
    onIncoming(message) {
      if (message.type === 'request') received.push(message)
    },
  })
  cleanups.push(() => transport.close())
  const incoming = (value: object) =>
    io.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n')
  return { ...io, transport, incoming, received }
}

describe('physical submission ownership', () => {
  it.each(['result', 'error'] as const)(
    'keeps callback and drain proof after an early RPC %s',
    async (kind) => {
      const io = rpc()
      const operation = io.transport.requestWithSubmission('prompt')
      io.incoming({
        id: io.frames[0]!.id,
        ...(kind === 'result'
          ? { result: 'done' }
          : { error: { code: -123, message: 'denied', data: 'private' } }),
      })
      if (kind === 'result') expect(await operation.response).toBe('done')
      else {
        await expect(operation.response).rejects.toMatchObject({
          code: -123,
          message: 'denied (code -123)',
        })
        await expect(operation.response).rejects.not.toHaveProperty('data')
      }
      let submitted = false
      void operation.submission.then(() => {
        submitted = true
      })
      await Promise.resolve()
      expect(submitted).toBe(false)
      io.callbacks.shift()!()
      await Promise.resolve()
      expect(submitted).toBe(false)
      io.stdin.emit('drain')
      const evidence = await operation.submission
      expect(evidence).toMatchObject({
        status: 'written',
        cancellation: 'none',
        operationId: io.frames[0]!.id,
      })
      expect(Object.isFrozen(evidence)).toBe(true)
    },
  )
  it('keeps caller cancellation connected after response until physical proof', async () => {
    const io = rpc(),
      controller = new AbortController()
    const operation = io.transport.requestWithSubmission(
      'prompt',
      {},
      { signal: controller.signal },
    )
    io.incoming({ id: io.frames[0]!.id, result: 'done' })
    await operation.response
    controller.abort()
    io.callbacks.shift()!()
    io.stdin.emit('drain')
    expect(await operation.submission).toMatchObject({
      status: 'written',
      cancellation: 'after_handoff',
    })
  })
  it.each(['queued', 'handed'] as const)(
    'preserves original reply evidence when %s request is dismissed',
    async (mode) => {
      const io = rpc()
      const first = mode === 'queued' ? io.transport.notify('held') : undefined
      io.incoming({ id: 0, method: 'permission', params: {} })
      const request = io.received[0]!
      const operation = io.transport.respondWithSubmission(request, {
        outcome: 'cancelled',
      })
      io.transport.dismiss(request)
      await expect(operation.logical).rejects.toThrow('cancelled')
      if (mode === 'queued') {
        expect(await operation.submission).toMatchObject({
          status: 'not_written',
          cancellation: 'before_handoff',
        })
        expect(io.frames).toHaveLength(1)
      }
      io.callbacks.shift()!()
      io.stdin.emit('drain')
      if (first) await first
      else
        expect(await operation.submission).toMatchObject({
          status: 'written',
          cancellation: 'after_handoff',
        })
      await expect(io.transport.respond(request, {})).rejects.toThrow('stale')
    },
  )
  it('retains the write allocation after close until the actual held callback returns', async () => {
    const io = controlled()
    let bytes = 0
    const wire = new JsonlTransport({
      ...io,
      onValue() {},
      resources: {
        measureOutgoing(value) {
          return Buffer.byteLength(JSON.stringify(value))
        },
        reserve(kind, count) {
          if (kind === 'write') bytes += count
          return () => {
            if (kind === 'write') bytes -= count
          }
        },
      },
    })
    cleanups.push(() => wire.close())
    const operation = wire.sendWithSubmission({ value: 1 })
    await wire.close()
    await expect(operation.logical).rejects.toThrow('closed')
    expect(await operation.submission).toMatchObject({
      status: 'failed_after_handoff',
    })
    expect(bytes).toBeGreaterThan(0)
    io.callbacks.shift()!()
    expect(bytes).toBe(0)
  })
  it('keeps captured transport and operation identities when options and transport mutate', async () => {
    const io = controlled()
    const wire = new JsonlTransport({ ...io, onValue() {} })
    cleanups.push(() => wire.close())
    const transportId = wire.transportId
    const options = { operationId: 'original' }
    const operation = wire.sendWithSubmission({}, options)
    options.operationId = 'changed'
    Object.defineProperty(wire, 'transportId', { value: 'replacement' })
    io.callbacks.shift()!()
    io.stdin.emit('drain')
    expect(await operation.submission).toMatchObject({
      operationId: 'original',
      transportId,
    })
  })
  it('does not hand off bytes when the admission hook throws', async () => {
    const io = controlled(),
      wire = new JsonlTransport({ ...io, onValue() {} })
    cleanups.push(() => wire.close())
    const operation = wire.sendWithSubmission(
      { value: 1 },
      {
        onHandoff() {
          throw Error('no')
        },
      },
    )
    await expect(operation.logical).rejects.toThrow()
    expect(await operation.submission).toMatchObject({ status: 'not_written' })
    expect(io.frames).toEqual([])
    expect(wire.state.queuedBytes).toBe(0)
  })
})

it('registers the original RPC ID before synchronous peer response and refuses throwing registration', async () => {
  const stdout = new PassThrough()
  let registered: string | undefined
  let writes = 0
  const stdin = new Writable({
    write(bytes, _encoding, done) {
      writes++
      const request = JSON.parse(bytes.toString())
      expect(registered).toBe(request.id)
      stdout.write(
        JSON.stringify({ jsonrpc: '2.0', id: request.id, result: 'ok' }) + '\n',
      )
      done()
    },
  })
  const transport = new JsonlRpcTransport({
    stdin,
    stdout,
    runtimeGeneration: 'generation',
    maxPendingRequests: 1,
  })
  cleanups.push(async () => {
    transport.close()
    stdin.destroy()
    stdout.destroy()
  })
  const accepted = transport.requestWithSubmission(
    'request',
    {},
    {
      onHandoff(id) {
        registered = id
      },
    },
  )
  expect(await accepted.response).toBe('ok')
  expect((await accepted.submission).operationId).toBe(registered)
  const refused = transport.requestWithSubmission(
    'request',
    {},
    {
      onHandoff(id) {
        registered = id
        throw Error('registration failed')
      },
    },
  )
  await expect(refused.response).rejects.toThrow('JSONL stdin write failed')
  expect((await refused.submission).status).toBe('not_written')
  expect(transport.state.pendingRequests).toBe(0)
  expect(writes).toBe(1)
})
