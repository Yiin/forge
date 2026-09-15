import { afterEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import { TerminalRequests, terminalRoutes } from './terminals.js'
import { TerminalAuthority } from '../terminals/origin.js'
import { resolveTerminalLimits } from '../terminals/limits.js'
import { TerminalError } from '../terminals/error.js'
import type { TerminalManager } from '../terminals/manager.js'
import { WebSocketUpgrades } from '../ws-upgrade.js'

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const close of cleanup.splice(0)) close()
})
const base = 'http://127.0.0.1:49152',
  path = '/api/sessions/s/terminals'
function fixture() {
  const app = new Hono(),
    requests = new TerminalRequests(1, 20),
    upgrades = new WebSocketUpgrades(app)
  const authority = new TerminalAuthority({ mode: 'loopback' })
  authority.bind(49152)
  const manager = {
    limits: resolveTerminalLimits(),
    list: vi.fn(() => ({ serverEpoch: 'test', terminals: [] })),
    create: vi.fn(async () => ({ created: true })),
    input: vi.fn(),
  }
  app.route(
    '/',
    terminalRoutes(
      manager as unknown as TerminalManager,
      authority,
      upgrades,
      requests,
    ),
  )
  const call = (request: Request, raw?: string[]) => {
    const socket = new Socket(),
      incoming = new IncomingMessage(socket)
    incoming.rawHeaders =
      raw ??
      [...request.headers.entries()].flatMap(([key, value]) => [key, value])
    cleanup.push(() => socket.destroy())
    return app.request(request, undefined, { incoming })
  }
  const request = (
    method = 'GET',
    body?: BodyInit,
    headers: Record<string, string> = {},
    signal?: AbortSignal,
  ) =>
    new Request(`${base}${path}`, {
      method,
      headers: {
        host: '127.0.0.1:49152',
        origin: base,
        'content-type': 'application/json',
        ...headers,
      },
      ...(body === undefined ? {} : { body, duplex: 'half' }),
      signal,
    } as RequestInit)
  return { app, requests, manager, request, call }
}
describe('bounded terminal HTTP requests', () => {
  it('retains a cancelled body reader through physical cancellation and refuses another request', async () => {
    const { requests, manager, request, call } = fixture()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const cancel = vi.fn(() => held)
    const response = await call(request('POST', new ReadableStream({ cancel })))
    expect(response.status).toBe(503)
    expect((await response.json()).error.code).toBe('request_timeout')
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(requests.count).toBe(1)
    expect((await call(request())).status).toBe(429)
    expect(manager.create).not.toHaveBeenCalled()
    release()
    await requests.settled()
    expect(requests.count).toBe(0)
    expect((await call(request())).status).toBe(200)
  })

  it('rejects raw duplicate authorities before reading ownership or bodies', async () => {
    const { manager, request, call } = fixture()
    for (const raw of [
      ['Host', '127.0.0.1:49152', 'Host', '127.0.0.1:49152'],
      ['Host', '127.0.0.1:49152', 'Origin', base, 'Origin', base],
      ['Host', '127.0.0.1:49152', 'Origin', 'null'],
      [
        'Host',
        '127.0.0.1:49152',
        'Origin',
        base,
        'Sec-Fetch-Site',
        'cross-site',
      ],
      ['Host', 'unlisted:49152', 'Origin', 'http://unlisted:49152'],
    ])
      expect((await call(request(), raw)).status).toBe(403)
    expect(
      (await call(request('POST', '{}'), ['Host', '127.0.0.1:49152'])).status,
    ).toBe(403)
    expect(manager.list).not.toHaveBeenCalled()
    expect(manager.create).not.toHaveBeenCalled()
  })

  it('rejects oversized and malformed JSON before create and keeps exact UTF-8 body limits', async () => {
    const { manager, request, call } = fixture()
    for (const body of ['x', '{', '"' + 'x'.repeat(8192) + '"'])
      expect((await call(request('POST', body))).status).toBe(400)
    expect(
      (await call(request('POST', '{}', { 'content-type': 'text/plain' })))
        .status,
    ).toBe(415)
    expect(
      (
        await call(
          request('POST', '{}', {
            'content-type': 'application/json; charset=utf-8',
          }),
        )
      ).status,
    ).toBe(201)
    expect(manager.create).toHaveBeenCalledTimes(1)
  })

  it('does not start a mutation after its original request was already aborted', async () => {
    const { manager, request, call, requests } = fixture()
    const controller = new AbortController()
    controller.abort()
    expect(
      (await call(request('POST', '{}', {}, controller.signal))).status,
    ).toBe(503)
    expect(manager.create).not.toHaveBeenCalled()
    await requests.settled()
    expect(requests.count).toBe(0)
  })

  it('preserves an admitted partial input response when the request deadline aborts it', async () => {
    const { manager, request, call, requests } = fixture()
    const outcome = {
      requestedBytes: 6,
      writtenBytes: 3,
      status: 'cancelled' as const,
    }
    manager.input.mockImplementation(
      (_session, _terminal, _data, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () =>
              reject(
                new TerminalError('input_incomplete', 409, 'Input stopped', {
                  input: outcome,
                }),
              ),
            { once: true },
          )
        }),
    )
    const original = request('POST', JSON.stringify({ data: 'YWJjZGVm' }))
    const response = await call(
      new Request(`${base}${path}/terminal/input`, original),
    )
    expect(response.status).toBe(409)
    expect((await response.json()).error.details).toEqual({ input: outcome })
    await requests.settled()
    expect(requests.count).toBe(0)
  })
})
