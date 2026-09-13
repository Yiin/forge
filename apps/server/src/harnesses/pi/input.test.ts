import { afterEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { PassThrough, Writable } from 'node:stream'
import { JsonlTransport } from '../jsonl.js'
import {
  captureInput,
  imageHash,
  prepareInput,
  persistWireImages,
  type LoadPiImage,
} from './input.js'
import {
  physicalState,
  physicalTestLimits,
  reservePhysical,
  MiB,
  limits,
  PiError,
  PiRouter,
} from './wire.js'
import {
  fixture,
  imageLoader,
  waitPhysicalIdle,
  latch,
  png,
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
  physicalTestLimits()
})
const imageInput = [
  { type: 'text' as const, text: 'Look' },
  { type: 'attachment' as const, attachmentId: 'owned', mime: 'image/png' },
]
describe('Pi input ownership', () => {
  it.each(['AAAA=', 'AAAA===', 'AAAA\n', 'AA-A', 'AA_A', 'AB==', 'AAB='])(
    'E2: malformed or noncanonical base64 rejects before a sink: %s',
    async (data) => {
      let calls = 0
      await expect(
        persistWireImages(
          { type: 'image', mimeType: 'image/png', data },
          {
            kind: 'history_import',
            forgeSessionId: 'fixture',
            importOperationId: 'fixture-import',
          },
          async () => {
            calls++
            throw Error('Unexpected sink')
          },
          new AbortController().signal,
          limits(),
          () => {},
        ),
      ).rejects.toThrow('PI_IMAGE_ENCODING')
      expect(calls).toBe(0)
      expect(physicalState().count).toBe(0)
    },
  )
  it('32, 33: prepared images retain physical capacity until the actual buffered write completes', async () => {
    let written: (() => void) | undefined
    const stdin = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, done) {
        written = done
      },
    })
    const stdout = new PassThrough()
    const transport = new JsonlTransport({ stdin, stdout, onValue: () => {} })
    const config = limits()
    const router = new PiRouter('owned-write', transport, config, () => {})
    const prepared = await prepareInput(
      captureInput(imageInput),
      'owned-session',
      imageLoader(),
      new AbortController().signal,
      config,
    )
    try {
      expect(physicalState().classes.attachment).toBe(1)
      const response = router.request(
        'prompt',
        { message: prepared.message, images: prepared.images },
        false,
        undefined,
        prepared.release,
      )
      void response.catch(() => {})
      expect(physicalState().classes.attachment).toBe(1)
      router.close(new PiError('PI_CANCELLED'))
      await expect(response).rejects.toThrow('PI_CANCELLED')
      expect(physicalState().classes.attachment).toBe(1)
      written!()
      written = undefined
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(physicalState().classes.attachment).toBe(0)
      expect(prepared.images).toEqual([])
    } finally {
      written?.()
      await transport.close()
      prepared.release()
    }
  })
  it('29: writes authorized image bytes in native order and retains saved images', async () => {
    const f = await peer()
    const { handle } = await f.start({ loadImage: imageLoader() })
    const receipt = handle.prompt([
      ...imageInput,
      { type: 'attachment', attachmentId: 'second', mime: 'image/png' },
    ])
    expect(await receipt.completion).toMatchObject({ status: 'completed' })
    const prompt = (await f.wire()).find((command) => command.type === 'prompt')
    expect(prompt?.images).toEqual([
      { type: 'image', mimeType: 'image/png', data: png.toString('base64') },
      { type: 'image', mimeType: 'image/png', data: png.toString('base64') },
    ])
    expect(await readFile(handle.binding!.sessionFile, 'utf8')).toContain(
      png.toString('base64'),
    )
    expect(f.images).toHaveLength(2)
    expect(JSON.stringify(f.records)).toContain('attachmentId')
  })
  it('31: sends a frame above the generic JSONL one MiB default', async () => {
    const f = await peer()
    const data = Buffer.alloc(1100 * 1024)
    png.copy(data)
    const { handle } = await f.start({ loadImage: imageLoader(data) })
    expect(await handle.prompt(imageInput).completion).toMatchObject({
      status: 'completed',
    })
    expect(
      Buffer.byteLength(
        JSON.stringify(
          (await f.wire()).find((command) => command.type === 'prompt'),
        ),
      ),
    ).toBeGreaterThan(MiB)
  })
  it.each([
    'foreign',
    'pending',
    'missing',
    'mime',
    'signature',
    'size',
    'hash',
    'oversize',
  ])('30: rejects invalid image %s before prompt submission', async (kind) => {
    const f = await peer()
    const load: LoadPiImage = async () => {
      if (['foreign', 'pending', 'missing'].includes(kind))
        throw new Error('Image not authorized')
      return {
        mime: kind === 'mime' ? 'image/jpeg' : 'image/png',
        sizeBytes:
          kind === 'size'
            ? png.length + 1
            : kind === 'oversize'
              ? 11 * MiB
              : png.length,
        sha256: kind === 'hash' ? '0'.repeat(64) : imageHash(png),
        readBytes: async () =>
          kind === 'signature' ? Buffer.alloc(png.length) : png,
      }
    }
    const { handle } = await f.start({ loadImage: load })
    expect(await handle.prompt(imageInput).completion).toMatchObject({
      status: 'failed',
    })
    expect((await f.wire()).some((command) => command.type === 'prompt')).toBe(
      false,
    )
  })
  it('24: empty direct queues reject before attachment callbacks', async () => {
    const f = await peer({ behavior: 'manual' })
    let loads = 0
    const { handle } = await f.start({
      loadImage: async () => {
        loads++
        return imageLoader()()
      },
    })
    const root = handle.prompt('root')
    await root.acceptance
    await f.control({ events: [{ type: 'agent_start' }] })
    await f.wait(
      () => f.events.some((event) => event.type === 'run_started') || false,
    )
    for (const method of ['steer', 'followUp'] as const) {
      const receipt = handle[method]([
        { type: 'attachment', attachmentId: 'owned', mime: 'image/png' },
      ])
      expect(await receipt.acceptance).toMatchObject({
        status: 'rejected',
        code: 'PI_EMPTY_TEXT_NATIVE_QUEUE_UNSUPPORTED',
      })
      expect(await receipt.delivery).toMatchObject({ status: 'not_sent' })
    }
    expect(loads).toBe(0)
    await handle.cancel()
  })
  it('29, 32: rejects text after images and measures Unicode input bytes', () => {
    expect(() => captureInput([imageInput[1]!, imageInput[0]!])).toThrow(
      'PI_INTERLEAVED_INPUT_UNSUPPORTED',
    )
    expect(() => captureInput('界'.repeat(Math.floor(MiB / 3) + 1))).toThrow(
      'PI_INPUT_TEXT_LIMIT',
    )
    expect(captureInput('line\r\n\u2028\u2029').message).toBe(
      'line\r\n\u2028\u2029',
    )
  })
  it('33, 45: cancelled replacement handles retain physical attachment occupancy until actual release', async () => {
    const held = latch()
    let loads = 0
    const load: LoadPiImage = async () => {
      loads++
      await held.promise
      return imageLoader()()
    }
    const receipts = []
    try {
      for (let index = 0; index < 2; index++) {
        const f = await peer()
        const entered = latch()
        const { handle } = await f.start({
          loadImage: async (...args) => {
            entered.resolve()
            return load(...args)
          },
        })
        const receipt = handle.prompt(imageInput)
        receipts.push(receipt)
        await entered.promise
        await handle.cancel()
        expect(await receipt.completion).toMatchObject({
          status: 'interrupted',
        })
      }
      expect(physicalState().classes.attachment).toBe(2)
      const f = await peer()
      const { handle } = await f.start({ loadImage: load })
      expect(await handle.prompt(imageInput).completion).toMatchObject({
        status: 'failed',
        code: 'PI_PHYSICAL_WORK_CAPACITY',
      })
      expect(loads).toBe(2)
    } finally {
      held.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    }
    for (const receipt of receipts)
      expect(await receipt.delivery).toMatchObject({ status: 'not_sent' })
  })
  it('33, 45: cancellation reaches a cooperative attachment read before any native input write', async () => {
    const f = await peer()
    const entered = latch()
    let aborted = false
    const { handle } = await f.start({
      loadImage: async () => ({
        mime: 'image/png',
        sizeBytes: png.length,
        sha256: imageHash(png),
        readBytes: (signal) =>
          new Promise((_resolve, reject) => {
            entered.resolve()
            signal.addEventListener(
              'abort',
              () => {
                aborted = true
                reject(new Error('Read aborted'))
              },
              { once: true },
            )
          }),
      }),
    })
    const receipt = handle.prompt(imageInput)
    await entered.promise
    await handle.cancel()
    expect(await receipt.completion).toMatchObject({ status: 'interrupted' })
    expect(aborted).toBe(true)
    expect((await f.wire()).some((command) => command.type === 'prompt')).toBe(
      false,
    )
  })
  it('33: exact count and byte reservations reject atomically without partial charges', () => {
    physicalTestLimits(8, 65 * MiB)
    const release = reservePhysical('attachment')
    expect(() => reservePhysical('image')).toThrow('PI_PHYSICAL_WORK_CAPACITY')
    expect(physicalState().bytes).toBe(64 * MiB)
    release()
    release()
    expect(physicalState().bytes).toBe(0)
    physicalTestLimits(1)
    const one = reservePhysical('sink', 10)
    expect(() => reservePhysical('sink', 10)).toThrow(
      'PI_PHYSICAL_WORK_CAPACITY',
    )
    one()
  })
  it('26, 33: native settlement rejects an unfinished queued attachment without sending it', async () => {
    const f = await peer({ behavior: 'manual' })
    const entered = latch()
    const held = latch()
    const { handle } = await f.start({
      loadImage: async () => {
        entered.resolve()
        await held.promise
        return imageLoader()()
      },
    })
    const root = handle.prompt('root')
    await root.acceptance
    await f.control({ events: [{ type: 'agent_start' }] })
    await f.wait(
      () => f.events.some((event) => event.type === 'run_started') || false,
    )
    const queued = handle.followUp(imageInput)
    await entered.promise
    try {
      await f.settle()
      expect(await queued.completion).toMatchObject({
        status: 'failed',
        code: 'PI_QUEUE_OWNER_ENDED',
      })
      expect(await root.completion).toMatchObject({ status: 'completed' })
      expect(
        (await f.wire()).some((command) => command.type === 'follow_up'),
      ).toBe(false)
    } finally {
      held.resolve()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  })
})
