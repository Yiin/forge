import type { IncomingMessage } from 'node:http'
import type { TerminalAccess } from '@forge/protocol/terminal'
import { canonicalAuthority, canonicalOrigin } from './terminals/origin.js'

const singletonHeaders = ['host', 'origin', 'sec-fetch-site', 'content-type']
const bodylessMutation =
  /\/(?:archive|cancel|clear-cooldown|discard|interrupt|keep|logout|pause|resume)$/

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

function hostAuthority(authority: string) {
  const separator = authority.lastIndexOf(':')
  return separator > authority.indexOf(']')
    ? authority.slice(0, separator)
    : authority
}

export class RequestGuard {
  private readonly origins: Set<string>
  private readonly hosts: Set<string>
  private bound = false

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

  bind(port: number) {
    if (this.access.mode === 'loopback') {
      this.hosts.clear()
      this.origins.clear()
      for (const host of ['localhost', '127.0.0.1', '[::1]']) {
        this.hosts.add(`${host}:${port}`)
        this.origins.add(`http://${host}:${port}`)
      }
    }
    this.bound = true
  }

  check(
    request: Request,
    options: { mutation?: boolean; incoming?: IncomingMessage } = {},
  ) {
    const incoming = options.incoming
    for (const name of singletonHeaders)
      if (values(request, incoming, name).length > 1)
        return 'Duplicate authority headers are not allowed'

    const host =
      values(request, incoming, 'host')[0] ??
      (incoming ? undefined : new URL(request.url).host)
    let parsedHost: string
    try {
      if (!host) throw new Error('Host is required')
      parsedHost = canonicalAuthority(host)
    } catch {
      return 'Host is not allowed'
    }
    const hostAllowed =
      this.access.mode === 'explicit'
        ? this.hosts.has(parsedHost)
        : this.bound
          ? this.hosts.has(parsedHost)
          : loopbackHost(hostAuthority(parsedHost))
    if (!hostAllowed) return 'Host is not allowed'

    const origin = values(request, incoming, 'origin')[0]
    if (origin !== undefined) {
      if (origin === 'null') return 'Origin is not allowed'
      let parsedOrigin: string
      try {
        parsedOrigin = canonicalOrigin(origin)
      } catch {
        return 'Origin is not allowed'
      }
      let sameOrigin = false
      try {
        const url = new URL(request.url)
        sameOrigin = parsedOrigin === `${url.protocol}//${parsedHost}`
      } catch {
        sameOrigin = false
      }
      const allowed = this.origins.has(parsedOrigin) || sameOrigin
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
      const path = new URL(request.url).pathname
      const rawUpload = /^\/api\/uploads\/[^/]+$/.test(path)
      if (rawUpload) {
        if (!contentType || !/^application\/octet-stream\b/i.test(contentType))
          return 'Upload bytes require application/octet-stream'
      } else if (
        request.method.toUpperCase() !== 'DELETE' &&
        !bodylessMutation.test(path)
      ) {
        if (!contentType || !/^application\/json\b/i.test(contentType))
          return 'JSON requests require application/json'
      } else if (
        contentType !== undefined &&
        !/^application\/json\b/i.test(contentType)
      )
        return 'Unsupported request media type'
    }
    return undefined
  }
}
