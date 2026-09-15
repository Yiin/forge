import type { IncomingMessage } from 'node:http'
import type { TerminalAccess } from '@forge/protocol/terminal'
import { canonicalAuthority, canonicalOrigin } from './terminals/origin.js'

const singletonHeaders = ['host', 'origin', 'sec-fetch-site', 'content-type']

function values(
  request: Request,
  incoming: IncomingMessage | undefined,
  name: string,
) {
  if (incoming) {
    const result: string[] = []
    for (let index = 0; index < incoming.rawHeaders.length; index += 2)
      if (incoming.rawHeaders[index]!.toLowerCase() === name)
        result.push(incoming.rawHeaders[index + 1]!)
    return result
  }
  const value = request.headers.get(name)
  return value === null ? [] : [value]
}

function loopbackHost(host: string) {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
}

function originHost(authority: string) {
  return authority.startsWith('[')
    ? authority.slice(0, authority.indexOf(']') + 1)
    : authority.slice(0, authority.lastIndexOf(':'))
}

export class RequestGuard {
  private readonly origins: Set<string>
  private readonly hosts: Set<string>

  constructor(private readonly access: TerminalAccess = { mode: 'loopback' }) {
    if (access.mode === 'explicit') {
      this.origins = new Set(access.allowedOrigins.map(canonicalOrigin))
      this.hosts = new Set(
        access.allowedHostAuthorities.map(canonicalAuthority),
      )
    } else {
      this.origins = new Set()
      this.hosts = new Set()
    }
  }

  check(
    request: Request,
    options: { mutation?: boolean; incoming?: IncomingMessage } = {},
  ) {
    const incoming = options.incoming
    for (const name of singletonHeaders)
      if (values(request, incoming, name).length > 1)
        return 'Duplicate authority headers are not allowed'

    const origin = values(request, incoming, 'origin')[0]
    if (origin !== undefined) {
      if (origin === 'null') return 'Origin is not allowed'
      let parsedOrigin: string
      try {
        parsedOrigin = canonicalOrigin(origin)
      } catch {
        return 'Origin is not allowed'
      }
      const authority = values(request, incoming, 'host')[0]
      let sameOrigin = false
      try {
        const url = new URL(request.url)
        sameOrigin =
          authority !== undefined &&
          parsedOrigin === `${url.protocol}//${canonicalAuthority(authority)}`
      } catch {
        sameOrigin = false
      }
      const originAuthority = parsedOrigin.slice(parsedOrigin.indexOf('//') + 2)
      const allowed =
        this.origins.has(parsedOrigin) ||
        (sameOrigin &&
          (this.access.mode === 'loopback'
            ? loopbackHost(originHost(originAuthority))
            : this.hosts.has(originAuthority)))
      if (!allowed) return 'Origin is not allowed'
    }

    if (
      values(request, incoming, 'sec-fetch-site').some(
        (value) => value.toLowerCase() === 'cross-site',
      )
    )
      return 'Cross-site request is not allowed'

    if (options.mutation) {
      const contentType = values(request, incoming, 'content-type')[0]
      if (contentType?.toLowerCase().startsWith('text/plain'))
        return 'JSON requests require application/json'
      if (
        contentType !== undefined &&
        !/^(application\/json|application\/octet-stream|multipart\/form-data)\b/i.test(
          contentType,
        )
      )
        return 'Unsupported request media type'
    }
    return undefined
  }
}
