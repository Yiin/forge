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

export class RequestGuard {
  private readonly origins: Set<string>
  private readonly hosts: Set<string>
  private readonly notified = new Set<string>()
  private bound = false

  constructor(
    private readonly access: TerminalAccess = { mode: 'loopback' },
    private readonly onLoopbackHostRejection: (
      authority: string,
    ) => void = () => {},
  ) {
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
    if (this.bound || !Number.isSafeInteger(port) || port < 1 || port > 65535)
      throw new Error('Request authority needs the actual bound HTTP port')
    if (this.access.mode === 'loopback') {
      this.hosts.clear()
      this.origins.clear()
      for (const host of ['localhost', '127.0.0.1', '[::1]']) {
        this.hosts.add(`${host}:${port}`)
        this.origins.add(`http://${host}:${port}`)
        if (port === 80) this.hosts.add(host)
      }
    }
    this.bound = true
  }

  private notifyLoopbackHostRejection(authority: string) {
    if (this.access.mode !== 'loopback') return
    const bracketEnd = authority.indexOf(']')
    const host =
      (bracketEnd < 0
        ? authority.split(':', 1)[0]
        : authority.slice(1, bracketEnd)) ?? ''
    const lower = host.toLowerCase()
    if (lower === 'localhost' || lower === '::1' || lower.startsWith('127.'))
      return
    if (this.notified.has(authority)) return
    this.notified.add(authority)
    this.onLoopbackHostRejection(authority)
  }

  check(
    request: Request,
    options: { mutation?: boolean; incoming?: IncomingMessage } = {},
  ) {
    if (this.access.mode === 'loopback' && !this.bound)
      return 'Request listener is not ready'
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
    if (!this.hosts.has(parsedHost)) {
      this.notifyLoopbackHostRejection(parsedHost)
      return 'Host is not allowed'
    }

    const origin = values(request, incoming, 'origin')[0]
    if (origin !== undefined) {
      if (origin === 'null') return 'Origin is not allowed'
      let parsedOrigin: string
      try {
        parsedOrigin = canonicalOrigin(origin)
      } catch {
        return 'Origin is not allowed'
      }
      if (!this.origins.has(parsedOrigin)) return 'Origin is not allowed'
    }

    const site = values(request, incoming, 'sec-fetch-site')[0]?.toLowerCase()
    if (
      site !== undefined &&
      !['none', 'same-origin', 'same-site', 'cross-site'].includes(site)
    )
      return 'Fetch Metadata is not allowed'
    if (site === 'cross-site') return 'Cross-site request is not allowed'
    if (options.mutation && site !== undefined && origin === undefined)
      return 'Browser mutations require Origin'

    if (options.mutation) {
      const contentType = values(request, incoming, 'content-type')[0]
        ?.split(';', 1)[0]
        ?.trim()
        .toLowerCase()
      const path = new URL(request.url).pathname
      const rawUpload =
        request.method.toUpperCase() === 'PUT' &&
        /^\/api\/uploads\/[^/]+$/.test(path)
      if (rawUpload) {
        if (contentType !== 'application/octet-stream')
          return 'Upload bytes require application/octet-stream'
      } else if (
        request.method.toUpperCase() !== 'DELETE' &&
        !bodylessMutation.test(path)
      ) {
        if (contentType !== 'application/json')
          return 'JSON requests require application/json'
      } else if (
        contentType !== undefined &&
        contentType !== 'application/json'
      )
        return 'Unsupported request media type'
    }
    return undefined
  }
}
