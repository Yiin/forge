import { StringDecoder } from 'node:string_decoder'
import type { NativeProcess } from './process.js'
import {
  DiagnosticTail,
  diagnosticError,
  positiveLimit,
} from './diagnostics.js'

const MiB = 1024 * 1024
/** Reviewed ceilings. Overrides may reduce, but never increase, these limits. */
export const openCodeLimitCeilings = Object.freeze({
  startupMs: 300_000,
  healthMs: 2_000,
  healthPollMs: 100,
  httpMs: 15_000,
  sseReadyMs: 15_000,
  sseQuietMs: 45_000,
  sseLeaseMs: 1_800_000,
  recoveryMs: 30_000,
  reconnectAttempts: 5,
  preparationMs: 15_000,
  activityMs: 60_000,
  ownershipMs: 15_000,
  commandMs: 1_800_000,
  abortMs: 10_000,
  requestLifetimeMs: 86_400_000,
  stdoutBytes: 16 * 1024,
  diagnosticBytes: 64 * 1024,
  frameBytes: 8 * MiB,
  frameLines: 256,
  eventCount: 256,
  eventBytes: 8 * MiB,
  idBytes: 512,
  cursorBytes: 4096,
  metadataBytes: 16 * MiB,
  responseBytes: 4 * MiB,
  errorBytes: 64 * 1024,
  bodyBytes: 24 * MiB,
  attachmentCount: 32,
  attachmentBytes: 8 * MiB,
  attachmentsBytes: 16 * MiB,
  inputCount: 128,
  inputBytes: MiB,
  queueCount: 16,
  queueBytes: 2 * MiB,
  ownerCount: 4096,
  ownerBytes: 4 * MiB,
  partCount: 8192,
  partBytes: 32 * MiB,
  textBytes: 4 * MiB,
  toolInputBytes: MiB,
  toolOutputBytes: 4 * MiB,
  toolMetadataBytes: 256 * 1024,
  unknownCount: 256,
  unknownBytes: 4 * MiB,
  childLiveCount: 128,
  childCount: 512,
  childDepth: 16,
  childBytes: 2 * MiB,
  requestCount: 64,
  requestsBytes: 2 * MiB,
  requestBytes: 64 * 1024,
  questionCount: 64,
  optionCount: 128,
  replyBytes: 256 * 1024,
  dedupCount: 32768,
  dedupBytes: 4 * MiB,
  receiptCount: 256,
  receiptBytes: 512 * 1024,
  providerCount: 512,
  modelCount: 8192,
  variantCount: 64,
  commandCount: 512,
  agentCount: 512,
  discoveryBytes: 4 * MiB,
  commandBytes: 64 * 1024,
  agentBytes: 4096,
  authorityBytes: 256 * 1024,
  envCount: 512,
  scopeCount: 256,
  scopeBytes: 512 * 1024,
  historyPages: 20,
  historyMessages: 2000,
  historyBytes: 32 * MiB,
  jobCount: 64,
  jobBytes: 256 * 1024,
  retainedBytes: 64 * MiB,
})
export type OpenCodeLimits = {
  [K in keyof typeof openCodeLimitCeilings]: number
}
export function limitsOf(
  overrides: Partial<OpenCodeLimits> = {},
): OpenCodeLimits {
  for (const [key, value] of Object.entries(overrides)) {
    if (
      !(key in openCodeLimitCeilings) ||
      positiveLimit(value, key) >
        openCodeLimitCeilings[key as keyof OpenCodeLimits]
    )
      throw fault(
        'LIMIT_INVALID',
        'OpenCode limit exceeds its reviewed ceiling',
      )
  }
  return { ...openCodeLimitCeilings, ...overrides }
}
export class OpenCodeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}
export const fault = (code: string, message: string) =>
  new OpenCodeError(`OPENCODE_${code}`, message)
export function bytes(value: unknown): number {
  return Buffer.byteLength(
    typeof value === 'string' ? value : (JSON.stringify(value) ?? ''),
  )
}
export function bound(value: unknown, max: number, label: string) {
  if (bytes(value) > max)
    throw fault('CAPACITY', `${label} exceeds the byte limit`)
}
export function string(value: unknown, max = 512): string {
  if (typeof value !== 'string' || !value || bytes(value) > max)
    throw fault('PROTOCOL', 'Invalid native string')
  return value
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw fault('PROTOCOL', 'Invalid native object')
  return value as Record<string, unknown>
}
export function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    throw fault('CAPACITY', 'Invalid or oversized native array')
  return value
}
export function nativeId(value: unknown, prefix: string, max = 512) {
  const id = string(value, max)
  if (!id.startsWith(prefix))
    throw fault('PROTOCOL', 'Invalid native identifier')
  return id
}
export function originOf(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw fault('ORIGIN_INVALID', 'Invalid native origin')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw fault(
      'ORIGIN_INVALID',
      'Native connection requires a bare HTTP origin',
    )
  if (
    url.protocol === 'http:' &&
    !['127.0.0.1', '[::1]'].includes(url.hostname)
  )
    throw fault(
      'ORIGIN_INVALID',
      'Non-loopback native connections require HTTPS',
    )
  return url.origin
}

/** Charges retained payloads before replacement, including generation tombstones. */
export class RetainedBudget {
  private readonly entries = new Map<string, number>()
  private total = 0
  constructor(private readonly maximum: number) {}
  put(key: string, value: unknown, cap: number) {
    this.putBytes(key, bytes(value), cap)
  }
  putBytes(key: string, size: number, cap: number) {
    if (
      size > cap ||
      this.total - (this.entries.get(key) ?? 0) + size > this.maximum
    )
      throw fault('CAPACITY', 'OpenCode retained state exceeds its byte limit')
    this.total += size - (this.entries.get(key) ?? 0)
    this.entries.set(key, size)
  }
  delete(key: string) {
    this.total -= this.entries.get(key) ?? 0
    this.entries.delete(key)
  }
  clear() {
    this.entries.clear()
    this.total = 0
  }
}

/** Incremental WHATWG SSE lines. An incomplete final frame is never dispatched. */
export class OpenCodeSseParser {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })
  private line = ''
  private data: string[] = []
  private size = 0
  private cr = false
  constructor(
    private readonly limits: OpenCodeLimits,
    private readonly onFrame: (data: string) => void,
    private readonly heartbeat: () => void,
  ) {}
  feed(chunk: Uint8Array) {
    for (let offset = 0; offset < chunk.byteLength; offset += 65536) {
      const text = this.decoder.decode(chunk.subarray(offset, offset + 65536), {
        stream: true,
      })
      for (const char of text) {
        if (this.cr && char === '\n') {
          this.cr = false
          continue
        }
        this.cr = char === '\r'
        if (char === '\r' || char === '\n') this.lineEnd()
        else {
          this.size += Buffer.byteLength(char)
          if (this.size > this.limits.frameBytes)
            throw fault('PROTOCOL', 'Native SSE frame exceeds the byte limit')
          this.line += char
        }
      }
    }
  }
  private lineEnd() {
    const line = this.line
    this.line = ''
    if (!line) {
      const data = this.data.join('\n')
      this.data = []
      this.size = 0
      if (data) this.onFrame(data)
    } else if (line.startsWith(':')) this.heartbeat()
    else {
      const colon = line.indexOf(':')
      const name = colon < 0 ? line : line.slice(0, colon)
      let value = colon < 0 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      if (name === 'data') {
        if (this.data.length >= this.limits.frameLines)
          throw fault('PROTOCOL', 'Too many native SSE data lines')
        this.data.push(value)
      }
    }
  }
}

type RequestOptions = {
  deadline?: number
  signal?: AbortSignal
  metadata?: boolean
  lane?: 'read' | 'root' | 'reply'
}
export class OpenCodeHttp {
  private readonly controller = new AbortController()
  private readonly active = { read: 0, root: 0, reply: 0 }
  constructor(
    readonly origin: string,
    readonly cwd: string,
    private readonly authorization: string | undefined,
    readonly limits: OpenCodeLimits,
    private readonly secrets: readonly string[],
  ) {}
  close() {
    this.controller.abort()
  }
  private headers() {
    const headers = new Headers({
      'x-opencode-directory': encodeURIComponent(this.cwd),
    })
    if (this.authorization) headers.set('authorization', this.authorization)
    return headers
  }
  async request(
    path: string,
    method = 'GET',
    body?: unknown,
    options: RequestOptions = {},
  ) {
    const lane = options.lane ?? (method === 'GET' ? 'read' : 'root')
    if (this.active[lane] >= (lane === 'root' ? 1 : 2))
      throw fault('CAPACITY', 'Native HTTP operation limit reached')
    const encoded = body === undefined ? undefined : JSON.stringify(body)
    if (encoded !== undefined)
      bound(
        encoded,
        lane === 'reply' ? this.limits.replyBytes : this.limits.bodyBytes,
        'Native request',
      )
    const deadline = options.deadline ?? performance.now() + this.limits.httpMs
    if (
      deadline <= performance.now() ||
      this.controller.signal.aborted ||
      options.signal?.aborted
    )
      throw fault('CANCELLED', 'Native request is no longer live')
    this.active[lane]++
    const controller = new AbortController()
    const signal = AbortSignal.any([
      controller.signal,
      this.controller.signal,
      ...(options.signal ? [options.signal] : []),
    ])
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(1, deadline - performance.now()),
    )
    let response: Response | undefined
    try {
      const headers = this.headers()
      if (encoded !== undefined) headers.set('content-type', 'application/json')
      response = await fetch(this.origin + path, {
        method,
        headers,
        ...(encoded === undefined ? {} : { body: encoded }),
        signal,
        redirect: 'manual',
      })
      const cap = response.ok
        ? options.metadata
          ? this.limits.metadataBytes
          : this.limits.responseBytes
        : this.limits.errorBytes
      const text = await readBody(response, cap)
      if (!response.ok)
        throw new OpenCodeError(
          'OPENCODE_HTTP_REJECTED',
          `Native HTTP request returned ${response.status}`,
          response.status,
        )
      let value: unknown
      try {
        value = text ? JSON.parse(text) : undefined
      } catch {
        throw fault('PROTOCOL', 'Native HTTP response is not JSON')
      }
      return {
        value,
        headers: response.headers,
        status: response.status,
        bytes: Buffer.byteLength(text),
      }
    } catch (error) {
      if (error instanceof OpenCodeError) throw error
      throw fault('HTTP_UNKNOWN', diagnosticError(error, this.secrets).message)
    } finally {
      clearTimeout(timer)
      controller.abort()
      this.active[lane]--
      await response?.body?.cancel().catch(() => {})
    }
  }
  connect(onFrame: (value: unknown) => boolean, deadline: number) {
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, this.controller.signal])
    let readyResolve!: () => void
    let readyReject!: (error: Error) => void
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve
      readyReject = reject
    })
    let connected = false
    let ended = false
    let quietTimer: ReturnType<typeof setTimeout> | undefined
    const readyTimer = setTimeout(
      () => controller.abort(),
      Math.max(
        1,
        Math.min(deadline - performance.now(), this.limits.sseReadyMs),
      ),
    )
    const leaseTimer = setTimeout(
      () => controller.abort(),
      this.limits.sseLeaseMs,
    )
    const heartbeat = () => {
      clearTimeout(quietTimer)
      quietTimer = setTimeout(() => controller.abort(), this.limits.sseQuietMs)
    }
    const done = (async (): Promise<Error> => {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      try {
        const response = await fetch(this.origin + '/global/event', {
          headers: this.headers(),
          signal,
          redirect: 'manual',
        })
        if (
          !response.ok ||
          !response.headers
            .get('content-type')
            ?.startsWith('text/event-stream') ||
          !response.body
        ) {
          await response.body?.cancel()
          throw fault('PROTOCOL', 'Native SSE response is invalid')
        }
        reader = response.body.getReader()
        const parser = new OpenCodeSseParser(
          this.limits,
          (data) => {
            let value: unknown
            try {
              value = JSON.parse(data)
            } catch {
              throw fault('PROTOCOL', 'Native SSE frame is not JSON')
            }
            const isConnected = onFrame(value)
            heartbeat()
            if (isConnected && !connected) {
              connected = true
              clearTimeout(readyTimer)
              readyResolve()
            }
          },
          heartbeat,
        )
        for (;;) {
          const next = await reader.read()
          if (next.done) throw fault('STREAM_GAP', 'Native SSE stream ended')
          parser.feed(next.value)
        }
      } catch (error) {
        const safe =
          error instanceof OpenCodeError
            ? error
            : fault('STREAM_GAP', diagnosticError(error, this.secrets).message)
        readyReject(safe)
        return safe
      } finally {
        ended = true
        clearTimeout(readyTimer)
        clearTimeout(leaseTimer)
        clearTimeout(quietTimer)
        controller.abort()
        await reader?.cancel().catch(() => {})
        reader?.releaseLock()
      }
    })()
    return {
      ready,
      done,
      close: () => controller.abort(),
      get closed() {
        return ended || signal.aborted
      },
    }
  }
}
async function readBody(response: Response, maximum: number) {
  const length = response.headers.get('content-length')
  if (length && Number(length) > maximum) {
    await response.body?.cancel()
    throw fault('CAPACITY', 'Native response exceeds the byte limit')
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > maximum)
        throw fault('CAPACITY', 'Native response exceeds the byte limit')
      chunks.push(next.value)
    }
    return new TextDecoder('utf8', { fatal: true }).decode(
      Buffer.concat(chunks, size),
    )
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** Continue draining stdout after readiness. NativeProcess owns permanent cleanup. */
export function ownedOrigin(
  runtime: NativeProcess,
  limits: OpenCodeLimits,
  secrets: readonly string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8')
    const tail = new DiagnosticTail(limits.diagnosticBytes, secrets)
    let line = ''
    let origin: string | undefined
    const onData = (chunk: Buffer) => {
      tail.append(chunk)
      try {
        for (let offset = 0; offset < chunk.length; offset += 4096) {
          line += decoder.write(chunk.subarray(offset, offset + 4096))
          let end: number
          while ((end = line.indexOf('\n')) >= 0) {
            const value = line.slice(0, end).replace(/\r$/, '')
            line = line.slice(end + 1)
            bound(value, limits.stdoutBytes, 'Native startup line')
            if (value.includes('opencode server listening on')) {
              const match =
                /^opencode server listening on (http:\/\/127\.0\.0\.1:([1-9]\d*))$/.exec(
                  value,
                )
              if (!match || Number(match[2]) > 65535)
                throw fault(
                  'ORIGIN_INVALID',
                  'Native startup announced an invalid origin',
                )
              if (origin && origin !== match[1])
                throw fault(
                  'ORIGIN_INVALID',
                  'Native startup announced conflicting origins',
                )
              origin = match[1]!
              resolve(origin)
            }
          }
          bound(line, limits.stdoutBytes, 'Native startup line')
        }
      } catch (error) {
        const safe = diagnosticError(error, secrets)
        reject(safe)
        void runtime.close(safe).catch(() => {})
      }
    }
    runtime.child.stdout.on('data', onData)
    void runtime.done.then((error) => {
      runtime.child.stdout.off('data', onData)
      tail.finish()
      reject(error)
    })
  })
}
