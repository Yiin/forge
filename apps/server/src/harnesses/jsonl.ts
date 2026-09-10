import type { Readable, Writable } from 'node:stream'
import { diagnosticError, positiveLimit } from './diagnostics.js'

export type JsonlOptions = {
  stdin: Writable
  stdout: Readable
  maxLineBytes?: number
  maxQueuedBytes?: number
  maxQueuedFrames?: number
  secrets?: readonly string[]
  /** Validate the serialized value, before allocating or queuing its frame. */
  validateOutgoing?: (value: unknown) => void
  /** Called in wire order. Async protocol work belongs outside the frame reader. */
  onValue: (value: unknown, bytes: number) => void
}

type Write = {
  bytes: Buffer
  deadline?: number
  resolve: () => void
  reject: (error: Error) => void
  cleanup: () => void
  settled: boolean
}

/** Owns Node streams. Accepts CRLF, blank lines, and a valid final line at EOF. */
export class JsonlTransport {
  readonly done: Promise<Error>
  private finish!: (reason: Error) => void
  private reason?: Error
  private readonly maxLineBytes: number
  private readonly maxQueuedBytes: number
  private readonly maxQueuedFrames: number
  private readonly decoder = new TextDecoder('utf8', {
    fatal: true,
    ignoreBOM: true,
  })
  private line = Buffer.alloc(0)
  private lineBytes = 0
  private readonly queue: Write[] = []
  private active?: Write
  private queuedBytes = 0
  private onDrain?: () => void

  constructor(private readonly options: JsonlOptions) {
    this.maxLineBytes = positiveLimit(
      options.maxLineBytes ?? 1024 * 1024,
      'line bytes',
    )
    this.maxQueuedBytes = positiveLimit(
      options.maxQueuedBytes ?? 4 * 1024 * 1024,
      'queued bytes',
    )
    this.maxQueuedFrames = positiveLimit(
      options.maxQueuedFrames ?? 256,
      'queued frames',
    )
    this.done = new Promise((resolve) => {
      this.finish = resolve
    })
    if (!options.stdin.closed) {
      options.stdin.on('error', this.onWriteError)
      options.stdin.once('close', this.onWriteClose)
    }
    if (!options.stdout.closed) {
      options.stdout.on('error', this.onReadError)
      options.stdout.once('close', this.onReadClose)
      options.stdout.once('end', this.onEnd)
      options.stdout.on('data', this.onData)
    }
    if (
      options.stdin.destroyed ||
      options.stdout.destroyed ||
      options.stdout.readableEnded
    )
      this.close(new Error('JSONL stream is closed'))
  }

  get closed() {
    return this.reason !== undefined
  }

  get state() {
    return {
      bufferedBytes: this.lineBytes,
      queuedBytes: this.queuedBytes,
      queuedFrames: this.queue.length + (this.active ? 1 : 0),
    }
  }

  send(
    value: unknown,
    options: { signal?: AbortSignal; deadline?: number } = {},
  ): Promise<void> {
    const unavailable = () => {
      if (this.reason) return this.reason
      if (this.options.stdin.destroyed || this.options.stdin.writableEnded) {
        void this.close(new Error('JSONL stdin closed'))
        return this.reason
      }
      if (options.signal?.aborted) return new Error('JSONL write cancelled')
      if (
        options.deadline !== undefined &&
        performance.now() >= options.deadline
      )
        return new Error('JSONL write timed out')
      if (this.state.queuedFrames >= this.maxQueuedFrames)
        return new Error('JSONL write queue is full')
    }
    const initialError = unavailable()
    if (initialError) return Promise.reject(initialError)
    let text: string | undefined
    try {
      text = JSON.stringify(value)
    } catch {
      /* Never include the value in errors. */
    }
    // Getters and toJSON can close, cancel, or reenter this transport.
    const serializedError = unavailable()
    if (serializedError) return Promise.reject(serializedError)
    if (text === undefined)
      return Promise.reject(new Error('Cannot encode JSONL value'))
    const length = Buffer.byteLength(text)
    if (length > this.maxLineBytes)
      return Promise.reject(new Error('JSONL frame exceeds limit'))
    if (this.queuedBytes + length + 1 > this.maxQueuedBytes)
      return Promise.reject(new Error('JSONL write queue is full'))
    if (this.options.validateOutgoing) {
      try {
        this.options.validateOutgoing(JSON.parse(text))
      } catch (error) {
        return Promise.reject(diagnosticError(error, this.options.secrets))
      }
      const validationError = unavailable()
      if (validationError) return Promise.reject(validationError)
      if (this.queuedBytes + length + 1 > this.maxQueuedBytes)
        return Promise.reject(new Error('JSONL write queue is full'))
    }
    const bytes = Buffer.from(`${text}\n`)
    return new Promise<void>((resolve, reject) => {
      const write: Write = {
        bytes,
        deadline: options.deadline,
        resolve,
        reject,
        cleanup: () => {},
        settled: false,
      }
      const cancel = () => {
        const index = this.queue.indexOf(write)
        if (index >= 0) {
          this.queue.splice(index, 1)
          this.queuedBytes -= write.bytes.length
        }
        this.settle(write, new Error('JSONL write cancelled'))
      }
      options.signal?.addEventListener('abort', cancel, { once: true })
      write.cleanup = () => options.signal?.removeEventListener('abort', cancel)
      this.queue.push(write)
      this.queuedBytes += bytes.length
      this.pump()
    })
  }

  close(reason = new Error('JSONL transport closed')): Promise<Error> {
    if (this.reason) return this.done
    this.reason = diagnosticError(reason, this.options.secrets)
    this.line = Buffer.alloc(0)
    this.lineBytes = 0
    this.options.stdout.off('data', this.onData)
    this.options.stdout.off('end', this.onEnd)
    if (this.onDrain) this.options.stdin.off('drain', this.onDrain)
    this.onDrain = undefined
    if (this.active) this.settle(this.active, this.reason)
    this.active = undefined
    for (const write of this.queue) this.settle(write, this.reason)
    this.queue.length = 0
    this.queuedBytes = 0
    // Keep error listeners until close. A pending write can still report EPIPE.
    this.options.stdin.destroy()
    this.options.stdout.destroy()
    this.finish(this.reason)
    return this.done
  }

  private settle(write: Write, error?: Error) {
    if (write.settled) return
    write.settled = true
    write.cleanup()
    if (error) write.reject(error)
    else write.resolve()
  }

  private pump() {
    if (this.reason || this.active) return
    while (
      this.queue[0]?.deadline !== undefined &&
      performance.now() >= this.queue[0].deadline
    ) {
      const expired = this.queue.shift()!
      this.queuedBytes -= expired.bytes.length
      this.settle(expired, new Error('JSONL write timed out'))
    }
    const write = this.queue.shift()
    if (!write) return
    this.active = write
    let callbackDone = false
    let drained = false
    let returned = false
    const complete = () => {
      if (!returned || !callbackDone || !drained || this.active !== write)
        return
      if (this.onDrain) this.options.stdin.off('drain', this.onDrain)
      this.onDrain = undefined
      this.active = undefined
      this.queuedBytes -= write.bytes.length
      this.settle(write)
      this.pump()
    }
    this.onDrain = () => {
      drained = true
      complete()
    }
    this.options.stdin.once('drain', this.onDrain)
    try {
      const accepted = this.options.stdin.write(write.bytes, (error) => {
        if (error) {
          this.onWriteError()
          return
        }
        callbackDone = true
        complete()
      })
      drained ||= accepted
      returned = true
      complete()
    } catch {
      this.onWriteError()
    }
  }

  private onWriteError = () => {
    void this.close(new Error('JSONL stdin write failed'))
  }
  private onReadError = () => {
    void this.close(new Error('JSONL stdout read failed'))
  }
  private onWriteClose = () => {
    this.options.stdin.off('error', this.onWriteError)
    // A child can close stdin before its final stdout bytes arrive.
    if (this.active || this.queue.length)
      void this.close(new Error('JSONL stdin closed'))
  }
  private onReadClose = () => {
    this.options.stdout.off('error', this.onReadError)
    void this.close(new Error('JSONL stdout closed'))
  }
  private onEnd = () => {
    if (this.lineBytes) this.frame(this.line.subarray(0, this.lineBytes))
    void this.close(new Error('JSONL stdout ended'))
  }
  private onData = (chunk: Buffer) => {
    if (this.reason) return
    // Node byte streams must not have setEncoding applied by a caller.
    if (!(chunk instanceof Uint8Array)) {
      void this.close(new Error('JSONL requires a byte stream'))
      return
    }
    let offset = 0
    while (offset < chunk.length && !this.reason) {
      const newline = chunk.indexOf(10, offset)
      const end = newline < 0 ? chunk.length : newline
      const part = chunk.subarray(offset, end)
      const required = this.lineBytes + part.length
      if (required > this.maxLineBytes) {
        void this.close(new Error('JSONL frame exceeds limit'))
        return
      }
      if (required > this.line.length) {
        const grown = Buffer.allocUnsafe(
          Math.min(
            this.maxLineBytes,
            Math.max(required, this.line.length * 2, 4096),
          ),
        )
        this.line.copy(grown, 0, 0, this.lineBytes)
        this.line = grown
      }
      part.copy(this.line, this.lineBytes)
      this.lineBytes = required
      if (newline < 0) break
      this.frame(this.line.subarray(0, this.lineBytes))
      this.lineBytes = 0
      offset = newline + 1
    }
  }
  private frame(bytes: Buffer) {
    let line: string
    try {
      line = this.decoder.decode(bytes)
    } catch {
      void this.close(new Error('Invalid JSONL UTF-8'))
      return
    }
    if (!line.trim()) return
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      void this.close(new Error('Malformed JSONL frame'))
      return
    }
    try {
      const work: unknown = this.options.onValue(value, bytes.length)
      if (work && typeof (work as Promise<unknown>).then === 'function') {
        void Promise.resolve(work).catch(() => {})
        void this.close(new Error('JSONL frame handler must be synchronous'))
      }
    } catch {
      void this.close(new Error('JSONL handler failed'))
    }
  }
}
