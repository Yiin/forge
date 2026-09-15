import { describe, expect, it, vi, afterEach } from 'vitest'
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import {
  terminalCreateSchema,
  terminalInputOutcomeSchema,
  terminalErrorSchema,
} from '@forge/protocol/terminal'
import { base64Size, TerminalInputScheduler, type InputOwner } from './input.js'
import {
  TerminalAuthority,
  canonicalAuthority,
  canonicalOrigin,
  validateTerminalAccess,
} from './origin.js'
import { resolveTerminalLimits } from './limits.js'
import type { LinuxPty } from './linux-pty.js'
import { WebSocketEventWriter } from '../ws-writer.js'

afterEach(() => vi.useRealTimers())
describe('terminal wire contracts', () => {
  it('requires W1 and rejects body ownership overrides', () => {
    expect(terminalCreateSchema.safeParse({}).success).toBe(false)
    expect(
      terminalCreateSchema.safeParse({
        expectedWorkspaceId: 'w',
        expectedWorkspaceRevision: 1,
        sessionId: 'other',
      }).success,
    ).toBe(false)
    expect(
      terminalCreateSchema.parse({
        expectedWorkspaceId: 'w',
        expectedWorkspaceRevision: 1,
        cols: -1,
        rows: 900,
      }),
    ).toMatchObject({ cols: 2, rows: 300 })
  })
  it('validates exact partial outcomes', () => {
    expect(
      terminalInputOutcomeSchema.parse({
        requestedBytes: 10,
        writtenBytes: 3,
        status: 'cancelled',
      }),
    ).toEqual({ requestedBytes: 10, writtenBytes: 3, status: 'cancelled' })
    for (const value of [
      { requestedBytes: 2, writtenBytes: 3, status: 'cancelled' },
      { requestedBytes: 3, writtenBytes: 2, status: 'written' },
      { requestedBytes: 3, writtenBytes: -1, status: 'closed' },
    ])
      expect(terminalInputOutcomeSchema.safeParse(value).success).toBe(false)
    expect(
      terminalErrorSchema.safeParse({
        error: { code: 'input_incomplete', message: 'Stopped' },
      }).success,
    ).toBe(false)
  })
  it('rejects noncanonical base64 before decoding', () => {
    expect(base64Size('', 10)).toBe(0)
    expect(base64Size('AA==', 10)).toBe(1)
    for (const value of [
      'AA',
      'AB==',
      'AAF=',
      'A===',
      'AAAA\n',
      '____',
      '====',
    ])
      expect(() => base64Size(value, 10)).toThrow()
    expect(() => base64Size('AAAA', 2)).toThrow()
  })
})
describe('terminal authority', () => {
  const request = (...headers: string[]) => {
    const incoming = new IncomingMessage(new Socket())
    incoming.rawHeaders = headers
    return incoming
  }
  it('uses the actual bound port and raw duplicate headers', () => {
    const policy = new TerminalAuthority({ mode: 'loopback' })
    expect(() =>
      policy.check(request('Host', 'localhost:3900'), false),
    ).toThrow(/not ready/)
    policy.bind(49152)
    expect(() =>
      policy.check(
        request('Host', '127.0.0.1:49152', 'Origin', 'http://localhost:49152'),
        true,
      ),
    ).not.toThrow()
    for (const raw of [
      ['Host', 'localhost:3900'],
      ['Host', 'localhost:49152', 'Host', 'localhost:49152'],
      ['Host', 'localhost:49152', 'Origin', 'null'],
      ['Host', 'localhost:49152', 'Origin', 'http://localhost:49153'],
      [
        'Host',
        'localhost:49152',
        'Origin',
        'http://localhost:49152',
        'Sec-Fetch-Site',
        'cross-site',
      ],
    ])
      expect(() => policy.check(request(...raw), true)).toThrow()
  })
  it('supports exact explicit proxy authority without forwarded grants', () => {
    const policy = new TerminalAuthority({
      mode: 'explicit',
      allowedOrigins: ['https://forge.example'],
      allowedHostAuthorities: ['forge.internal:3900'],
    })
    policy.bind(3900)
    expect(() =>
      policy.check(
        request(
          'Host',
          'forge.internal:3900',
          'Origin',
          'https://forge.example',
        ),
        true,
      ),
    ).not.toThrow()
    expect(() =>
      policy.check(
        request(
          'Host',
          'localhost:3900',
          'Origin',
          'https://forge.example',
          'X-Forwarded-Host',
          'forge.internal:3900',
        ),
        true,
      ),
    ).toThrow()
  })
  it('rejects ambiguous and duplicate configuration forms', () => {
    expect(canonicalOrigin('HTTPS://Forge.Example')).toBe(
      'https://forge.example:443',
    )
    expect(canonicalAuthority('[0:0:0:0:0:0:0:1]:3900')).toBe('[::1]:3900')
    for (const value of [
      'http://127.1',
      'http://0177.0.0.1',
      'http://0x7f000001',
      'http://a/',
      'http://a?x',
      'http://u@a',
      'null',
      'http://[fe80::1%25eth0]',
    ])
      expect(() => canonicalOrigin(value)).toThrow()
    expect(() =>
      validateTerminalAccess({
        mode: 'explicit',
        allowedOrigins: ['http://a', 'http://a:80'],
        allowedHostAuthorities: ['a'],
      }),
    ).toThrow(/duplicate/)
  })
})
describe('admitted input and writer retirement', () => {
  const owner = (
    write: (bytes: Buffer, offset: number, count: number) => number,
  ): InputOwner => ({
    native: { write, checkMaster: () => true } as unknown as LinuxPty,
    input: [],
    inputBytes: 0,
    acceptingInput: true,
  })
  it('reports partial cancellation after EAGAIN without retrying the prefix', async () => {
    vi.useFakeTimers()
    const scheduler = new TerminalInputScheduler(resolveTerminalLimits())
    let writes = 0
    const terminal = owner(() => {
      if (writes++ === 0) return 3
      throw Object.assign(new Error('held'), { code: 'EAGAIN' })
    })
    const controller = new AbortController()
    const result = scheduler.submit(
      terminal,
      Buffer.from('abcdef').toString('base64'),
      controller.signal,
    )
    await vi.advanceTimersByTimeAsync(1)
    controller.abort()
    expect(await result).toEqual({
      requestedBytes: 6,
      writtenBytes: 3,
      status: 'cancelled',
    })
    await vi.advanceTimersByTimeAsync(20)
    expect(writes).toBe(2)
    expect(scheduler.retainedBytes).toBe(0)
    scheduler.stop()
  })
  it('retains bounded queues and gives another terminal its host tick', async () => {
    vi.useFakeTimers()
    const scheduler = new TerminalInputScheduler(resolveTerminalLimits())
    const held = owner(() => {
      throw Object.assign(new Error('held'), { code: 'EAGAIN' })
    })
    const free = owner((_bytes, _offset, count) => count)
    const pending = Array.from({ length: 4 }, () =>
      scheduler.submit(held, 'AAAA'),
    )
    expect(() => scheduler.submit(held, 'AAAA')).toThrow(/capacity/)
    const passed = scheduler.submit(free, 'AAAA')
    await vi.advanceTimersByTimeAsync(1)
    expect((await passed).writtenBytes).toBe(3)
    scheduler.close(held)
    expect(
      (await Promise.all(pending)).every((value) => value.status === 'closed'),
    ).toBe(true)
    expect(scheduler.retainedBytes).toBe(0)
    scheduler.stop()
  })
  it('settles queued writes and a held drain after a send exception', async () => {
    const socket = {
      bufferedAmount: 0,
      close: vi.fn(),
      send: vi.fn(() => {
        throw new Error('send failed')
      }),
    }
    const writer = new WebSocketEventWriter(socket, vi.fn())
    expect(await writer.write('first')).toBe(false)
    expect(await writer.write('second')).toBe(false)
    expect(socket.close).toHaveBeenCalledOnce()
  })
  it('retires one stalled final write without later output', async () => {
    vi.useFakeTimers()
    const socket = {
      bufferedAmount: 0,
      close: vi.fn(),
      send: vi.fn(() => {
        socket.bufferedAmount = 10
      }),
    }
    let bytes = 0
    const retired = vi.fn()
    const writer = new WebSocketEventWriter(socket, retired, 2, {
      maxQueuedBytes: 20,
      writeDeadlineMs: 50,
      reserve: (n) => {
        bytes += n
        return true
      },
      release: (n) => {
        bytes -= n
      },
    })
    const pending = writer.write('final')
    await vi.advanceTimersByTimeAsync(51)
    expect(await pending).toBe(false)
    expect(retired).toHaveBeenCalledOnce()
    expect(bytes).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
