import { createServer, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { HarnessEvent } from '@forge/protocol/harness'
import {
  OpenCodeHttp,
  OpenCodeSseParser,
  RetainedBudget,
  limitsOf,
  originOf,
  openCodeLimitCeilings,
} from './opencode-http.js'
import { BoundedStore, envelope } from './opencode-events.js'
import {
  createOpenCodeAdapter,
  type OpenCodeAdapterOptions,
  type OpenCodeNativeLaunchAuthority,
} from './opencode.js'
import { expectStopped } from './transport-test-helpers.js'

const fixture = fileURLToPath(
  new URL('./fixtures/opencode-server.mjs', import.meta.url),
)
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})
async function httpServer(handler: (response: ServerResponse) => void) {
  const server = createServer((_request, response) => handler(response))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Missing fixture address')
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  return `http://127.0.0.1:${address.port}`
}
async function owned(mode = 'normal', selected = false) {
  const cwd = await mkdtemp(join(tmpdir(), 'forge owned ž-'))
  const config = join(cwd, 'fixture.json')
  const report = join(cwd, 'report.json')
  cleanups.push(async () => {
    await rm(cwd, { force: true, recursive: true })
  })
  const env = {
    FORGE_OPENCODE_FIXTURE_CONFIG: config,
    XDG_DATA_HOME: '/fake/stale',
    OPENCODE_DB: '/fake/stale.db',
    OPENCODE_AUTH_CONTENT: 'fake-stale',
    OPENCODE_SERVER_PASSWORD: 'stale',
    OPENCODE_CONFIG_CONTENT:
      '{"plugin":["fixture"],"provider":{"fixture":{"options":{"apiKey":"fake-B"}}}}',
    FORGE_REMOVED: undefined,
  }
  const accountId = selected ? 'account-A' : null
  const harnessEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(env))
    if (value !== undefined) harnessEnv[key] = value
  const authority: OpenCodeNativeLaunchAuthority = {
    credentials: 'native-configured-sources',
    provider: 'fixture',
    canonicalCwd: cwd,
    account: {
      id: 'account-A',
      harnessKey: 'fixture',
      kind: 'opencode',
      adapterKind: 'native',
      homePath: cwd,
      disabledAt: null,
    },
    harness: {
      command: fixture,
      args: [],
      env: harnessEnv,
      enabled: true,
      adapterKind: 'native',
    },
    selectedEnvOverrides: { FORGE_REMOVED: undefined },
    credentialEnvironment: [
      { name: 'CLOUDFLARE_ACCOUNT_ID', value: undefined, accountId: null },
      { name: 'CLOUDFLARE_API_KEY', value: undefined, accountId: null },
    ],
  }
  const options: OpenCodeAdapterOptions = {
    provider: 'fixture',
    accountId,
    server: {
      mode: 'owned',
      executable: fixture,
      env,
      ...(selected ? { accountHome: cwd, nativeLaunch: authority } : {}),
    },
    limits: { startupMs: 1500, healthMs: 40, healthPollMs: 10 },
  }
  await writeFile(
    config,
    JSON.stringify({
      mode,
      report,
      expectedEnvironment: selected
        ? {
            XDG_DATA_HOME: cwd,
            OPENCODE_DB: join(cwd, 'opencode', 'opencode.db'),
            OPENCODE_AUTH_CONTENT: null,
            OPENCODE_CONFIG_CONTENT: env.OPENCODE_CONFIG_CONTENT,
            FORGE_REMOVED: null,
          }
        : {},
    }),
  )
  return {
    cwd,
    options,
    config,
    report,
    authority,
    env,
    session: { id: 'forge', provider: 'fixture', accountId, cwd },
  }
}

describe('OpenCode owned process and HTTP bounds', () => {
  it('O1: owned startup reads captured Session model id', async () => {
    const fake = await owned()
    const events: HarnessEvent[] = []
    const handle = await createOpenCodeAdapter(fake.options).spawn(
      { id: 'session', provider: 'fixture', cwd: fake.cwd },
      (event) => events.push(event),
    )
    cleanups.push(async () => {
      await handle.kill()
    })
    expect(handle.binding?.providerSessionId).toBe('ses_fixture')
    expect(handle.configOptions!()[0]!.options).toContainEqual({
      value: 'deep',
      name: 'deep',
    })
    expect(events).toEqual([])
  })

  it('keeps proved automatic work separate from the caller receipt', async () => {
    const fake = await owned('automatic')
    const events: HarnessEvent[] = []
    const handle = await createOpenCodeAdapter(fake.options).spawn(
      fake.session,
      (event) => events.push(event),
    )
    cleanups.push(async () => {
      await handle.kill()
    })
    const receipt = await handle.prompt('automatic work')
    expect(await receipt.completion).toMatchObject({
      status: 'failed',
      code: 'OPENCODE_OWNERSHIP_GAP',
    })
    expect(
      events.filter((event) => event.type === 'prompt_accepted'),
    ).toHaveLength(1)
    expect(events.filter((event) => event.type === 'run_started')).toHaveLength(
      2,
    )
    expect(
      events.find(
        (event) =>
          event.type === 'turn_completed' &&
          event.outcome.status === 'completed',
      )?.runId,
    ).not.toBe(receipt.runId)
  })
  it('loads the same native ID after an owned fake process restart', async () => {
    const fake = await owned()
    const first = await createOpenCodeAdapter(fake.options).spawn(
      fake.session,
      () => {},
    )
    cleanups.push(async () => {
      await first.kill()
    })
    const binding = first.binding
    await first.kill()
    const second = await createOpenCodeAdapter(fake.options).load(
      { ...fake.session, binding },
      () => {},
    )
    cleanups.push(async () => {
      await second.kill()
    })
    expect(second.binding).toEqual(binding)
    const report = JSON.parse(await readFile(fake.report, 'utf8'))
    expect(
      report.requests.some(
        (request: { method: string; path: string }) =>
          request.method === 'POST' && request.path === '/session',
      ),
    ).toBe(false)
  })
  it('starts the fixed port-zero serve child, authenticates, and cleans its process group', async () => {
    const fake = await owned()
    const handle = await createOpenCodeAdapter(fake.options).spawn(
      fake.session,
      () => {},
    )
    cleanups.push(async () => {
      await handle.kill()
    })
    const report = JSON.parse(await readFile(fake.report, 'utf8'))
    expect(report.args).toEqual([
      'serve',
      '--port',
      '0',
      '--hostname',
      '127.0.0.1',
    ])
    expect(report.basicOwned).toBe(true)
    expect(
      report.requests.every(
        (request: { authenticated: boolean; directoryMatches: boolean }) =>
          request.authenticated && request.directoryMatches,
      ),
    ).toBe(true)
    await handle.kill()
    await expectStopped(report.pid)
    expect(handle.binding?.providerSessionId).toBe('ses_fixture')
  })

  it.each(['exit', 'bad-origin', 'conflicting-origin', 'park-health'])(
    'cleans an owned %s startup failure',
    async (mode) => {
      const fake = await owned(mode)
      fake.options.limits = { ...fake.options.limits, startupMs: 250 }
      await expect(
        createOpenCodeAdapter(fake.options).spawn(fake.session, () => {}),
      ).rejects.toThrow()
      const report = JSON.parse(await readFile(fake.report, 'utf8'))
      await expectStopped(report.pid)
    },
  )

  it('uses matching selected records and preserves native configuration while replacing storage and inline auth', async () => {
    const fake = await owned('normal', true)
    const adapter = createOpenCodeAdapter(fake.options)
    fake.authority.account.id = 'mutated'
    fake.authority.harness.args!.push('acp')
    fake.authority.selectedEnvOverrides.FORGE_REMOVED = 'mutated'
    fake.env.OPENCODE_CONFIG_CONTENT = 'mutated'
    const handle = await adapter.spawn(fake.session, () => {})
    cleanups.push(async () => {
      await handle.kill()
    })
    const report = JSON.parse(await readFile(fake.report, 'utf8'))
    expect(report.environmentMatches).toBe(true)
    expect(report.basicOwned).toBe(true)
    await handle.kill()
    await expectStopped(report.pid)
  })

  it.each([
    'missing',
    'narrower',
    'provider',
    'account',
    'home',
    'cwd',
    'command',
    'args',
    'env',
    'disabled',
    'harness-disabled',
    'kind',
    'acp',
    'omitted-removal',
    'cloudflare',
  ])('rejects %s account authority before spawning', async (mode) => {
    const fake = await owned('normal', true)
    if (fake.options.server.mode !== 'owned')
      throw new Error('Expected owned fixture')
    if (mode === 'missing') delete fake.options.server.nativeLaunch
    if (mode === 'narrower')
      (fake.authority as unknown as { credentials: string }).credentials =
        'selected-home-only'
    if (mode === 'provider') fake.authority.provider = 'wrong'
    if (mode === 'account') fake.authority.account.id = 'wrong'
    if (mode === 'home') fake.authority.account.homePath = tmpdir()
    if (mode === 'cwd') fake.authority.canonicalCwd = tmpdir()
    if (mode === 'command') fake.authority.harness.command = '/missing'
    if (mode === 'args') fake.authority.harness.args = ['acp']
    if (mode === 'env')
      fake.options.server.env = { ...fake.env, EXTRA: 'wrong' }
    if (mode === 'disabled') fake.authority.account.disabledAt = 1
    if (mode === 'harness-disabled') fake.authority.harness.enabled = false
    if (mode === 'kind') fake.authority.account.kind = 'codex'
    if (mode === 'acp') fake.authority.harness.adapterKind = 'acp'
    if (mode === 'omitted-removal') {
      const env = { ...fake.env }
      delete env.FORGE_REMOVED
      fake.options.server.env = env
    }
    if (mode === 'cloudflare') {
      fake.options.server.env!.CLOUDFLARE_ACCOUNT_ID = 'fake-B'
      fake.authority.harness.env!.CLOUDFLARE_ACCOUNT_ID = 'fake-B'
      fake.authority.credentialEnvironment = []
    }
    await expect(async () =>
      createOpenCodeAdapter(fake.options).spawn(fake.session, () => {}),
    ).rejects.toThrow()
    await expect(readFile(fake.report)).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('accepts the exact recorded serve args and scoped inline credentials', async () => {
    const fake = await owned('normal', true)
    fake.authority.harness.args = [
      'serve',
      '--port',
      '0',
      '--hostname',
      '127.0.0.1',
    ]
    fake.authority.credentialEnvironment = [
      ...fake.authority.credentialEnvironment,
      {
        name: 'OPENCODE_AUTH_CONTENT',
        value: '{"fixture":"fake-A"}',
        accountId: 'account-A',
      },
    ]
    await writeFile(
      fake.config,
      JSON.stringify({
        report: fake.report,
        expectedEnvironment: { OPENCODE_AUTH_CONTENT: '{"fixture":"fake-A"}' },
      }),
    )
    const handle = await createOpenCodeAdapter(fake.options).spawn(
      fake.session,
      () => {},
    )
    cleanups.push(async () => {
      await handle.kill()
    })
    const report = JSON.parse(await readFile(fake.report, 'utf8'))
    expect(report.environmentMatches).toBe(true)
    await handle.kill()
    await expectStopped(report.pid)
  })

  it('requires exact attached origin rules before network access', () => {
    for (const origin of [
      'http://example.com',
      'http://localhost:1234',
      'https://user:secret@example.com',
      'https://example.com/path',
      'https://example.com/?query',
      'https://example.com/#fragment',
    ])
      expect(() => originOf(origin)).toThrow()
    expect(originOf('http://[::1]:1234')).toBe('http://[::1]:1234')
    expect(originOf('https://example.com/')).toBe('https://example.com')
  })

  it.each(['length', 'chunked', 'redirect', 'malformed', 'timeout'])(
    'cancels a %s HTTP response',
    async (mode) => {
      let destination = 0
      const dest = await httpServer((response) => {
        destination++
        response.end('{}')
      })
      const origin = await httpServer((response) => {
        if (mode === 'redirect')
          response.writeHead(302, { location: dest }).end()
        else if (mode === 'length')
          response.writeHead(200, { 'content-length': '10000' }).end()
        else if (mode === 'chunked') {
          response.writeHead(200)
          response.write('x'.repeat(1000))
        } else if (mode === 'malformed') response.end('not json')
        else {
          response.writeHead(200)
          response.write('{')
        }
      })
      const client = new OpenCodeHttp(
        origin,
        '/fixture',
        undefined,
        limitsOf({ responseBytes: 20, httpMs: 30 }),
        [],
      )
      await expect(client.request('/test')).rejects.toThrow()
      client.close()
      expect(destination).toBe(0)
    },
  )

  it('reads split UTF-8, CRLF, multiline data and comments from a real SSE stream', async () => {
    const event = {
      directory: '/ž',
      payload: {
        id: 'evt_connected',
        type: 'server.connected',
        properties: {},
      },
    }
    const bytes = Buffer.from(
      `: heartbeat\r\n\r\ndata: ${JSON.stringify(event)}\r\n\r\n`,
    )
    const origin = await httpServer((response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const byte of bytes) response.write(Buffer.from([byte]))
    })
    const limits = limitsOf({ sseReadyMs: 1000 })
    const client = new OpenCodeHttp(origin, '/ž', undefined, limits, [])
    const frames: unknown[] = []
    const stream = client.connect((value) => {
      frames.push(value)
      return envelope(value, limits).payload.type === 'server.connected'
    }, performance.now() + 1000)
    await stream.ready
    expect(frames).toEqual([event])
    stream.close()
    await stream.done
    client.close()
  })

  it.each(['\n', '\r', '\r\n'])(
    'parses all SSE line endings with one-byte chunks: %j',
    (newline) => {
      const frames: string[] = []
      let heartbeats = 0
      const parser = new OpenCodeSseParser(
        limitsOf(),
        (frame) => frames.push(frame),
        () => {
          heartbeats++
        },
      )
      const text = `: ž${newline}${newline}retry: 1${newline}data: {${newline}data: "x": "ž"}${newline}${newline}data: incomplete`
      for (const byte of Buffer.from(text)) parser.feed(Buffer.from([byte]))
      expect(frames).toEqual(['{\n"x": "ž"}'])
      expect(heartbeats).toBe(1)
    },
  )

  it('rejects oversized SSE frames, line counts, and invalid UTF-8', () => {
    const parser = () =>
      new OpenCodeSseParser(
        limitsOf({ frameBytes: 20, frameLines: 1 }),
        () => {},
        () => {},
      )
    expect(() =>
      parser().feed(Buffer.from('data: ' + 'x'.repeat(30))),
    ).toThrow()
    expect(() => parser().feed(Buffer.from('data:a\ndata:b\n\n'))).toThrow()
    expect(() => parser().feed(new Uint8Array([0xff]))).toThrow()
  })

  it('does not accept comments or a malformed envelope as initial readiness', async () => {
    const origin = await httpServer((response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(': heartbeat\n\n')
    })
    const limits = limitsOf({ sseReadyMs: 30 })
    const client = new OpenCodeHttp(origin, '/fixture', undefined, limits, [])
    const stream = client.connect(
      (value) => envelope(value, limits).payload.type === 'server.connected',
      performance.now() + 30,
    )
    await expect(stream.ready).rejects.toThrow()
    await stream.done
    client.close()
    expect(() =>
      envelope(
        { id: 'evt_bare', type: 'server.connected', properties: {} },
        limits,
      ),
    ).toThrow()
  })

  it('charges each bounded store before insertion and releases charges on removal', () => {
    for (const [name, ceiling] of Object.entries(openCodeLimitCeilings)) {
      expect(() => limitsOf({ [name]: 0 })).toThrow()
      expect(() => limitsOf({ [name]: ceiling + 1 })).toThrow()
      expect(
        limitsOf({ [name]: 1 })[name as keyof typeof openCodeLimitCeilings],
      ).toBe(1)
    }
    const budget = new RetainedBudget(120)
    const owners = new BoundedStore('owners', 1, 100, budget)
    owners.put('a', { id: 'ž' })
    expect(() => owners.put('b', {})).toThrow()
    expect(owners.size).toBe(1)
    owners.delete('a')
    owners.put('b', {})
    expect(owners.has('b')).toBe(true)
    expect(() => owners.put('b', { data: 'x'.repeat(101) })).toThrow()
    expect(owners.get('b')).toEqual({})
    owners.clear()
    expect(owners.size).toBe(0)
  })
})
