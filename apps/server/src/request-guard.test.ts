import { describe, expect, it } from 'vitest'
import { RequestGuard } from './request-guard.js'

describe('Forge request guard', () => {
  const guard = new RequestGuard({ mode: 'loopback' })
  guard.bind(3900)
  const request = (headers: HeadersInit = {}, method = 'POST') =>
    new Request('http://127.0.0.1:3900/api/projects', { method, headers })

  it('refuses loopback requests before the listener binds', () => {
    expect(new RequestGuard().check(request())).toBe(
      'Request listener is not ready',
    )
    expect(() => new RequestGuard().bind(0)).toThrow('actual bound HTTP port')
  })

  it('accepts canonical browser authorities on HTTP port 80', () => {
    const bound = new RequestGuard()
    bound.bind(80)
    expect(
      bound.check(
        new Request('http://localhost/api/health', {
          headers: { host: 'localhost', origin: 'http://localhost' },
        }),
      ),
    ).toBeUndefined()
  })

  it('does not derive an allowed browser Origin from an allowed backend Host', () => {
    const explicit = new RequestGuard({
      mode: 'explicit',
      allowedOrigins: ['https://forge.example'],
      allowedHostAuthorities: ['backend:8080'],
    })
    const incoming = {
      host: 'backend:8080',
      'content-type': 'application/json',
    }
    expect(
      explicit.check(
        new Request('http://backend:8080/api/projects', {
          method: 'POST',
          headers: { ...incoming, origin: 'http://backend:8080' },
        }),
        { mutation: true },
      ),
    ).toBe('Origin is not allowed')
    expect(
      explicit.check(
        new Request('http://backend:8080/api/projects', {
          method: 'POST',
          headers: { ...incoming, origin: 'https://forge.example' },
        }),
        { mutation: true },
      ),
    ).toBeUndefined()
  })

  it.each([
    'application/json-patch+json',
    'application/json.bad',
    'application/json, text/plain',
    'text/plain',
    'multipart/form-data',
  ])('rejects %s for JSON mutations', (type) => {
    expect(
      guard.check(request({ 'content-type': type }), { mutation: true }),
    ).toBe('JSON requests require application/json')
  })

  it('accepts JSON parameters but rejects malformed or missing browser metadata', () => {
    expect(
      guard.check(
        request({ 'content-type': 'application/json; charset=utf-8' }),
        { mutation: true },
      ),
    ).toBeUndefined()
    expect(
      guard.check(
        request({
          'content-type': 'application/json',
          'sec-fetch-site': 'same-origin',
        }),
        { mutation: true },
      ),
    ).toBe('Browser mutations require Origin')
    expect(
      guard.check(request({ 'sec-fetch-site': 'same-origin, cross-site' })),
    ).toBe('Fetch Metadata is not allowed')
  })

  it('allows same-origin mutations and non-browser clients', () => {
    expect(
      guard.check(
        request({
          host: '127.0.0.1:3900',
          origin: 'http://127.0.0.1:3900',
          'content-type': 'application/json',
        }),
        { mutation: true },
      ),
    ).toBeUndefined()
    expect(
      guard.check(request({ 'content-type': 'application/json' }), {
        mutation: true,
      }),
    ).toBeUndefined()
  })

  it('rejects browser boundary bypasses before application work', () => {
    expect(
      guard.check(
        request({ host: '127.0.0.1:3900', origin: 'http://evil.test' }),
        { mutation: true },
      ),
    ).toBe('Origin is not allowed')
    expect(
      guard.check(
        request({ origin: 'null', 'content-type': 'application/json' }),
        { mutation: true },
      ),
    ).toBe('Origin is not allowed')
    expect(
      guard.check(request({ 'content-type': 'text/plain' }), {
        mutation: true,
      }),
    ).toBe('JSON requests require application/json')
  })

  it('allows configured remote origins and rejects duplicate raw headers', () => {
    const configured = new RequestGuard({
      mode: 'explicit',
      allowedOrigins: ['https://forge.example'],
      allowedHostAuthorities: ['forge.example'],
    })
    expect(
      configured.check(
        request({
          host: 'forge.example',
          origin: 'https://forge.example',
          'content-type': 'application/json',
        }),
        { mutation: true },
      ),
    ).toBeUndefined()
    expect(
      configured.check(request(), {
        mutation: true,
        incoming: {
          rawHeaders: ['host', 'forge.example', 'host', 'forge.example'],
        } as never,
      }),
    ).toBe('Duplicate authority headers are not allowed')
  })

  it('binds loopback requests to the actual listener port', () => {
    const bound = new RequestGuard({ mode: 'loopback' })
    bound.bind(43123)
    expect(
      bound.check(
        request({
          host: '127.0.0.1:43123',
          origin: 'http://127.0.0.1:43123',
          'content-type': 'application/json',
        }),
        { mutation: true },
      ),
    ).toBeUndefined()
    expect(
      bound.check(
        request({
          host: '127.0.0.1:43124',
          origin: 'http://127.0.0.1:43124',
          'content-type': 'application/json',
        }),
        { mutation: true },
      ),
    ).toBe('Host is not allowed')
  })

  it('keeps the explicit Host policy independent from allowed origins', () => {
    const configured = new RequestGuard({
      mode: 'explicit',
      allowedOrigins: ['https://forge.example'],
      allowedHostAuthorities: ['forge.example'],
    })
    expect(
      configured.check(
        request({
          host: 'other.example',
          origin: 'https://forge.example',
          'content-type': 'application/json',
        }),
        { mutation: true },
      ),
    ).toBe('Host is not allowed')
    expect(
      configured.check(
        request({
          host: 'forge.example',
          origin: 'https://forge.example',
          'content-type': 'application/octet-stream',
        }),
        { mutation: true },
      ),
    ).toBe('JSON requests require application/json')
    expect(
      configured.check(
        new Request('https://forge.example/api/uploads/upload', {
          method: 'PUT',
          headers: {
            host: 'forge.example',
            origin: 'https://forge.example',
            'content-type': 'application/octet-stream',
          },
          body: 'bytes',
        }),
        { mutation: true },
      ),
    ).toBeUndefined()
  })
})
