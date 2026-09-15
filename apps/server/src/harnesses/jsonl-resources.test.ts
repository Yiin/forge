import { PassThrough, Writable } from 'node:stream'
import { expect, it } from 'vitest'
import { JsonlTransport } from './jsonl.js'
import { JsonlRpcTransport } from './jsonrpc.js'

function accounting(maximum = 100_000) {
  const held = new Map<string, number>()
  return {
    held,
    resources: {
      measureOutgoing: (value: unknown) =>
        Buffer.byteLength(JSON.stringify(value)),
      reserve(kind: string, bytes: number) {
        const total = [...held.values()].reduce((a, b) => a + b, 0)
        if (total + bytes > maximum) throw new Error('allocation refused')
        held.set(kind, (held.get(kind) ?? 0) + bytes)
        return () => held.set(kind, held.get(kind)! - bytes)
      },
    },
  }
}
it('retains the RPC write when its response arrives before callback and drain', async () => {
  let callback!: (error?: Error | null) => void, outgoing!: Buffer
  const stdin = new Writable({
      highWaterMark: 1,
      write: (bytes, _encoding, done) => {
        outgoing = bytes
        callback = done
      },
    }),
    stdout = new PassThrough(),
    owner = accounting()
  const rpc = new JsonlRpcTransport({
    stdin,
    stdout,
    runtimeGeneration: 'response-first',
    resources: owner.resources,
  })
  const reply = rpc.request('request', {})
  const request = JSON.parse(outgoing.toString())
  stdout.write(
    JSON.stringify({ jsonrpc: '2.0', id: request.id, result: 'accepted' }) +
      '\n',
  )
  expect(await reply).toBe('accepted')
  expect(owner.held.get('write')).toBe(outgoing.length)
  stdin.emit('drain')
  expect(owner.held.get('write')).toBe(outgoing.length)
  callback()
  await new Promise((resolve) => setImmediate(resolve))
  expect(owner.held.get('write')).toBe(0)
  await rpc.close()
})
it('charges partial receive capacity and retained decoded values until their physical release', async () => {
  const stdin = new PassThrough(),
    stdout = new PassThrough(),
    owner = accounting()
  let release: (() => void) | undefined
  const transport = new JsonlTransport({
    stdin,
    stdout,
    maxLineBytes: 64,
    resources: owner.resources,
    onValue: (_value, _bytes, ownership) => {
      release = ownership!.retain()
    },
  })
  stdout.write('{"n":')
  expect(owner.held.get('receive')).toBe(64)
  stdout.write('1}\n')
  expect(owner.held.get('receive')).toBe(64)
  expect(owner.held.get('parse')).toBe(7)
  expect(owner.held.get('decode')).toBe(14)
  await transport.close()
  expect(owner.held.get('receive')).toBe(0)
  expect(owner.held.get('parse')).toBe(7)
  release!()
  expect([...owner.held.values()].every((value) => value === 0)).toBe(true)
})
it('refuses receive growth before allocation and preserves lower negotiated capacity', async () => {
  const owner = accounting(50),
    stdout = new PassThrough()
  const transport = new JsonlTransport({
    stdin: new PassThrough(),
    stdout,
    maxLineBytes: 64,
    resources: owner.resources,
    onValue: () => {
      throw new Error('must not parse')
    },
  })
  stdout.write('{')
  expect(transport.closed).toBe(true)
  expect(owner.held.size).toBe(0)
  const second = accounting(),
    output = new PassThrough()
  const wire = new JsonlTransport({
    stdin: new PassThrough(),
    stdout: output,
    maxLineBytes: 64,
    resources: second.resources,
    onValue: () => {},
  })
  output.write('{')
  wire.setLimits({ maxLineBytes: 16, maxQueuedBytes: 32, maxQueuedFrames: 1 })
  expect(second.held.get('receive')).toBe(16)
  expect(() =>
    wire.setLimits({
      maxLineBytes: 17,
      maxQueuedBytes: 32,
      maxQueuedFrames: 1,
    }),
  ).toThrow('decrease')
  output.write(' '.repeat(16))
  expect(wire.closed).toBe(true)
  expect(second.held.get('receive')).toBe(0)
})
it.each(['callback-first', 'drain-first'] as const)(
  'keeps physical writes through cancellation and %s settlement',
  async (order) => {
    let callback!: (error?: Error | null) => void
    const stdin = new Writable({
      highWaterMark: 1,
      write: (_bytes, _encoding, done) => {
        callback = done
      },
    })
    const owner = accounting(),
      controller = new AbortController()
    const transport = new JsonlTransport({
      stdin,
      stdout: new PassThrough(),
      resources: owner.resources,
      onValue: () => {},
    })
    const result = transport.send({ n: 1 }, { signal: controller.signal })
    controller.abort()
    await expect(result).rejects.toThrow('cancelled')
    expect(owner.held.get('write')).toBe(8)
    if (order === 'drain-first') {
      stdin.emit('drain')
      expect(owner.held.get('write')).toBe(8)
      callback()
    } else callback()
    await new Promise((resolve) => setImmediate(resolve))
    expect(owner.held.get('write')).toBe(0)
    await transport.close()
  },
)
it('keeps a cancelled physical write through stream close until its callback settles', async () => {
  let destroyed!: () => void
  let callback!: (error?: Error | null) => void
  const stdin = new Writable({
    write: (_bytes, _encoding, done) => {
      callback = done
    },
    destroy: (_error, done) => {
      destroyed = () => done()
    },
  })
  const owner = accounting()
  const transport = new JsonlTransport({
    stdin,
    stdout: new PassThrough(),
    resources: owner.resources,
    onValue: () => {},
  })
  const result = transport.send({ n: 1 })
  await transport.close()
  await expect(result).rejects.toThrow('closed')
  expect(owner.held.get('write')).toBe(8)
  destroyed()
  await new Promise((resolve) => setImmediate(resolve))
  expect(stdin.closed).toBe(true)
  expect(owner.held.get('write')).toBe(8)
  callback()
  await new Promise((resolve) => setImmediate(resolve))
  expect(owner.held.get('write')).toBe(0)
})
