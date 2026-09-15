import { test, expect, chromium } from '@playwright/test'
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { once } from 'node:events'
import { readFile, rm } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import {
  bounded,
  productionRequestServer,
} from '../helpers/productionRequestServer.js'

async function rawRequest(
  port: number,
  headers: string[],
  upgrade = false,
  body = '{}',
) {
  const socket = connect(port, '127.0.0.1')
  const closed = new Promise<void>((resolve) =>
    socket.once('close', () => resolve()),
  )
  try {
    return await new Promise<string>((resolve, reject) => {
      let output = ''
      const timer = setTimeout(() => {
        socket.destroy()
        reject(Error('Original raw socket did not close'))
      }, 5000)
      socket.on('data', (chunk) => {
        output += chunk.toString()
        if (output.length > 8192) {
          socket.destroy()
          reject(Error('Raw response exceeded fixture limit'))
        }
      })
      socket.once('error', reject)
      socket.once('close', () => {
        clearTimeout(timer)
        resolve(output)
      })
      socket.once('connect', () =>
        socket.end(
          [
            `${upgrade ? 'GET /ws' : 'POST /api/projects'} HTTP/1.1`,
            ...headers,
            ...(upgrade
              ? [
                  'Connection: Upgrade',
                  'Upgrade: websocket',
                  'Sec-WebSocket-Version: 13',
                  'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
                ]
              : [
                  'Connection: close',
                  'Content-Type: application/json',
                  `Content-Length: ${Buffer.byteLength(body)}`,
                ]),
            '',
            upgrade ? '' : body,
          ].join('\r\n'),
        ),
      )
    })
  } finally {
    socket.destroy()
    await closed
  }
}

test('production Node request boundaries reject preview scripts and preserve Forge clients', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium')
  test.skip(
    testInfo.project.name !== 'desktop',
    'Production authority does not depend on viewport',
  )
  test.setTimeout(60000)
  const cleanups: Array<() => Promise<void>> = []
  const errors: unknown[] = []
  const receipt: Record<string, unknown> = { node: process.version }
  try {
    const forge = await productionRequestServer()
    cleanups.push(async () => {
      receipt.forge = await forge.stop()
    })
    const attacker = createServer((_request, response) => {
      response.setHeader('Content-Type', 'text/html')
      response.end('<!doctype html><title>Synthetic preview</title>')
    })
    const attackerSockets = new Set<import('node:net').Socket>()
    attacker.on('connection', (socket) => {
      attackerSockets.add(socket)
      socket.once('close', () => attackerSockets.delete(socket))
    })
    cleanups.push(async () => {
      await new Promise<void>((resolve, reject) =>
        attacker.close((error) => (error ? reject(error) : resolve())),
      )
      expect(attackerSockets.size).toBe(0)
      receipt.attackerSockets = attackerSockets.size
    })
    attacker.listen(0, '0.0.0.0')
    await once(attacker, 'listening')
    const attackerPort = (attacker.address() as import('node:net').AddressInfo)
      .port
    const browserServer = await chromium.launchServer({ headless: true })
    const browserProcess = browserServer.process()
    const browserExit = new Promise<void>((resolve) =>
      browserProcess.once('exit', () => resolve()),
    )
    cleanups.push(async () => {
      await browserServer.close()
      await browserExit
      receipt.browserExited = true
    })
    receipt.browserPid = browserProcess.pid
    const browser = await chromium.connect(browserServer.wsEndpoint())
    cleanups.push(() => browser.close())
    const context = await browser.newContext({ serviceWorkers: 'block' })
    cleanups.push(() => context.close())
    const page = await context.newPage()
    const seen: Array<{ method: string; url: string; status: number }> = []
    page.on('response', (response) =>
      seen.push({
        method: response.request().method(),
        url: response.url(),
        status: response.status(),
      }),
    )
    receipt.requests = seen
    // Do not intercept browser requests: interception suppresses Chromium's
    // native CORS preflight and invalidates this production boundary proof.
    await page.goto(`${forge.baseUrl}/api/health`)
    const replay = await page.evaluate(
      async () =>
        new Promise<string>((resolve, reject) => {
          const socket = new WebSocket(
            location.origin.replace('http', 'ws') + '/ws',
          )
          const timer = setTimeout(() => {
            socket.close()
            reject(Error('Same-origin replay timed out'))
          }, 4000)
          let transcript = ''
          socket.onopen = () =>
            socket.send(
              JSON.stringify({ type: 'subscribe', sessions: 'all', cursor: 0 }),
            )
          socket.onmessage = (event) => {
            transcript += event.data
            socket.close()
          }
          socket.onclose = () => {
            clearTimeout(timer)
            resolve(transcript)
          }
          socket.onerror = () => {
            clearTimeout(timer)
            reject(Error('Same-origin websocket failed'))
          }
        }),
    )
    expect(replay).toContain('BOUNDARY_SYNTHETIC_TRANSCRIPT')
    const created = await page.evaluate(async (path) => {
      const response = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Allowed browser project', path }),
      })
      return { status: response.status, body: await response.json() }
    }, forge.project)
    expect(created.status).toBe(201)
    const before = await forge.snapshot()
    for (const [name, host, sandbox] of [
      ['separate-host', '127.0.0.2', 'allow-scripts allow-same-origin'],
      ['same-site', '127.0.0.1', 'allow-scripts allow-same-origin'],
      ['opaque', '127.0.0.2', 'allow-scripts'],
    ]) {
      await page.evaluate(
        ({ name, url, sandbox }) => {
          const frame = document.createElement('iframe')
          frame.name = name
          frame.sandbox.value = sandbox
          frame.src = url
          document.body.append(frame)
        },
        {
          name: name!,
          url: `http://${host}:${attackerPort}/${name}`,
          sandbox: sandbox!,
        },
      )
      const frame = await expect
        .poll(() => page.frame({ name: name! })?.url())
        .toContain(`/${name}`)
        .then(() => page.frame({ name: name! })!)
      const result = await frame.evaluate(
        async ({ baseUrl, project }) => {
          for (const [path, body] of [
            [
              '/api/projects',
              { name: 'Forbidden preview project', path: project },
            ],
            [
              '/api/sessions/boundary-session/prompt',
              { text: 'Forbidden preview prompt' },
            ],
          ] as const)
            await fetch(baseUrl + path, {
              method: 'POST',
              mode: 'no-cors',
              headers: { 'content-type': 'text/plain' },
              body: JSON.stringify(body),
            })
          let preflightRejected = false
          try {
            await fetch(baseUrl + '/api/projects', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                name: 'Forbidden JSON project',
                path: project,
              }),
            })
          } catch {
            preflightRejected = true
          }
          const ws = await new Promise<{ opened: boolean; frames: number }>(
            (resolve, reject) => {
              const socket = new WebSocket(
                baseUrl.replace('http', 'ws') + '/ws',
              )
              let opened = false,
                frames = 0
              const timer = setTimeout(() => {
                socket.close()
                reject(Error('Rejected websocket did not close'))
              }, 4000)
              socket.onopen = () => {
                opened = true
                socket.send(
                  JSON.stringify({
                    type: 'subscribe',
                    sessions: 'all',
                    cursor: 0,
                  }),
                )
                socket.close()
              }
              socket.onmessage = () => frames++
              socket.onerror = () => {}
              socket.onclose = () => {
                clearTimeout(timer)
                resolve({ opened, frames })
              }
            },
          )
          return { preflightRejected, ws }
        },
        { baseUrl: forge.baseUrl, project: forge.project },
      )
      expect(result).toEqual({
        preflightRejected: true,
        ws: { opened: false, frames: 0 },
      })
      expect(await forge.snapshot()).toEqual(before)
      await page.evaluate(
        (name) => document.querySelector(`iframe[name="${name}"]`)!.remove(),
        name!,
      )
    }
    const serverTraffic = await forge.traffic()
    for (const origin of [
      `http://127.0.0.2:${attackerPort}`,
      `http://127.0.0.1:${attackerPort}`,
      'null',
    ]) {
      for (const url of [
        '/api/projects',
        '/api/sessions/boundary-session/prompt',
      ]) {
        expect(
          serverTraffic
            .filter(
              (entry) =>
                entry.method === 'POST' &&
                entry.url === url &&
                entry.origin === origin,
            )
            .map((entry) => entry.status),
        ).toEqual([403])
      }
    }
    expect(
      serverTraffic.filter(
        (entry) => entry.method === 'OPTIONS' && entry.url === '/api/projects',
      ),
    ).toHaveLength(3)
    expect(
      serverTraffic
        .filter((entry) => entry.method === 'OPTIONS')
        .every((entry) => entry.status === 403),
    ).toBe(true)
    const uploadSource = stripTypeScriptTypes(
      await readFile(
        new URL('../../apps/web/src/lib/upload.ts', import.meta.url),
        'utf8',
      ),
    )
    const upload = await page.evaluate(async (source) => {
      const url = URL.createObjectURL(
        new Blob([source], { type: 'text/javascript' }),
      )
      try {
        const { putUpload } = await import(url)
        const file = new File(['synthetic upload bytes'], 'synthetic.txt', {
          type: 'text/plain',
        })
        const response = await fetch('/api/sessions/boundary-session/uploads', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            filename: file.name,
            mime: file.type,
            sizeBytes: file.size,
          }),
        })
        const init = await response.json()
        await putUpload(init, file)
        return { status: response.status, init, size: file.size }
      } finally {
        URL.revokeObjectURL(url)
      }
    }, uploadSource)
    expect(upload.status).toBe(201)
    expect((await forge.snapshot()).attachments).toEqual([
      {
        status: 'complete',
        size_bytes: upload.size,
        mime: 'text/plain',
        bytes: Buffer.from('synthetic upload bytes').toString('base64'),
      },
    ])
    const afterUpload = await forge.snapshot()
    const port = Number(new URL(forge.baseUrl).port),
      host = `127.0.0.1:${port}`
    for (const headers of [
      [`Host: ${host}`, `Host: ${host}`, `Origin: ${forge.baseUrl}`],
      [`Host: ${host}`, `Origin: ${forge.baseUrl}`, `Origin: ${forge.baseUrl}`],
      [`Host: ${host}`, 'Origin: null'],
      ['Host: [', `Origin: ${forge.baseUrl}`],
    ])
      for (const upgrade of [false, true])
        expect(await rawRequest(port, headers, upgrade)).toMatch(
          /^HTTP\/1\.1 (400|403)/,
        )
    expect((await forge.snapshot()).projects).toBe(before.projects)
    expect((await forge.snapshot()).messages).toBe(afterUpload.messages)
    // An owned proxy sends a configured backend Host distinct from the
    // browser Origin. The production server still owns its sole dispatcher.
    const backendHost = 'forge-backend.invalid:777'
    let upstreamPort = 0
    const proxySockets = new Set<import('node:net').Socket>()
    const proxyClosures: Promise<void>[] = []
    const track = (socket: import('node:net').Socket) => {
      proxySockets.add(socket)
      proxyClosures.push(
        new Promise((resolve) => socket.once('close', () => resolve())),
      )
      socket.once('close', () => proxySockets.delete(socket))
    }
    const proxy = createServer((request, response) => {
      const upstream = httpRequest(
        {
          hostname: '127.0.0.1',
          port: upstreamPort,
          path: request.url,
          method: request.method,
          headers: { ...request.headers, host: backendHost },
        },
        (result) => {
          response.writeHead(result.statusCode!, result.headers)
          result.pipe(response)
        },
      )
      upstream.once('socket', track)
      upstream.once('error', () => {
        response.destroy()
      })
      response.once('close', () => upstream.destroy())
      request.pipe(upstream)
    })
    proxy.on('connection', track)
    proxy.on('upgrade', (request, socket, head) => {
      const upstream = connect(upstreamPort, '127.0.0.1')
      track(upstream)
      socket.once('close', () => upstream.destroy())
      socket.once('error', () => upstream.destroy())
      upstream.once('close', () => socket.destroy())
      upstream.once('error', () => socket.destroy())
      upstream.once('connect', () => {
        upstream.write(
          `GET ${request.url} HTTP/1.1\r\n` +
            Object.entries({ ...request.headers, host: backendHost })
              .map(([key, value]) => `${key}: ${value}`)
              .join('\r\n') +
            '\r\n\r\n',
        )
        if (head.length) upstream.write(head)
        socket.pipe(upstream).pipe(socket)
      })
    })
    cleanups.push(async () => {
      const closing = new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      )
      for (const socket of proxySockets) socket.destroy()
      await bounded(
        Promise.all([closing, ...proxyClosures]),
        'Original proxy cleanup timed out',
        5000,
      )
      expect(proxySockets.size).toBe(0)
      receipt.proxySockets = proxySockets.size
    })
    proxy.listen(0, '127.0.0.1')
    await once(proxy, 'listening')
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as import('node:net').AddressInfo).port}`
    const remote = await productionRequestServer({
      origin: proxyUrl,
      host: backendHost,
    })
    cleanups.push(async () => {
      receipt.remote = await remote.stop()
    })
    upstreamPort = Number(new URL(remote.baseUrl).port)
    await page.goto(proxyUrl + '/api/health')
    const remoteCreated = await page.evaluate(
      async (path) =>
        (
          await fetch('/api/projects', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'Configured proxy browser', path }),
          })
        ).status,
      remote.project,
    )
    expect(remoteCreated).toBe(201)
    const remoteReplay = await page.evaluate(
      () =>
        new Promise<string>((resolve, reject) => {
          const ws = new WebSocket(
            location.origin.replace('http', 'ws') + '/ws',
          )
          let message = ''
          const timer = setTimeout(() => {
            ws.close()
            reject(Error('Proxy replay timed out'))
          }, 4000)
          ws.onopen = () =>
            ws.send(
              JSON.stringify({ type: 'subscribe', sessions: 'all', cursor: 0 }),
            )
          ws.onmessage = (event) => {
            message += event.data
            ws.close()
          }
          ws.onerror = () => {
            clearTimeout(timer)
            reject(Error('Proxy websocket failed'))
          }
          ws.onclose = () => {
            clearTimeout(timer)
            resolve(message)
          }
        }),
    )
    expect(remoteReplay).toContain('BOUNDARY_SYNTHETIC_TRANSCRIPT')
    const native = await rawRequest(
      upstreamPort,
      [`Host: ${backendHost}`],
      false,
      JSON.stringify({
        name: 'Supported non-browser client',
        path: remote.project,
      }),
    )
    expect(native).toMatch(/^HTTP\/1\.1 201/)
    const remoteBefore = await remote.snapshot()
    for (const upgrade of [false, true])
      expect(
        await rawRequest(
          upstreamPort,
          [`Host: ${backendHost}`, `Origin: http://${backendHost}`],
          upgrade,
        ),
      ).toMatch(/^HTTP\/1\.1 403/)
    expect(await remote.snapshot()).toEqual(remoteBefore)
  } catch (error) {
    errors.push(error)
  } finally {
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup()
      } catch (error) {
        errors.push(error)
      }
    }
    await testInfo.attach('production-ownership.json', {
      body: JSON.stringify(receipt),
      contentType: 'application/json',
    })
  }
  if (errors.length)
    throw new AggregateError(errors, 'Production request acceptance failed')
})

for (const fault of ['disconnect', 'refuse'] as const) {
  test(`production fixture joins its original child after ${fault}`, async ({
    browserName,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'Production cleanup does not depend on viewport',
    )
    expect(browserName).toBe('chromium')
    test.setTimeout(40000)
    const forge = await productionRequestServer(undefined, fault)
    const failure = await forge.stop().then(
      () => null,
      (error: unknown) => error,
    )
    try {
      expect(failure).toBeInstanceOf(AggregateError)
      expect(failure).toMatchObject({
        cleanup: { pid: forge.pid, graceful: false, physicallyClosed: true },
      })
      expect((failure as AggregateError).errors[0].message).toContain(
        fault === 'disconnect'
          ? 'disconnected'
          : 'Injected original cleanup refusal',
      )
      await expect(
        rawRequest(Number(new URL(forge.baseUrl).port), [
          `Host: ${new URL(forge.baseUrl).host}`,
        ]),
      ).rejects.toMatchObject({ code: 'ECONNREFUSED' })
      await testInfo.attach('fallback-ownership.json', {
        body: JSON.stringify(failure),
        contentType: 'application/json',
      })
    } finally {
      if (
        (failure as { cleanup?: { physicallyClosed?: boolean } })?.cleanup
          ?.physicallyClosed
      )
        await rm(forge.directory, { recursive: true, force: true })
      else await forge.stop()
    }
  })
}
