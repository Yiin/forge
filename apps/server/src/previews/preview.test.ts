import { createServer } from 'node:http'
import { describe, expect, it, afterEach } from 'vitest'
import { normalizePreviewOrigin, PreviewError } from './manager.js'
import { previewPublicRoutes, proxyPreview } from './transport.js'

const servers: ReturnType<typeof createServer>[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

describe('preview origin validation', () => {
  it('accepts and normalizes loopback origins', () => {
    expect(normalizePreviewOrigin('http://127.0.0.1:3000/')).toBe(
      'http://127.0.0.1:3000',
    )
    expect(normalizePreviewOrigin('https://[::1]:4443')).toBe(
      'https://[::1]:4443',
    )
  })
  it.each([
    'http://example.com:3000',
    'http://127.0.0.1:3000/app',
    'http://u:p@127.0.0.1:3000',
    'ftp://127.0.0.1:3000',
  ])('rejects unsafe origin %s', (origin) => {
    expect(() => normalizePreviewOrigin(origin)).toThrow(PreviewError)
  })
})

describe('preview transport', () => {
  it('proxies paths, queries, streams, and removes Forge credentials', async () => {
    const upstream = createServer((request, response) => {
      expect(request.url).toBe('/assets/app.js?x=1')
      expect(request.headers.cookie).toBeUndefined()
      expect(request.headers.authorization).toBeUndefined()
      response.setHeader('content-security-policy', "default-src 'self'")
      response.setHeader('x-frame-options', 'DENY')
      response.write('one')
      response.end('two')
    })
    servers.push(upstream)
    await new Promise<void>((resolve) =>
      upstream.listen(0, '127.0.0.1', resolve),
    )
    const address = upstream.address()
    if (!address || typeof address === 'string') throw new Error('no address')
    const manager = {
      acquire: () => ({
        target: { origin: `http://127.0.0.1:${address.port}` },
        release() {},
      }),
    } as never
    const response = await proxyPreview(
      new Request('http://preview.test/preview/t/assets/app.js?x=1', {
        headers: { cookie: 'forge=x', authorization: 'Bearer secret' },
      }),
      manager,
      't',
      '/assets/app.js',
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('onetwo')
    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'self'",
    )
    expect(response.headers.get('x-frame-options')).toBe('DENY')
  })

  it('does not expose API routes on the public listener', async () => {
    const app = previewPublicRoutes({} as never)
    expect(
      (await app.fetch(new Request('http://preview.test/api/previews'))).status,
    ).toBe(404)
  })

  it('rejects redirect escapes', async () => {
    const manager = {
      acquire: () => ({
        target: { origin: 'http://127.0.0.1:1' },
        release() {},
      }),
    } as never
    await expect(
      proxyPreview(
        new Request('http://preview.test/'),
        manager,
        't',
        '//example.com/',
      ),
    ).rejects.toThrow('escaped')
  })
})
