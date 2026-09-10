import { randomUUID } from 'node:crypto'
import { diagnosticError, positiveLimit } from './diagnostics.js'
import { JsonlTransport, type JsonlOptions } from './jsonl.js'

type RpcId = string | number
export type JsonRpcRequest = Readonly<{
  type: 'request'
  id: RpcId
  method: string
  params: unknown
  runtimeGeneration: string
  signal: AbortSignal
}>
export type JsonRpcIncoming =
  | JsonRpcRequest
  | Readonly<{
      type: 'notification'
      method: string
      params: unknown
      runtimeGeneration: string
      signal: AbortSignal
    }>
export type JsonlRpcOptions = Omit<
  JsonlOptions,
  'onValue' | 'validateOutgoing'
> & {
  /** Standard requires 2.0; unversioned requires an omitted jsonrpc field. */
  wireProfile?: 'standard' | 'unversioned'
  runtimeGeneration: string
  maxPendingRequests?: number
  maxIncomingRequests?: number
  maxIncomingHandlers?: number
  maxQueuedIncomingFrames?: number
  maxQueuedIncomingBytes?: number
  requestTimeoutMs?: number
  onIncoming?: (message: JsonRpcIncoming) => void | Promise<void>
}

type Pending = {
  deadline: number
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  cleanup: () => void
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const validId = (value: unknown): value is RpcId =>
  typeof value === 'string' ||
  (typeof value === 'number' && Number.isSafeInteger(value))

type RpcEnvelope =
  | { method: string; params?: unknown; id?: RpcId }
  | { id: RpcId; result: unknown }
  | { id: RpcId; error: { code: number; message: string } }

/** JSON-RPC routing never waits for an incoming handler. */
export class JsonlRpcTransport {
  readonly wire: JsonlTransport
  readonly done: Promise<Error>
  private readonly controller = new AbortController()
  private readonly pending = new Map<RpcId, Pending>()
  private readonly incoming = new Map<RpcId, JsonRpcRequest>()
  private readonly handlers = new Set<symbol>()
  private readonly queue: { message: JsonRpcIncoming; bytes: number }[] = []
  private queuedIncomingBytes = 0
  private readonly maxQueuedFrames: number
  private readonly maxQueuedBytes: number
  private readonly replying = new Set<JsonRpcRequest>()
  private readonly identity = randomUUID()
  private readonly maxPending: number
  private readonly maxIncoming: number
  private readonly maxHandlers: number
  private readonly timeoutMs: number
  private nextId = 0
  private reason?: Error

  constructor(private readonly options: JsonlRpcOptions) {
    if (!options.runtimeGeneration)
      throw new Error('Missing runtime generation')
    this.maxPending = positiveLimit(
      options.maxPendingRequests ?? 256,
      'pending requests',
    )
    this.maxIncoming = positiveLimit(
      options.maxIncomingRequests ?? 256,
      'incoming requests',
    )
    this.maxHandlers = positiveLimit(
      options.maxIncomingHandlers ?? 256,
      'incoming handlers',
    )
    this.maxQueuedFrames = positiveLimit(
      options.maxQueuedIncomingFrames ?? 1024,
      'queued incoming frames',
    )
    this.maxQueuedBytes = positiveLimit(
      options.maxQueuedIncomingBytes ?? 4 * 1024 * 1024,
      'queued incoming bytes',
    )
    this.timeoutMs = positiveLimit(
      options.requestTimeoutMs ?? 30_000,
      'request timeout',
    )
    this.wire = new JsonlTransport({
      ...options,
      onValue: (value, bytes) => this.route(value, bytes),
      validateOutgoing: (value) => {
        if (!this.validEnvelope(value))
          throw new Error('Malformed outgoing JSON-RPC envelope')
      },
    })
    this.done = this.wire.done.then((reason) => {
      this.terminate(reason)
      return reason
    })
  }

  get state() {
    return {
      ...this.wire.state,
      pendingRequests: this.pending.size,
      incomingRequests: this.incoming.size,
      incomingHandlers: this.handlers.size,
      queuedIncomingFrames: this.queue.length,
      queuedIncomingBytes: this.queuedIncomingBytes,
    }
  }

  request<T = unknown>(
    method: string,
    params?: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.reason || this.wire.closed)
      return Promise.reject(
        this.reason ?? new Error('JSON-RPC transport closed'),
      )
    if (options.signal?.aborted)
      return Promise.reject(new Error('JSON-RPC request cancelled'))
    if (this.pending.size >= this.maxPending)
      return Promise.reject(new Error('JSON-RPC pending request limit reached'))
    let timeoutMs: number
    try {
      timeoutMs = positiveLimit(
        options.timeoutMs ?? this.timeoutMs,
        'request timeout',
      )
    } catch (error) {
      return Promise.reject(error)
    }
    const deadline = performance.now() + timeoutMs
    const id = `${this.options.runtimeGeneration}:${this.identity}:${++this.nextId}`
    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController()
      const cancel = () =>
        this.settle(id, new Error('JSON-RPC request cancelled'))
      const timer = setTimeout(
        () => this.settle(id, new Error('JSON-RPC request timed out')),
        timeoutMs,
      )
      this.pending.set(id, {
        deadline,
        resolve: resolve as (value: unknown) => void,
        reject,
        cleanup: () => {
          clearTimeout(timer)
          options.signal?.removeEventListener('abort', cancel)
          controller.abort()
        },
      })
      options.signal?.addEventListener('abort', cancel, { once: true })
      void this.wire
        .send(
          this.envelope({
            id,
            method,
            ...(params === undefined ? {} : { params }),
          }),
          { signal: controller.signal, deadline },
        )
        .catch((error: unknown) =>
          this.settle(
            id,
            performance.now() >= deadline
              ? new Error('JSON-RPC request timed out')
              : diagnosticError(error, this.options.secrets),
          ),
        )
    })
  }

  notify(
    method: string,
    params?: unknown,
    options: { signal?: AbortSignal } = {},
  ) {
    return this.wire.send(
      this.envelope({ method, ...(params === undefined ? {} : { params }) }),
      options,
    )
  }

  respond(request: JsonRpcRequest, result: unknown) {
    return this.reply(request, { result })
  }

  respondError(request: JsonRpcRequest, code: number, message: string) {
    if (!Number.isSafeInteger(code))
      return Promise.reject(new Error('Invalid JSON-RPC error code'))
    return this.reply(request, { error: { code, message } })
  }

  close(reason = new Error('JSON-RPC transport closed')) {
    this.terminate(diagnosticError(reason, this.options.secrets))
    void this.wire.close(this.reason)
    return this.done
  }

  private reply(request: JsonRpcRequest, response: Record<string, unknown>) {
    if (
      this.reason ||
      this.wire.closed ||
      this.incoming.get(request.id) !== request ||
      this.replying.has(request) ||
      request.runtimeGeneration !== this.options.runtimeGeneration
    )
      return Promise.reject(
        new Error('JSON-RPC request is stale or already answered'),
      )
    // Reserve the handle while its reply is queued. A failed send can be retried.
    this.replying.add(request)
    return this.wire
      .send(this.envelope({ id: request.id, ...response }))
      .then(() => {
        if (this.incoming.get(request.id) === request)
          this.incoming.delete(request.id)
      })
      .finally(() => {
        this.replying.delete(request)
      })
  }

  private settle(id: RpcId, error?: Error, value?: unknown) {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    pending.cleanup()
    if (error) pending.reject(error)
    else pending.resolve(value)
  }

  private terminate(reason: Error) {
    if (this.reason) return
    this.reason = reason
    for (const id of this.pending.keys()) this.settle(id, reason)
    this.incoming.clear()
    this.replying.clear()
    this.handlers.clear()
    this.queue.length = 0
    this.queuedIncomingBytes = 0
    this.controller.abort()
  }

  private drainIncoming() {
    while (!this.reason && this.handlers.size < this.maxHandlers) {
      const item = this.queue.shift()
      if (!item) return
      this.queuedIncomingBytes -= item.bytes
      const token = Symbol()
      this.handlers.add(token)
      try {
        const work = this.options.onIncoming?.(item.message)
        if (work) {
          void Promise.resolve(work).then(
            () => {
              this.handlers.delete(token)
              this.drainIncoming()
            },
            () => {
              this.handlers.delete(token)
              void this.close(new Error('JSON-RPC incoming handler failed'))
            },
          )
        } else this.handlers.delete(token)
      } catch {
        this.handlers.delete(token)
        void this.close(new Error('JSON-RPC incoming handler failed'))
      }
    }
  }

  private envelope(value: Record<string, unknown>) {
    return this.options.wireProfile === 'unversioned'
      ? value
      : { jsonrpc: '2.0', ...value }
  }

  private validEnvelope(value: unknown): value is RpcEnvelope {
    if (!record(value)) return false
    if (
      this.options.wireProfile === 'unversioned'
        ? 'jsonrpc' in value
        : value.jsonrpc !== '2.0'
    )
      return false
    if ('method' in value) {
      return (
        typeof value.method === 'string' &&
        !('result' in value) &&
        !('error' in value) &&
        (!('id' in value) || validId(value.id)) &&
        (!('params' in value) ||
          record(value.params) ||
          Array.isArray(value.params))
      )
    }
    if (
      !validId(value.id) ||
      'result' in value === 'error' in value ||
      'params' in value
    )
      return false
    return (
      !('error' in value) ||
      (record(value.error) &&
        Number.isSafeInteger(value.error.code) &&
        typeof value.error.message === 'string')
    )
  }

  private malformed() {
    void this.close(new Error('Malformed JSON-RPC envelope'))
  }

  private route(value: unknown, bytes: number) {
    if (this.reason) return
    if (!this.validEnvelope(value)) {
      this.malformed()
      return
    }
    if ('method' in value) {
      const common = {
        method: value.method,
        params: value.params,
        runtimeGeneration: this.options.runtimeGeneration,
        signal: this.controller.signal,
      }
      let message: JsonRpcIncoming
      if ('id' in value) {
        const id = value.id as RpcId
        if (this.incoming.has(id)) {
          this.malformed()
          return
        }
        if (this.incoming.size >= this.maxIncoming) {
          void this.close(new Error('JSON-RPC incoming request limit reached'))
          return
        }
        message = Object.freeze({ ...common, type: 'request', id })
        this.incoming.set(id, message)
      } else message = Object.freeze({ ...common, type: 'notification' })
      if (
        this.queue.length >= this.maxQueuedFrames ||
        this.queuedIncomingBytes + bytes > this.maxQueuedBytes
      ) {
        void this.close(new Error('JSON-RPC incoming queue limit reached'))
        return
      }
      this.queue.push({ message, bytes })
      this.queuedIncomingBytes += bytes
      this.drainIncoming()
      return
    }
    const pending = this.pending.get(value.id)
    if (pending && performance.now() >= pending.deadline) {
      this.settle(value.id, new Error('JSON-RPC request timed out'))
      return
    }
    if ('error' in value) {
      // Error data can contain whole prompts and credentials. Expose only the reason and code.
      const error = diagnosticError(
        new Error(`${value.error.message} (code ${value.error.code})`),
        this.options.secrets,
      )
      this.settle(value.id, error)
    } else this.settle(value.id, undefined, value.result)
  }
}
