import { afterEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { Writable, PassThrough } from 'node:stream'
import { JsonlTransport } from '../jsonl.js'
import {
  decodeResponse,
  PublicationBudget,
  snapshot,
  limits,
  PiRouter,
} from './wire.js'
import {
  fixture,
  waitPhysicalIdle,
  type PeerConfig,
} from './fixtures/test-support.js'

const owned: Array<Awaited<ReturnType<typeof fixture>>> = []
async function peer(config?: PeerConfig) {
  const f = await fixture(config)
  owned.push(f)
  return f
}
afterEach(async () => {
  for (const f of owned.splice(0)) await f.close()
  await waitPhysicalIdle()
})
describe('Pi type/id JSONL routing', () => {
  it('Q8, 01, 32: maximum generation and command serial remain within the wire ID bound', async () => {
    const f = await peer()
    let sequence = 0
    const { handle } = await f.start({
      nextId: () =>
        sequence++ === 0 ? 'g'.repeat(256) : `bounded-${sequence}`,
    })
    expect(handle.binding).not.toBeNull()
    expect(
      (await f.wire()).every(
        (frame) => Buffer.byteLength(String(frame.id)) <= 256,
      ),
    ).toBe(true)
    const stdout = new PassThrough()
    const ids: string[] = []
    let router: PiRouter
    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        const frame = JSON.parse(chunk.toString())
        ids.push(frame.id)
        stdout.write(
          JSON.stringify({
            type: 'response',
            id: frame.id,
            command: frame.type,
            success: true,
          }) + '\n',
        )
        callback()
      },
    })
    const transport = new JsonlTransport({
      stdin,
      stdout,
      onValue: (value) => router.receive(value),
    })
    router = new PiRouter('g'.repeat(256), transport, limits(), (error) => {
      throw error
    })
    try {
      for (let index = 0; index < limits().maxCommands; index++)
        await router.request('abort', {}, true)
      expect(new Set(ids).size).toBe(limits().maxCommands)
      expect(ids.every((value) => Buffer.byteLength(value) <= 256)).toBe(true)
      expect(ids.at(-1)).toMatch(/:4096$/)
      await expect(router.request('abort', {}, true)).rejects.toThrow(
        'PI_CONTROL_CAPACITY',
      )
    } finally {
      router.close(new Error('Fixture ended'))
      await transport.close()
    }
  })
  it('01: decodes the supplied pinned no-model capture without exposing model credentials', async () => {
    const values = JSON.parse(
      await readFile(
        new URL('./fixtures/responses-0.84.0.json', import.meta.url),
        'utf8',
      ),
    ) as unknown[]
    for (const value of values) expect(decodeResponse(value).success).toBe(true)
    const state = decodeResponse(values[3]).data as { model: object }
    expect(state.model).not.toHaveProperty('baseUrl')
  })
  it('44: rejects a matching ID with the wrong command', async () => {
    const f = await peer({ hold: ['prompt'] })
    const { handle } = await f.start()
    const receipt = handle.prompt('held')
    const command = await f.wait(
      async () =>
        (await f.wire()).find((entry) => entry.type === 'prompt') ?? false,
    )
    await f.control({
      skipAcknowledgement: true,
      response: {
        type: 'response',
        id: command.id,
        command: 'steer',
        success: true,
      },
    })
    expect(await receipt.completion).toMatchObject({
      status: 'failed',
      code: 'PI_RESPONSE_COMMAND_MISMATCH',
    })
    expect(await receipt.acceptance).toMatchObject({ status: 'unknown' })
  })
  it('44: exact retired duplicates cannot affect a newer operation and contradictions fail', async () => {
    const f = await peer({ behavior: 'manual' })
    const { handle } = await f.start()
    const receipt = handle.prompt('root')
    await receipt.acceptance
    const command = (await f.wire()).find((entry) => entry.type === 'prompt')!
    await f.control({
      response: {
        type: 'response',
        id: command.id,
        command: 'prompt',
        success: true,
      },
    })
    await f.control({
      skipAcknowledgement: true,
      response: {
        type: 'response',
        id: command.id,
        command: 'prompt',
        success: false,
        error: 'contradiction',
      },
    })
    expect(await receipt.completion).toMatchObject({
      status: 'failed',
      code: 'PI_CONTRADICTORY_RESPONSE',
    })
  })
  it('44: uncorrelated parse failures cannot settle the most recent prompt by guesswork', async () => {
    const f = await peer({ behavior: 'manual' })
    const { handle } = await f.start()
    const receipt = handle.prompt('root')
    await receipt.acceptance
    await f.control({
      response: {
        type: 'response',
        command: 'parse',
        success: false,
        error: 'parse error',
      },
    })
    expect(await receipt.completion).toMatchObject({
      status: 'failed',
      code: 'PI_UNCORRELATED_RESPONSE',
    })
  })
  it('44, 50: unknown response IDs cannot grow beyond their retained ceiling', async () => {
    const f = await peer({ behavior: 'manual' })
    const { handle } = await f.start({ limits: { maxUnknownIds: 1 } })
    const receipt = handle.prompt('root')
    await receipt.acceptance
    await f.control({
      events: ['unknown-one', 'unknown-two'].map((id) => ({
        type: 'response',
        id,
        command: 'prompt',
        success: true,
      })),
    })
    expect(await receipt.completion).toMatchObject({
      status: 'failed',
      code: 'PI_UNKNOWN_RESPONSE_LIMIT',
    })
  })
  it('32: JSONL count, byte and backpressure bounds preserve split Unicode frames', async () => {
    let callback: ((error?: Error | null) => void) | undefined
    const output: string[] = []
    const stdin = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, done) {
        output.push(chunk.toString())
        callback = done
      },
    })
    const stdout = new PassThrough()
    const received: unknown[] = []
    const transport = new JsonlTransport({
      stdin,
      stdout,
      maxQueuedFrames: 1,
      maxQueuedBytes: 100,
      maxLineBytes: 90,
      onValue: (value) => {
        received.push(value)
      },
    })
    try {
      const send = transport.send({ type: 'prompt', message: '界\u2028\u2029' })
      await expect(transport.send({ type: 'abort' })).rejects.toThrow(
        'queue is full',
      )
      callback!()
      await send
      expect(JSON.parse(output[0]!)).toEqual({
        type: 'prompt',
        message: '界\u2028\u2029',
      })
      const response = Buffer.from('{"type":"agent_start","value":"界"}\r\n')
      stdout.write(response.subarray(0, response.length - 4))
      stdout.write(response.subarray(response.length - 4))
      expect(received).toEqual([{ type: 'agent_start', value: '界' }])
      await expect(transport.send({ value: '界'.repeat(30) })).rejects.toThrow(
        'frame exceeds limit',
      )
    } finally {
      await transport.close()
    }
  })
  it('28, 52: snapshots retain own undefined without later caller mutation', () => {
    const source = {
      env: { KNOWN_KEY: undefined as string | undefined },
      args: ['--flag', 'value'],
    }
    const captured = snapshot(source)
    source.env.KNOWN_KEY = 'later'
    source.args[1] = 'later'
    expect(Object.hasOwn(captured.env, 'KNOWN_KEY')).toBe(true)
    expect(captured.env.KNOWN_KEY).toBeUndefined()
    expect(captured.args[1]).toBe('value')
    expect(Object.isFrozen(captured.args)).toBe(true)
  })
  it('50: publication count and bytes are independent and charge every channel', () => {
    const a = new PublicationBudget(2, 1000)
    const b = new PublicationBudget(10, 20)
    PublicationBudget.charge(10, a, b)
    PublicationBudget.charge(10, a, b)
    expect(() => PublicationBudget.charge(0, a, b)).toThrow(
      'PI_PUBLICATION_LIMIT',
    )
    expect(() => PublicationBudget.charge(1, b)).toThrow('PI_PUBLICATION_LIMIT')
  })
  it('50: unknown type floods fail with bounded type retention', async () => {
    const f = await peer({ behavior: 'manual' })
    const { handle } = await f.start({ limits: { maxUnknownTypes: 2 } })
    const receipt = handle.prompt('root')
    await receipt.acceptance
    await f.control({
      events: [
        { type: 'future-1' },
        { type: 'future-2' },
        { type: 'future-3' },
      ],
    })
    expect(await receipt.completion).toMatchObject({
      status: 'failed',
      code: 'PI_UNKNOWN_EVENT_LIMIT',
    })
  })
})
