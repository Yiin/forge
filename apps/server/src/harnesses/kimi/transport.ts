import { request } from 'node:http'
import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import WebSocket from 'ws'
import {
  KimiError,
  KimiBudget,
  boundedString,
  deadline,
  jsonBytes,
  reserveAll,
} from './limits.js'

export function newKimiRequestId(): string {
  const bytes = Buffer.alloc(16)
  bytes.writeUIntBE(Date.now(), 0, 6)
  randomBytes(10).copy(bytes, 6)
  let value = BigInt(`0x${bytes.toString('hex')}`),
    id = ''
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  for (let i = 0; i < 26; i++) {
    id = alphabet[Number(value & 31n)] + id
    value >>= 5n
  }
  return id
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new KimiError('kimi_invalid_wire')
  return value as Record<string, unknown>
}
export function parseJson(
  bytes: Uint8Array,
  budget: KimiBudget,
  maximum: number,
): unknown {
  if (bytes.byteLength > maximum) throw new KimiError('kimi_json_bytes')
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes))
  } catch {
    throw new KimiError('kimi_invalid_json')
  }
  jsonBytes(value, budget.limits, maximum)
  return value
}
export type HttpOptions = {
  method?: 'GET' | 'POST' | 'DELETE'
  body?: unknown
  binary?: Uint8Array
  contentType?: string
  raw?: boolean
  maxBytes?: number
  dismiss?: boolean
  signal?: AbortSignal
}
export type KimiOwnedBytes = { bytes: Uint8Array; release(): void }

export function parseHttpEnvelope(
  bytes: Uint8Array,
  status: number,
  requestId: string,
  path: string,
  options: HttpOptions,
  budget: KimiBudget,
) {
  const value = parseJson(
    bytes,
    budget,
    options.maxBytes ?? budget.limits.httpControlBytes,
  )
  if (path === '/healthz') return value
  const envelope = object(value)
  if (
    envelope.request_id !== requestId ||
    typeof envelope.msg !== 'string' ||
    !Number.isSafeInteger(envelope.code) ||
    !Object.hasOwn(envelope, 'data')
  )
    throw new KimiError('kimi_invalid_envelope')
  if (
    envelope.code !== 0 &&
    !(
      options.dismiss &&
      /\/questions\/[^/]+:dismiss$/.test(path) &&
      envelope.code === 40909 &&
      object(envelope.data).dismissed === true
    )
  )
    throw new KimiError(
      `kimi_native_${envelope.code}`,
      'Kimi rejected the request',
    )
  if (status < 200 || status >= 300)
    throw new KimiError('kimi_invalid_envelope')
  return envelope.data
}

/** Only an owned guardian constructs this client with its private loopback endpoint and token. */
export class KimiHttpClient {
  private readonly controllers = new Set<AbortController>()
  private readonly physical = new Set<Promise<unknown>>()
  private closed = false
  /** The schema depth exception is available only to the owned startup caller. */
  async startupSchema(
    path: '/openapi.json' | '/asyncapi.json',
    signal: AbortSignal,
    maximum = this.budget.limits.httpJsonBytes,
  ): Promise<unknown> {
    if (path !== '/openapi.json' && path !== '/asyncapi.json')
      throw new KimiError('kimi_schema_route')
    const result = await this.bytes(path, {
      maxBytes: Math.min(maximum, this.budget.limits.httpJsonBytes),
      signal,
    })
    try {
      if (result.status !== 200) throw new KimiError('kimi_schema_http')
      const limits = {
        ...this.budget.limits,
        jsonDepth: this.budget.limits.schemaJsonDepth,
      }
      return parseJson(
        result.bytes,
        new KimiBudget(limits),
        this.budget.limits.httpJsonBytes,
      )
    } finally {
      result.release()
    }
  }
  constructor(
    private readonly port: number,
    private readonly token: string,
    private readonly host: KimiBudget,
    readonly budget: KimiBudget,
    private readonly checkToken: () => Promise<void>,
  ) {}

  /** Owned raw envelope transfer avoids a second JSON parse in the guardian. */
  wire(path: string, options: HttpOptions) {
    if (path === '/openapi.json' || path === '/asyncapi.json')
      throw new KimiError('kimi_startup_schema_only')
    return this.bytes(path, { ...options, raw: true })
  }

  async call(path: string, options: HttpOptions = {}): Promise<unknown> {
    if (path === '/openapi.json' || path === '/asyncapi.json')
      throw new KimiError('kimi_startup_schema_only')
    const result = await this.bytes(path, options)
    let transferred = false
    try {
      if (options.raw) {
        if (result.status < 200 || result.status >= 300)
          throw new KimiError('kimi_native_http_rejected')
        transferred = true
        return {
          bytes: result.bytes,
          release: result.release,
        } satisfies KimiOwnedBytes
      }
      return parseHttpEnvelope(
        result.bytes,
        result.status,
        result.requestId,
        path,
        options,
        this.budget,
      )
    } catch (error) {
      if (
        options.method &&
        options.method !== 'GET' &&
        !(error instanceof KimiError && error.code.startsWith('kimi_native_'))
      )
        throw new KimiError(
          'kimi_delivery_unknown',
          'Kimi mutation delivery is unknown',
          true,
        )
      throw error
    } finally {
      if (!transferred) result.release()
    }
  }

  private async bytes(path: string, options: HttpOptions) {
    const limits = this.budget.limits
    boundedString(path, limits.cursorBytes * 4)
    if (!path.startsWith('/') || path.startsWith('//') || /[\r\n\0]/.test(path))
      throw new KimiError('kimi_invalid_route')
    if (this.closed) throw new KimiError('kimi_transport_closed')
    options.signal?.throwIfAborted()
    const maximum = options.maxBytes ?? limits.httpControlBytes
    if (
      !Number.isSafeInteger(maximum) ||
      maximum < 1 ||
      maximum > limits.promptAttachmentBytes
    )
      throw new KimiError('kimi_response_limit')
    if (options.body !== undefined)
      jsonBytes(options.body, limits, limits.httpControlBytes)
    if (
      options.binary &&
      options.binary.byteLength > limits.promptAttachmentBytes
    )
      throw new KimiError('kimi_attachment_limit')
    const release = reserveAll([
      [this.host, 'hostHttp'],
      [this.budget, 'runtimeHttp'],
    ])
    let releaseTimer: () => void
    try {
      releaseTimer = reserveAll([
        [this.host, 'hostTimers'],
        [this.budget, 'timers'],
      ])
    } catch (error) {
      release()
      throw error
    }
    let payload: Buffer | undefined
    const requestId = newKimiRequestId()
    const controller = new AbortController()
    this.controllers.add(controller)
    const method = options.method ?? 'GET'
    let dispatched = false
    const buffers: Buffer[] = [],
      releaseBytes: (() => void)[] = []
    let closedResolve!: () => void
    const closed = new Promise<void>((resolve) => {
      closedResolve = resolve
    })
    this.physical.add(closed)
    void closed.then(() => this.physical.delete(closed))
    const endPhysical = () => {
      release()
      this.controllers.delete(controller)
      closedResolve()
    }
    const abort = () => controller.abort()
    options.signal?.addEventListener('abort', abort, { once: true })
    let requestCreated = false
    const physical = (async () => {
      this.budget.add('httpRequestsPerGeneration')
      await this.checkToken()
      if (this.closed) throw new KimiError('kimi_transport_closed')
      controller.signal.throwIfAborted()
      options.signal?.throwIfAborted()
      if (options.body !== undefined)
        releaseBytes.push(
          this.host.reserve(
            'hostHttpBufferBytes',
            3 * jsonBytes(options.body, limits, limits.httpControlBytes),
          ),
        )
      payload = options.binary
        ? Buffer.from(
            options.binary.buffer,
            options.binary.byteOffset,
            options.binary.byteLength,
          )
        : options.body !== undefined
          ? Buffer.from(JSON.stringify(options.body))
          : undefined
      return await new Promise<{
        bytes: Buffer
        requestId: string
        status: number
        release: () => void
      }>((resolve, reject) => {
        let size = 0,
          settled = false
        const fail = () => {
          if (settled) return
          settled = true
          reject(
            new KimiError(
              dispatched && method !== 'GET'
                ? 'kimi_delivery_unknown'
                : 'kimi_http_failed',
              'Kimi HTTP request failed',
              dispatched && method !== 'GET',
            ),
          )
        }
        const req = request(
          {
            hostname: '127.0.0.1',
            port: this.port,
            path,
            method,
            agent: false,
            maxHeaderSize: limits.httpHeaderBytes,
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${this.token}`,
              'X-Request-Id': requestId,
              'Accept-Encoding': 'identity',
              ...(payload
                ? {
                    'Content-Type': options.contentType ?? 'application/json',
                    'Content-Length': payload.length,
                  }
                : {}),
            },
          },
          (response) => {
            if (
              (response.statusCode ?? 500) < 200 ||
              ((response.statusCode ?? 500) >= 300 &&
                (response.statusCode ?? 500) < 400) ||
              (response.headers['content-encoding'] &&
                response.headers['content-encoding'] !== 'identity') ||
              response.rawHeaders.length > limits.httpHeaders * 2
            ) {
              response.destroy()
              req.destroy()
              fail()
              return
            }
            response.on('data', (chunk: Buffer) => {
              try {
                this.budget.add('httpResponseBytesPerGeneration', chunk.length)
                size += chunk.length
                if (size > maximum) throw new KimiError('kimi_response_limit')
                releaseBytes.push(
                  this.host.reserve('hostHttpBufferBytes', chunk.length),
                )
                buffers.push(chunk)
              } catch {
                response.destroy()
                req.destroy()
                fail()
              }
            })
            response.once('error', fail)
            response.once('aborted', fail)
            response.once('end', () => {
              if (!settled) {
                let free = () => {}
                try {
                  // The response and its decoded/parsed representation coexist during validation.
                  free = this.host.reserve(
                    'hostHttpBufferBytes',
                    size * (options.raw ? 1 : 4),
                  )
                  const bytes = Buffer.concat(buffers, size)
                  settled = true
                  resolve({
                    bytes,
                    requestId,
                    status: response.statusCode ?? 500,
                    release: free,
                  })
                } catch {
                  free()
                  response.destroy()
                  req.destroy()
                  fail()
                }
              }
            })
          },
        )
        req.once('error', fail)
        req.once('close', () => {
          if (!settled) fail()
          endPhysical()
        })
        requestCreated = true
        dispatched = true
        req.end(payload)
      })
    })().catch((error) => {
      if (!requestCreated) endPhysical()
      throw error
    })
    let returned = false
    try {
      const result = await deadline(physical, limits.httpMs, options.signal)
      returned = true
      return result
    } catch (error) {
      controller.abort()
      if (
        dispatched &&
        method !== 'GET' &&
        !(error instanceof KimiError && error.code.startsWith('kimi_native_'))
      )
        throw new KimiError(
          'kimi_delivery_unknown',
          'Kimi mutation delivery is unknown',
          true,
        )
      throw error
    } finally {
      releaseTimer()
      options.signal?.removeEventListener('abort', abort)
      // The guardian acknowledges an HTTP operation only after its socket closes.
      await closed
      void physical
        .then((result) => {
          if (!returned) result.release()
        })
        .finally(() => {
          releaseBytes.forEach((end) => end())
        })
        .catch(() => {})
    }
  }
  async close() {
    this.closed = true
    for (const controller of this.controllers) controller.abort()
    await Promise.allSettled(this.physical)
  }
}

type Pending = {
  resolve: (value: Record<string, unknown>) => void
  reject: (error: Error) => void
  release: () => void
  releaseTimer: () => void
  timer: ReturnType<typeof setTimeout>
}
export class KimiSocket {
  readonly done: Promise<void>
  readonly ready: Promise<void>
  private readonly socket: WebSocket
  private readonly pending = new Map<string, Pending>()
  private readonly tombstones = new Map<
    string,
    { value?: unknown; release: () => void }
  >()
  private controlOrdinal = 0
  private hello = false
  private closing?: Promise<void>
  private closeRequested = false
  private readonly frameWork = new Set<Promise<unknown>>()
  constructor(
    port: number,
    token: string,
    private readonly host: KimiBudget,
    readonly budget: KimiBudget,
    private readonly onFrame: (value: Record<string, unknown>) => unknown,
    private readonly onFailure: (error: Error) => void,
  ) {
    const limits = budget.limits
    const release = reserveAll([
      [host, 'hostSockets'],
      [budget, 'runtimeSockets'],
      [host, 'hostRetainedBytes', limits.wsMessageBytes],
    ])
    let releaseHandshake: () => void
    try {
      releaseHandshake = reserveAll([
        [host, 'hostTimers'],
        [budget, 'timers'],
      ])
    } catch (error) {
      release()
      throw error
    }
    let releaseReady: () => void
    try {
      releaseReady = reserveAll([
        [host, 'hostTimers'],
        [budget, 'timers'],
      ])
    } catch (error) {
      releaseHandshake()
      release()
      throw error
    }
    const socketOptions: WebSocket.ClientOptions & {
      maxFragments: number
      maxBufferedChunks: number
    } = {
      perMessageDeflate: false,
      followRedirects: false,
      maxPayload: limits.wsMessageBytes,
      maxFragments: limits.wsFragments,
      maxBufferedChunks: limits.wsBufferedChunks,
      handshakeTimeout: limits.controlMs,
    }
    try {
      this.socket = new WebSocket(
        `ws://127.0.0.1:${port}/api/v1/ws`,
        [`kimi-code.bearer.${token}`],
        socketOptions,
      )
    } catch (error) {
      releaseReady()
      releaseHandshake()
      release()
      throw error
    }
    this.socket.once('open', releaseHandshake)
    this.socket.once('close', releaseHandshake)
    let readyResolve!: () => void, readyReject!: (error: Error) => void
    this.ready = deadline(
      new Promise<void>((resolve, reject) => {
        readyResolve = resolve
        readyReject = reject
      }),
      limits.controlMs,
      undefined,
    ).finally(releaseReady)
    void this.ready.catch((error) => {
      this.onFailure(error)
      void this.close()
    })
    this.done = new Promise((resolve) =>
      this.socket.once('close', () => {
        release()
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer)
          pending.releaseTimer()
          pending.release()
          pending.reject(new KimiError('kimi_socket_closed'))
        }
        this.pending.clear()
        for (const entry of this.tombstones.values()) entry.release()
        this.tombstones.clear()
        readyReject(new KimiError('kimi_socket_closed'))
        if (!this.closeRequested) onFailure(new KimiError('kimi_socket_closed'))
        resolve()
      }),
    )
    this.socket.on('error', () => {
      readyReject(new KimiError('kimi_socket_failed'))
      onFailure(new KimiError('kimi_socket_failed'))
    })
    this.socket.on('message', (data, binary) => {
      let releaseFrame = () => {},
        transferred = false
      try {
        budget.add('wsFrames')
        const byteLength = Array.isArray(data)
          ? data.reduce((sum, part) => sum + part.byteLength, 0)
          : data.byteLength
        releaseFrame = host.reserve('hostRetainedBytes', byteLength * 4)
        const bytes = Array.isArray(data)
          ? Buffer.concat(data)
          : data instanceof ArrayBuffer
            ? Buffer.from(data)
            : data
        budget.add('wsInboundBytes', bytes.length)
        if (binary) throw new KimiError('kimi_binary_wire')
        const frame = object(parseJson(bytes, budget, limits.wsMessageBytes))
        const type = boundedString(frame.type, limits.nativeIdBytes)
        if (type === 'server_hello') {
          if (this.hello || object(frame.payload).protocol_version !== 2)
            throw new KimiError('kimi_protocol_version')
          this.hello = true
          readyResolve()
          return
        }
        if (!this.hello) throw new KimiError('kimi_missing_hello')
        if (type === 'ping') {
          this.send({
            type: 'pong',
            payload: { nonce: object(frame.payload).nonce },
          })
          return
        }
        if (type === 'ack') {
          const id = boundedString(frame.id, limits.controlIdBytes)
          const pending = this.pending.get(id)
          const value = {
            code: frame.code,
            msg: frame.msg,
            payload: frame.payload,
          }
          if (
            !Number.isSafeInteger(frame.code) ||
            typeof frame.msg !== 'string'
          )
            throw new KimiError('kimi_invalid_control_ack')
          if (!pending) {
            const old = this.tombstones.get(id)
            if (!old) throw new KimiError('kimi_unknown_control_ack')
            if (old.value !== undefined && !isDeepStrictEqual(old.value, value))
              throw new KimiError('kimi_control_ack_conflict')
            if (old.value === undefined) this.rememberControl(id, value)
            return
          }
          this.pending.delete(id)
          clearTimeout(pending.timer)
          pending.releaseTimer()
          pending.release()
          try {
            this.rememberControl(id, value)
          } catch (error) {
            pending.reject(error as Error)
            throw error
          }
          if (frame.code !== 0 || typeof frame.msg !== 'string')
            pending.reject(new KimiError('kimi_control_rejected'))
          else pending.resolve(object(frame.payload))
          return
        }
        const work = Promise.resolve(onFrame(frame)).finally(releaseFrame)
        transferred = true
        this.frameWork.add(work)
        void work
          .catch((error) => {
            onFailure(error)
            void this.close()
          })
          .finally(() => this.frameWork.delete(work))
      } catch (error) {
        onFailure(
          error instanceof Error ? error : new KimiError('kimi_invalid_wire'),
        )
        void this.close()
      } finally {
        if (!transferred) releaseFrame()
      }
    })
    // ws answers transport pings. Count control traffic even when it carries no JSON.
    this.socket.on('ping', (bytes) => {
      try {
        budget.add('wsFrames')
        budget.add('wsInboundBytes', bytes.length)
      } catch (error) {
        onFailure(error as Error)
        void this.close()
      }
    })
    this.socket.on('pong', (bytes) => {
      try {
        budget.add('wsFrames')
        budget.add('wsInboundBytes', bytes.length)
      } catch (error) {
        onFailure(error as Error)
        void this.close()
      }
    })
  }
  private rememberControl(id: string, value?: unknown) {
    this.tombstones.get(id)?.release()
    this.tombstones.delete(id)
    const bytes =
      Buffer.byteLength(id) +
      (value === undefined
        ? 0
        : jsonBytes(
            value,
            this.budget.limits,
            this.budget.limits.controlTombstoneBytes,
          ))
    while (
      this.tombstones.size &&
      (this.tombstones.size >= this.budget.limits.controlTombstones ||
        this.budget.count('controlTombstoneBytes') + bytes >
          this.budget.limits.controlTombstoneBytes)
    ) {
      const first = this.tombstones.keys().next().value!
      this.tombstones.get(first)!.release()
      this.tombstones.delete(first)
    }
    const release = reserveAll([
      [this.budget, 'controlTombstones'],
      [this.budget, 'controlTombstoneBytes', bytes],
      [this.host, 'hostRetainedBytes', bytes],
    ])
    this.tombstones.set(id, { value, release })
  }
  private send(value: unknown) {
    const limits = this.budget.limits
    const bytes = jsonBytes(value, limits, limits.wsOutboundBytes)
    if (
      this.socket.readyState !== WebSocket.OPEN ||
      this.socket.bufferedAmount + bytes > limits.wsOutboundBytes
    )
      throw new KimiError('kimi_socket_backpressure')
    const release = reserveAll([
      [this.budget, 'wsOutboundBytes', bytes],
      [this.host, 'hostRetainedBytes', bytes * 3],
    ])
    try {
      this.socket.send(JSON.stringify(value), (error) => {
        release()
        if (error) {
          this.onFailure(new KimiError('kimi_socket_send_failed'))
          void this.close()
        }
      })
    } catch (error) {
      release()
      throw error
    }
  }
  async control(
    type: string,
    payload: unknown,
  ): Promise<Record<string, unknown>> {
    await this.ready
    if (this.closeRequested) throw new KimiError('kimi_socket_closed')
    const id = `control-${++this.controlOrdinal}`
    boundedString(id, this.budget.limits.controlIdBytes)
    const release = this.budget.reserve('pendingControls')
    let releaseTimer: () => void
    try {
      releaseTimer = reserveAll([
        [this.budget, 'timers'],
        [this.host, 'hostTimers'],
      ])
    } catch (error) {
      release()
      throw error
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        releaseTimer()
        reject(new KimiError('kimi_control_timeout'))
      }, this.budget.limits.controlMs)
      this.pending.set(id, { resolve, reject, release, releaseTimer, timer })
      try {
        this.send({ type, id, payload })
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        releaseTimer()
        release()
        reject(error)
      }
    })
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closeRequested = true
    this.closing = (async () => {
      let release: () => void
      try {
        release = reserveAll([
          [this.budget, 'timers'],
          [this.host, 'hostTimers'],
        ])
      } catch {
        this.socket.terminate()
        await this.done
        await Promise.allSettled(this.frameWork)
        return
      }
      const timer = setTimeout(
        () => this.socket.terminate(),
        this.budget.limits.shutdownMs,
      )
      try {
        this.socket.close()
        await this.done
        await Promise.allSettled(this.frameWork)
      } finally {
        clearTimeout(timer)
        release()
      }
    })()
    return this.closing
  }
}
