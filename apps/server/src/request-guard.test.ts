import { describe, expect, it } from 'vitest'
import { RequestGuard } from './request-guard.js'

describe('Forge request guard', () => {
  const guard = new RequestGuard({ mode: 'loopback' })
  const request = (headers: HeadersInit = {}, method = 'POST') =>
    new Request('http://127.0.0.1:3900/api/projects', { method, headers })

  it('allows same-origin mutations and non-browser clients', () => {
    expect(
      guard.check(
        request({ host: '127.0.0.1:3900', origin: 'http://127.0.0.1:3900' }),
        { mutation: true },
      ),
    ).toBeUndefined()
    expect(guard.check(request(), { mutation: true })).toBeUndefined()
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
        request({ host: 'forge.example', origin: 'https://forge.example' }),
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
})
