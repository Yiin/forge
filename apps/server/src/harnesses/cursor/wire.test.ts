import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PassThrough, Writable } from 'node:stream'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { NativeProcess } from '../process.js'
import { CursorWire, cursorTransport } from './wire.js'
import { cursorLimits } from './limits.js'
import { deferred } from '../transport-test-helpers.js'
let root: string, peer: string
it('retains timed-out native control admission until its late reply and physical write both settle', async () => {
  const output = new PassThrough(),
    calls: string[] = []
  const input = new Writable({
    write(chunk, _encoding, callback) {
      calls.push(JSON.parse(chunk.toString()).requestId)
      callback()
    },
  })
  const wire = new CursorWire(
    input,
    output,
    'generation',
    cursorLimits({ controls: 2, controlMs: 20 }),
    () => {},
  )
  try {
    await expect(wire.request('models')).rejects.toThrow(
      'cursor_control_timeout',
    )
    for (let index = 0; index < 3; index++)
      await expect(wire.request('models')).rejects.toThrow(
        'cursor_control_limit',
      )
    expect(calls).toEqual(['1'])
    output.write(
      JSON.stringify({
        v: 1,
        generation: 'generation',
        seq: 1,
        type: 'models_result',
        requestId: '1',
        items: [],
      }) + '\n',
    )
    const next = wire.request('models')
    output.write(
      JSON.stringify({
        v: 1,
        generation: 'generation',
        seq: 2,
        type: 'models_result',
        requestId: '2',
        items: [],
      }) + '\n',
    )
    expect((await next).type).toBe('models_result')
    expect(calls).toEqual(['1', '2'])
  } finally {
    await wire.transport.close()
    wire.releaseAfterRetirement()
  }
})
it('keeps a replied control and its bytes charged through separate write callback and drain boundaries', async () => {
  const output = new PassThrough(),
    submitted = deferred<void>()
  let callback: ((error?: Error | null) => void) | undefined
  class HeldWritable extends Writable {
    override write(
      chunk: any,
      encodingOrCallback?: any,
      suppliedCallback?: any,
    ): boolean {
      callback =
        typeof encodingOrCallback === 'function'
          ? encodingOrCallback
          : suppliedCallback
      const frame = JSON.parse(chunk.toString())
      output.write(
        JSON.stringify({
          v: 1,
          generation: 'generation',
          seq: Number(frame.requestId),
          type: 'models_result',
          requestId: frame.requestId,
          items: [],
        }) + '\n',
      )
      submitted.resolve()
      return false
    }
  }
  const input = new HeldWritable(),
    wire = new CursorWire(
      input,
      output,
      'generation',
      cursorLimits({ controls: 2 }),
      () => {},
    )
  try {
    const response = wire.request('models')
    await submitted.promise
    expect((await response).type).toBe('models_result')
    expect(wire.transport.state.queuedFrames).toBe(1)
    const bytes = wire.transport.state.queuedBytes
    expect(bytes).toBeGreaterThan(0)
    await expect(wire.request('models')).rejects.toThrow('cursor_control_limit')
    callback!()
    await Promise.resolve()
    expect(wire.transport.state.queuedBytes).toBe(bytes)
    await expect(wire.request('models')).rejects.toThrow('cursor_control_limit')
    input.emit('drain')
    await vi.waitFor(() => expect(wire.transport.state.queuedFrames).toBe(0))
    await new Promise((resolve) => setImmediate(resolve))
    const next = wire.request('models')
    expect((await next).type).toBe('models_result')
    callback!()
    input.emit('drain')
  } finally {
    await wire.transport.close()
    wire.releaseAfterRetirement()
  }
})
beforeAll(async () => {
  root = await mkdtemp('/tmp/forge-cursor-wire-')
  peer = join(root, 'peer.mjs')
  await promisify(execFile)(
    'bun',
    [
      'build',
      '--target=node',
      resolve('apps/server/test/fixtures/cursor-wire-peer.ts'),
      '--outfile',
      peer,
    ],
    { timeout: 30000, maxBuffer: 4096 },
  )
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})
it('retains bounded frames while the real Node stdout pipe is blocked and settles each write once', async () => {
  const { process: child } = await NativeProcess.start(
    { command: process.execPath, args: [peer, 'blocked-output'], cwd: root },
    async () => {},
  )
  try {
    await vi.waitFor(() =>
      expect(child.diagnostics).toContain('fixture:blocked:2:'),
    )
    await vi.waitFor(() =>
      expect(child.diagnostics).toContain('fixture:diagnostic:3'),
    )
    expect(child.child.exitCode).toBe(null)
    child.child.stdout.resume()
    await vi.waitFor(() =>
      expect(child.diagnostics).toContain('fixture:settled:3'),
    )
    await child.done
    expect(child.diagnostics.match(/fixture:settled:/g)).toHaveLength(1)
  } finally {
    await child.close()
  }
})
it('rejects a control write after the real Node peer closes stdin', async () => {
  const { process: child } = await NativeProcess.start(
    { command: process.execPath, args: [peer, 'closed-input'], cwd: root },
    async () => {},
  )
  const transport = cursorTransport(
    child.child.stdin,
    child.child.stdout,
    'generation',
    cursorLimits(),
    () => {},
  )
  child.ownTransport(transport)
  try {
    await vi.waitFor(() =>
      expect(child.diagnostics).toContain('fixture:closed-input'),
    )
    await expect(
      transport.send({
        v: 1,
        generation: 'generation',
        type: 'models',
        requestId: '1',
      }),
    ).rejects.toThrow()
    expect(await transport.done).toBeInstanceOf(Error)
    expect(transport.state.queuedFrames).toBe(0)
  } finally {
    await child.close()
  }
})
it('expires a blocked control request while retaining its actual queued pipe bytes', async () => {
  const { process: child } = await NativeProcess.start(
    { command: process.execPath, args: [peer, 'blocked-input'], cwd: root },
    async () => {},
  )
  const wire = new CursorWire(
    child.child.stdin,
    child.child.stdout,
    'generation',
    cursorLimits({ controlMs: 100 }),
    () => {},
  )
  child.ownTransport(wire.transport)
  try {
    await vi.waitFor(() =>
      expect(child.diagnostics).toContain('fixture:blocked-input'),
    )
    await expect(
      wire.request('initialize', { identity: { padding: 'x'.repeat(700000) } }),
    ).rejects.toThrow('control_timeout')
    expect(wire.transport.state.queuedFrames).toBe(1)
    expect(wire.transport.state.queuedBytes).toBeGreaterThan(700000)
    await child.close()
    expect(wire.transport.state.queuedFrames).toBe(0)
  } finally {
    await child.close()
  }
})
it('reserves bounded control history for close and retirement after ordinary requests reach their limit', async () => {
  const { process: child } = await NativeProcess.start(
    { command: process.execPath, args: [peer, 'control-replies'], cwd: root },
    async () => {},
  )
  const wire = new CursorWire(
    child.child.stdin,
    child.child.stdout,
    'generation',
    cursorLimits({ owners: 5 }),
    () => {},
  )
  child.ownTransport(wire.transport)
  try {
    await wire.request('models')
    await wire.request('models')
    await expect(wire.request('models')).rejects.toThrow(
      'control_history_limit',
    )
    expect((await wire.request('close')).type).toBe('closed')
    expect((await wire.request('retire')).type).toBe('retired')
  } finally {
    await child.close()
  }
})
it('keeps one physical pending control slot for cancellation', async () => {
  const { process: child } = await NativeProcess.start(
    { command: process.execPath, args: [peer, 'blocked-input'], cwd: root },
    async () => {},
  )
  const wire = new CursorWire(
    child.child.stdin,
    child.child.stdout,
    'generation',
    cursorLimits({ controls: 2 }),
    () => {},
  )
  child.ownTransport(wire.transport)
  const ordinary = wire.request('models').catch((error: Error) => error)
  try {
    await expect(wire.request('models')).rejects.toThrow('control_limit')
    const cleanup = wire.request('cancel').catch((error: Error) => error)
    await expect(wire.request('retire')).rejects.toThrow('control_limit')
    await child.close()
    expect(await ordinary).toBeInstanceOf(Error)
    expect(await cleanup).toBeInstanceOf(Error)
  } finally {
    await child.close()
    await ordinary
  }
})
