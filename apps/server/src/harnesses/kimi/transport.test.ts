import { afterEach, describe, expect, test } from 'vitest'
import { createServer, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { WebSocketServer, type WebSocket } from 'ws'
import { KimiHttpClient, KimiSocket } from './transport.js'
import { KimiBudget, kimiLimits, type KimiLimits } from './limits.js'

const cleanup: (() => Promise<void>)[] = []
function controlled<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
function deep(depth: number) {
  let value: unknown = null
  for (let i = 0; i < depth; i++) value = { child: value }
  return value
}
async function httpPeer(
  reply: (path: string, response: ServerResponse, id: string) => void,
  overrides: Partial<KimiLimits> = {},
  checkToken: () => Promise<void> = async () => {},
) {
  const limits = kimiLimits(overrides),
    host = new KimiBudget(limits),
    budget = new KimiBudget(limits)
  let requests = 0
  const server = createServer((request, response) => {
    requests++
    expect(request.headers.authorization === 'Bearer fixture-token').toBe(true)
    reply(request.url!, response, String(request.headers['x-request-id']))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Fixture address')
  const client = new KimiHttpClient(
    address.port,
    'fixture-token',
    host,
    budget,
    checkToken,
  )
  cleanup.push(async () => {
    await client.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    expect(host.count('hostHttp')).toBe(0)
  })
  return { client, host, budget, requests: () => requests }
}
function envelope(
  response: ServerResponse,
  id: string,
  data: unknown,
  code = 0,
  status = 200,
) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ code, msg: 'fixture', data, request_id: id }))
}

describe('Kimi physical HTTP transport', () => {
  test('accepts both captured schemas only through explicit startup parsing', async () => {
    const schemas = new Map(
      await Promise.all(
        ['openapi.json', 'asyncapi.json'].map(
          async (name) =>
            [
              name,
              await readFile(
                new URL(`./__fixtures__/${name}`, import.meta.url),
              ),
            ] as const,
        ),
      ),
    )
    for (const [name, hash] of [
      [
        'openapi.json',
        'e09ce513e9be1bacfb33298aa60d2da701e57e20eb7837042cb55a48a88b7e73',
      ],
      [
        'asyncapi.json',
        'e841206eee6e5b9aff8f8df5de242224296a1650f0e11f884b7ef3f0789eb09c',
      ],
    ]) {
      expect(
        createHash('sha256').update(schemas.get(name)!).digest('hex'),
      ).toBe(hash)
      expect(JSON.parse(schemas.get(name)!.toString())).toBeDefined()
    }
    const fixture = await httpPeer((path, response) =>
      response.end(schemas.get(path.slice(1))),
    )
    for (const path of ['/openapi.json', '/asyncapi.json'] as const) {
      await expect(
        fixture.client.startupSchema(path, new AbortController().signal),
      ).resolves.toBeDefined()
      await expect(fixture.client.call(path)).rejects.toMatchObject({
        code: 'kimi_startup_schema_only',
      })
    }
    expect(fixture.requests()).toBe(2)
  })
  test('rejects schema depth 65 and keeps ordinary data at depth 32', async () => {
    const fixture = await httpPeer((path, response, id) =>
      path === '/openapi.json'
        ? response.end(JSON.stringify(deep(65)))
        : envelope(response, id, deep(33)),
    )
    await expect(
      fixture.client.startupSchema(
        '/openapi.json',
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'kimi_json_limit' })
    await expect(fixture.client.call('/ordinary')).rejects.toMatchObject({
      code: 'kimi_json_limit',
    })
  })
  test.each([
    [{ jsonNodes: 4 }, { a: [1, 2, 3, 4] }],
    [{ jsonStringBytes: 8 }, { a: '123456789' }],
    [{ httpControlBytes: 32 }, { a: 'x'.repeat(33) }],
    [{ hostHttpBufferBytes: 32 }, { a: 'x'.repeat(33) }],
  ] as const)(
    'keeps the ordinary parser and buffer ceilings %j',
    async (limits, data) => {
      const fixture = await httpPeer(
        (_path, response, id) => envelope(response, id, data),
        limits,
      )
      await expect(fixture.client.call('/ordinary')).rejects.toBeDefined()
      await fixture.client.close()
      expect(fixture.host.count('hostHttpBufferBytes')).toBe(0)
    },
  )
  test('native nonzero rejection stays definite after one mutation', async () => {
    const fixture = await httpPeer((_path, response, id) =>
      envelope(response, id, {}, 40001, 400),
    )
    await expect(
      fixture.client.call('/mutation', { method: 'POST', body: {} }),
    ).rejects.toMatchObject({ code: 'kimi_native_40001', uncertain: false })
    expect(fixture.requests()).toBe(1)
  })
  test('invalid mutation envelopes stay unknown and never retry', async () => {
    const fixture = await httpPeer((_path, response) =>
      response.end('{"code":0}'),
    )
    await expect(
      fixture.client.call('/mutation', { method: 'POST', body: {} }),
    ).rejects.toMatchObject({ code: 'kimi_delivery_unknown', uncertain: true })
    expect(fixture.requests()).toBe(1)
  })
  test.each(['redirect', 'compression', 'utf8'] as const)(
    'rejects %s without following or decoding it',
    async (kind) => {
      const fixture = await httpPeer((_path, response) => {
        if (kind === 'redirect')
          response.writeHead(302, { location: '/another' })
        if (kind === 'compression')
          response.writeHead(200, { 'content-encoding': 'gzip' })
        response.end(kind === 'utf8' ? Buffer.from([0xff]) : '{}')
      })
      await expect(fixture.client.call('/ordinary')).rejects.toBeDefined()
      expect(fixture.requests()).toBe(1)
    },
  )
  test('holds request occupancy until a timed-out body physically closes', async () => {
    const entered = controlled<void>()
    const fixture = await httpPeer(
      (_path, response) => {
        response.writeHead(200)
        response.write('{')
        entered.resolve()
      },
      { httpMs: 25, runtimeHttp: 1 },
    )
    const pending = fixture.client.call('/slow')
    await entered.promise
    expect(fixture.budget.count('runtimeHttp')).toBe(1)
    await expect(fixture.client.call('/overflow')).rejects.toMatchObject({
      code: 'kimi_resource_limit',
    })
    await expect(pending).rejects.toBeDefined()
    await fixture.client.close()
    expect(fixture.budget.count('runtimeHttp')).toBe(0)
  })
  test('closing an admitted token read waits for it and prevents a late POST', async () => {
    const entered = controlled<void>(),
      resume = controlled<void>()
    const fixture = await httpPeer(
      (_path, response, id) => envelope(response, id, {}),
      {},
      async () => {
        entered.resolve()
        await resume.promise
      },
    )
    const pending = fixture.client.call('/mutation', {
      method: 'POST',
      body: {},
    })
    const rejected = expect(pending).rejects.toBeDefined()
    await entered.promise
    let closed = false
    const closing = fixture.client.close().then(() => {
      closed = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(closed).toBe(false)
    expect(fixture.budget.count('runtimeHttp')).toBe(1)
    expect(fixture.requests()).toBe(0)
    resume.resolve()
    await Promise.all([closing, rejected])
    expect(fixture.requests()).toBe(0)
    expect(fixture.budget.count('runtimeHttp')).toBe(0)
  })
})

async function socketPeer(
  handle: (socket: WebSocket, frame: Record<string, unknown>) => void,
  overrides: Partial<KimiLimits> = {},
) {
  const limits = kimiLimits(overrides),
    host = new KimiBudget(limits),
    budget = new KimiBudget(limits),
    failed = controlled<Error>()
  const server = createServer(),
    wss = new WebSocketServer({
      server,
      perMessageDeflate: false,
      handleProtocols: (values) =>
        values.has('kimi-code.bearer.fixture-token')
          ? 'kimi-code.bearer.fixture-token'
          : false,
    })
  let peer!: WebSocket
  wss.on('connection', (socket) => {
    peer = socket
    socket.send(
      JSON.stringify({
        type: 'server_hello',
        payload: { protocol_version: 2 },
      }),
    )
    socket.on('message', (bytes) => handle(socket, JSON.parse(String(bytes))))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Fixture address')
  const frames: unknown[] = []
  const socket = new KimiSocket(
    address.port,
    'fixture-token',
    host,
    budget,
    (value) => frames.push(value),
    failed.resolve,
  )
  cleanup.push(async () => {
    await socket.close()
    for (const peer of wss.clients) peer.terminate()
    await new Promise<void>((resolve) => wss.close(() => resolve()))
    await new Promise<void>((resolve) => server.close(() => resolve()))
    expect(host.count('hostSockets')).toBe(0)
    expect(host.count('hostTimers')).toBe(0)
  })
  await socket.ready
  return { socket, peer: () => peer, failed: failed.promise, frames, budget }
}
function ack(socket: WebSocket, frame: Record<string, unknown>, changes = {}) {
  socket.send(
    JSON.stringify({
      type: 'ack',
      id: frame.id,
      code: 0,
      msg: 'fixture',
      payload: { ok: true },
      ...changes,
    }),
  )
}
describe('Kimi physical WebSocket transport', () => {
  test('registers controls before synchronous acknowledgement and accepts exact duplicates', async () => {
    const fixture = await socketPeer((socket, frame) => {
      ack(socket, frame)
      ack(socket, frame)
    })
    await expect(fixture.socket.control('client_hello', {})).resolves.toEqual({
      ok: true,
    })
    await expect(fixture.socket.control('subscribe', {})).resolves.toEqual({
      ok: true,
    })
  })
  test.each(['wrong', 'conflict', 'nonzero'] as const)(
    'rejects %s control acknowledgements',
    async (kind) => {
      const fixture = await socketPeer((socket, frame) => {
        if (kind === 'wrong') ack(socket, frame, { id: 'unknown' })
        else if (kind === 'nonzero') ack(socket, frame, { code: 42 })
        else {
          ack(socket, frame)
          ack(socket, frame, { payload: { changed: true } })
        }
      })
      const work = fixture.socket.control('subscribe', {})
      if (kind === 'conflict') {
        await work
        expect((await fixture.failed).message).toContain('conflict')
      } else await expect(work).rejects.toBeDefined()
    },
  )
  test('times out missing controls and records late IDs without reusing them', async () => {
    let saved: Record<string, unknown> | undefined
    let respond = false
    const fixture = await socketPeer(
      (socket, frame) => {
        saved = frame
        if (respond) ack(socket, frame)
      },
      { controlMs: 50, pendingControls: 1 },
    )
    await expect(fixture.socket.control('subscribe', {})).rejects.toMatchObject(
      { code: 'kimi_control_timeout' },
    )
    expect(fixture.budget.count('pendingControls')).toBe(1)
    await expect(fixture.socket.control('subscribe', {})).rejects.toMatchObject(
      { code: 'kimi_resource_limit' },
    )
    ack(fixture.peer(), saved!)
    await expect.poll(() => fixture.budget.count('pendingControls')).toBe(0)
    respond = true
    await expect(fixture.socket.control('subscribe', {})).resolves.toEqual({
      ok: true,
    })
    expect(saved?.id).not.toBe('control-1')
  })
  test.each(['message', 'fragments', 'binary', 'invalid'] as const)(
    'closes physical %s traffic before publication',
    async (kind) => {
      const fixture = await socketPeer(() => {}, {
        wsMessageBytes: 128,
        wsFragments: 2,
      })
      if (kind === 'message') fixture.peer().send('x'.repeat(129))
      if (kind === 'fragments') {
        fixture.peer().send('a', { fin: false })
        fixture.peer().send('b', { fin: false })
        fixture.peer().send('c', { fin: true })
      }
      if (kind === 'binary') fixture.peer().send(Buffer.from([1, 2, 3]))
      if (kind === 'invalid') fixture.peer().send('{')
      await fixture.failed
      expect(fixture.frames).toEqual([])
    },
  )
})
