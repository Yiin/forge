import type { IncomingMessage } from 'node:http'
import { isIP } from 'node:net'
import {
  terminalAccessSchema,
  type TerminalAccess,
} from '@forge/protocol/terminal'
import { TerminalError } from './error.js'

function hostName(value: string) {
  if (value.startsWith('[')) {
    if (!value.endsWith(']') || isIP(value.slice(1, -1)) !== 6)
      throw new Error('Invalid IPv6 host')
    return new URL(`http://${value}`).hostname
  }
  const lower = value.toLowerCase()
  if (isIP(lower) === 4) return lower
  if (
    !lower ||
    lower.length > 253 ||
    lower.endsWith('.') ||
    /^[0-9.]+$/.test(lower) ||
    /^0x/i.test(lower) ||
    !lower
      .split('.')
      .every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
  )
    throw new Error('Invalid host')
  // URL parsing must not reinterpret a DNS name as an ambiguous IPv4 address.
  if (new URL(`http://${lower}`).hostname !== lower)
    throw new Error('Ambiguous host')
  return lower
}
function authorityParts(value: string) {
  if (Buffer.byteLength(value) > 256 || /[\s/@?#\\%]/.test(value))
    throw new Error('Invalid host authority')
  const match = /^(\[[^\]]+\]|[^:]+)(?::([0-9]+))?$/.exec(value)
  if (!match) throw new Error('Invalid host authority')
  const host = hostName(match[1]!)
  let port: number | null = null
  if (match[2] !== undefined) {
    port = Number(match[2])
    if (
      !Number.isSafeInteger(port) ||
      port < 1 ||
      port > 65535 ||
      String(port) !== match[2]
    )
      throw new Error('Invalid authority port')
  }
  return { host, port }
}
export function canonicalAuthority(value: string) {
  const { host, port } = authorityParts(value)
  return `${host}${port === null ? '' : `:${port}`}`
}
export function canonicalOrigin(value: string) {
  if (Buffer.byteLength(value) > 256)
    throw new Error('Origin exceeds its byte limit')
  const match = /^(https?):\/\/([^/]+)$/i.exec(value)
  if (!match)
    throw new Error('Origin must contain only HTTP scheme and authority')
  const scheme = match[1]!.toLowerCase()
  const { host, port } = authorityParts(match[2]!)
  return `${scheme}://${host}:${port ?? (scheme === 'https' ? 443 : 80)}`
}
export function validateTerminalAccess(value: unknown): TerminalAccess {
  const access = terminalAccessSchema.parse(value)
  if (access.mode === 'explicit') {
    const origins = access.allowedOrigins.map(canonicalOrigin)
    const hosts = access.allowedHostAuthorities.map(canonicalAuthority)
    if (
      new Set(origins).size !== origins.length ||
      new Set(hosts).size !== hosts.length
    )
      throw new Error(
        'Terminal access contains duplicate normalized authorities',
      )
  }
  return access
}
export class TerminalAuthority {
  private origins = new Set<string>()
  private hosts = new Set<string>()
  private bound = false
  private readonly config: TerminalAccess
  constructor(config: TerminalAccess) {
    this.config = validateTerminalAccess(config)
  }
  bind(port: number) {
    if (this.bound || !Number.isSafeInteger(port) || port < 1 || port > 65535)
      throw new Error('Terminal authority needs the actual bound HTTP port')
    if (this.config.mode === 'explicit') {
      this.origins = new Set(this.config.allowedOrigins.map(canonicalOrigin))
      this.hosts = new Set(
        this.config.allowedHostAuthorities.map(canonicalAuthority),
      )
    } else
      for (const host of ['localhost', '127.0.0.1', '[::1]']) {
        this.origins.add(`http://${host}:${port}`)
        this.hosts.add(`${host}:${port}`)
        if (port === 80) this.hosts.add(host)
      }
    this.bound = true
  }
  check(request: IncomingMessage, needsOrigin: boolean) {
    if (!this.bound)
      throw new TerminalError(
        'unavailable',
        503,
        'Terminal listener is not ready',
      )
    const headers = (name: string) => {
      const found: string[] = []
      for (let i = 0; i < request.rawHeaders.length; i += 2)
        if (request.rawHeaders[i]!.toLowerCase() === name)
          found.push(request.rawHeaders[i + 1]!)
      return found
    }
    const hosts = headers('host')
    const origins = headers('origin')
    try {
      if (hosts.length !== 1 || !this.hosts.has(canonicalAuthority(hosts[0]!)))
        throw new Error('Host is not allowed')
      if (
        origins.length > 1 ||
        (needsOrigin && origins.length !== 1) ||
        (origins.length === 1 &&
          !this.origins.has(canonicalOrigin(origins[0]!)))
      )
        throw new Error('Origin is not allowed')
      if (
        headers('sec-fetch-site').some(
          (value) => value.toLowerCase() === 'cross-site',
        )
      )
        throw new Error('Cross-site terminal request')
    } catch {
      throw new TerminalError(
        'forbidden',
        403,
        'Terminal request authority is not allowed',
      )
    }
  }
}
