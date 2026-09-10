import { once } from 'node:events'
import type { Writable } from 'node:stream'

export type JsonRpcIncoming =
  | { type: 'notification'; method: string; params: unknown }
  | { type: 'request'; id: string | number; method: string; params: unknown }
  | { type: 'overflow' }
  | { type: 'eof' }

type RpcMessage = Record<string, unknown>
type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

const safeJson = (value: unknown) => {
  try {
    return JSON.stringify(value)
  } catch {
    return '[unserializable]'
  }
}

export function redactSecrets(value: string, secrets: readonly string[] = []) {
  return secrets
    .filter(Boolean)
    .reduce((result, secret) => result.split(secret).join('[REDACTED]'), value)
}

export type JsonlRpcOptions = {
  stdin: Writable
  stdout: AsyncIterable<Uint8Array | string>
  maxLineBytes?: number
  maxQueuedBytes?: number
  maxIncoming?: number
  secrets?: readonly string[]
  onIncoming?: (message: JsonRpcIncoming) => void | Promise<void>
}

/** Newline-delimited JSON-RPC with one lifetime decoder and id correlation. */
export class JsonlRpcTransport {
  private readonly pending = new Map<string, Pending>()
  private readonly maxLineBytes: number
  private readonly maxQueuedBytes: number
  private readonly maxIncoming: number
  private readonly secrets: readonly string[]
  private writeChain = Promise.resolve()
  private queuedBytes = 0
  private nextId = 0
  private closed = false
  private incoming = 0
  private readonly loopPromise: Promise<void>

  constructor(private readonly options: JsonlRpcOptions) {
    this.maxLineBytes = options.maxLineBytes ?? 1024 * 1024
    this.maxQueuedBytes = options.maxQueuedBytes ?? 4 * 1024 * 1024
    this.maxIncoming = options.maxIncoming ?? 256
    this.secrets = options.secrets ?? []
    this.loopPromise = this.readLoop()
  }

  request<T = unknown>(
    method: string,
    params?: unknown,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ) {
    if (this.closed)
      return Promise.reject(new Error(`${method}: transport is closed`))
    const id = ++this.nextId
    const key = String(id)
    const promise = new Promise<T>((resolve, reject) => {
      const pending: Pending = {
        resolve: resolve as (value: unknown) => void,
        reject,
      }
      if (options?.timeoutMs != null)
        pending.timer = setTimeout(
          () => this.fail(key, new Error(`${method}: timed out`)),
          options.timeoutMs,
        )
      this.pending.set(key, pending)
      if (options?.signal) {
        if (options.signal.aborted)
          this.fail(key, new Error(`${method}: cancelled`))
        else
          options.signal.addEventListener(
            'abort',
            () => this.fail(key, new Error(`${method}: cancelled`)),
            { once: true },
          )
      }
      void this.enqueue({
        jsonrpc: '2.0',
        id,
        method,
        ...(params === undefined ? {} : { params }),
      }).catch((error) =>
        this.fail(
          key,
          error instanceof Error ? error : new Error(String(error)),
        ),
      )
    })
    return promise
  }

  notify(method: string, params?: unknown) {
    return this.enqueue({
      jsonrpc: '2.0',
      method,
      ...(params === undefined ? {} : { params }),
    })
  }
  respond(id: string | number, result: unknown) {
    return this.enqueue({ jsonrpc: '2.0', id, result })
  }
  respondError(id: string | number, code: number, message: string) {
    return this.enqueue({ jsonrpc: '2.0', id, error: { code, message } })
  }

  async close(reason = 'transport closed') {
    if (this.closed) return this.loopPromise
    this.closed = true
    for (const [id] of this.pending) this.fail(id, new Error(reason))
    await this.loopPromise.catch(() => undefined)
  }

  private fail(id: string, error: Error) {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    if (pending.timer) clearTimeout(pending.timer)
    pending.reject(new Error(redactSecrets(error.message, this.secrets)))
  }

  private enqueue(message: RpcMessage) {
    if (this.closed) return Promise.reject(new Error('transport is closed'))
    const line = `${safeJson(message)}\n`
    const bytes = Buffer.byteLength(line)
    if (this.queuedBytes + bytes > this.maxQueuedBytes)
      return Promise.reject(new Error('JSON-RPC write queue is full'))
    this.queuedBytes += bytes
    const write = this.writeChain
      .then(async () => {
        if (this.closed) throw new Error('transport is closed')
        if (!this.options.stdin.write(line))
          await once(this.options.stdin, 'drain')
      })
      .finally(() => {
        this.queuedBytes -= bytes
      })
    this.writeChain = write.catch(() => undefined)
    return write
  }

  private async readLoop() {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let buffer = ''
    let bytes = 0
    try {
      for await (const chunk of this.options.stdout) {
        const text =
          typeof chunk === 'string'
            ? chunk
            : decoder.decode(chunk, { stream: true })
        buffer += text
        bytes += Buffer.byteLength(text)
        if (bytes > this.maxLineBytes && !buffer.includes('\n'))
          throw new Error('JSON-RPC frame exceeds limit')
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, '')
          buffer = buffer.slice(newline + 1)
          bytes = Buffer.byteLength(buffer)
          newline = buffer.indexOf('\n')
          if (Buffer.byteLength(line) > this.maxLineBytes)
            throw new Error('JSON-RPC frame exceeds limit')
          if (!line.trim()) continue
          let message: RpcMessage
          try {
            message = JSON.parse(line) as RpcMessage
          } catch {
            throw new Error('Malformed JSON-RPC frame')
          }
          this.route(message)
        }
      }
      if (buffer.trim()) {
        if (Buffer.byteLength(buffer) > this.maxLineBytes)
          throw new Error('JSON-RPC frame exceeds limit')
        let message: RpcMessage
        try {
          message = JSON.parse(buffer) as RpcMessage
        } catch {
          throw new Error('Malformed final JSON-RPC frame')
        }
        this.route(message)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      for (const [id] of this.pending) this.fail(id, new Error(message))
    } finally {
      this.closed = true
      for (const [id] of this.pending)
        this.fail(id, new Error('JSON-RPC stream ended'))
      await this.options.onIncoming?.({ type: 'eof' })
    }
  }

  private route(message: RpcMessage) {
    const id = message.id
    if (id !== undefined && message.method === undefined) {
      const pending = this.pending.get(String(id))
      if (!pending) return
      this.pending.delete(String(id))
      if (pending.timer) clearTimeout(pending.timer)
      if (message.error && typeof message.error === 'object') {
        const error = message.error as Record<string, unknown>
        pending.reject(
          new Error(
            redactSecrets(String(error.message ?? 'RPC error'), this.secrets),
          ),
        )
      } else pending.resolve(message.result)
      return
    }
    if (typeof message.method !== 'string') return
    if (++this.incoming > this.maxIncoming) {
      this.incoming--
      void this.options.onIncoming?.({ type: 'overflow' })
      return
    }
    const incoming: JsonRpcIncoming =
      id === undefined
        ? {
            type: 'notification',
            method: message.method,
            params: message.params,
          }
        : {
            type: 'request',
            id: id as string | number,
            method: message.method,
            params: message.params,
          }
    void Promise.resolve(this.options.onIncoming?.(incoming)).finally(() => {
      this.incoming--
    })
  }
}
