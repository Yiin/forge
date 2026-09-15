import { randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import { diagnosticError, positiveLimit } from './diagnostics.js'

export type SubmissionEvidence = Readonly<{
  operationId: string
  transportId: string
  status: 'not_written' | 'written' | 'failed_after_handoff'
  cancellation: 'none' | 'before_handoff' | 'after_handoff'
}>
export type Submission = {
  logical: Promise<void>
  submission: Promise<SubmissionEvidence>
}
export type SendOptions = {
  signal?: AbortSignal
  deadline?: number
  operationId?: string
  onHandoff?: () => void
}
type SubmissionOwner = {
  handed: boolean
  finished: boolean
  cancellation: SubmissionEvidence['cancellation']
  finish(status: SubmissionEvidence['status']): void
}

export type JsonlFrameCapture = { context: unknown; release(): void }
export type JsonlDeferredCapture = {
  ready: Promise<void>
  resume(): JsonlFrameCapture | JsonlDeferredCapture
  release(): void
}
type CapturedFrame = {
  id: number
  line: string
  bytes: number
  capture?: JsonlFrameCapture | JsonlDeferredCapture
  context: unknown
  references: number
  releaseDecoded(): void
  releaseParsed(): void
}
type UnreadChunk = {
  bytes: Buffer
  context: unknown
  offset: number
  release(): void
}
export type JsonlOptions = {
  /** Runs before parsing. The exact decoded frame preserves numeric source spellings. */
  captureFrame?: (
    source: string,
    readContext?: unknown,
  ) => JsonlFrameCapture | JsonlDeferredCapture
  /** Capture fallback authority when the original byte chunk arrives. */
  captureReadContext?: () => unknown
  maxUnreadBytes?: number
  stdin: Writable
  stdout: Readable
  maxLineBytes?: number
  maxQueuedBytes?: number
  maxQueuedFrames?: number
  secrets?: readonly string[]
  /** Validate the serialized value, before allocating or queuing its frame. */
  validateOutgoing?: (value: unknown) => void
  /** Optional physical allocation accounting. Parsed values use their encoded byte size. */
  resources?: {
    measureOutgoing(value: unknown): number
    reserve(
      kind: 'receive' | 'decode' | 'parse' | 'serialize' | 'write',
      bytes: number,
    ): () => void
  }
  /** Called in wire order. Async protocol work belongs outside the frame reader. */
  onValue: (
    value: unknown,
    bytes: number,
    ownership?: JsonlValueOwnership,
  ) => void
}
export type JsonlValueOwnership = {
  readonly capture?: unknown
  retain(): () => void
}

type Write = {
  bytes: Buffer
  deadline?: number
  resolve: () => void
  reject: (error: Error) => void
  cleanup: () => void
  settled: boolean
  release: () => void
  owner: SubmissionOwner
  onHandoff?: () => void
  callbackPending: boolean
  streamClosed: boolean
}

/** Owns Node streams. Accepts CRLF, blank lines, and a valid final line at EOF. */
export class JsonlTransport {
  readonly done: Promise<Error>
  private finish!: (reason: Error) => void
  readonly transportId = randomUUID()
  private reason?: Error
  private maxLineBytes: number
  private maxQueuedBytes: number
  private maxQueuedFrames: number
  private readonly decoder = new TextDecoder('utf8', {
    fatal: true,
    ignoreBOM: true,
  })
  private line: Buffer = Buffer.alloc(0)
  private lineBytes = 0
  private lineContext: unknown
  private pendingFrame?: CapturedFrame
  private ownsReadPause = false
  private frameSequence = 0
  private readonly unread: UnreadChunk[] = []
  private unreadBytes = 0
  private reading = false
  private readEnded = false
  private maxUnreadBytes: number
  private releaseLine: () => void = () => {}
  private readonly physicalWrites = new Set<Write>()
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
    this.maxUnreadBytes = positiveLimit(
      options.maxUnreadBytes ?? this.maxQueuedBytes,
      'unread bytes',
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

  get readState() {
    return { unreadBytes: this.unreadBytes, paused: !!this.pendingFrame }
  }

  get state() {
    return {
      bufferedBytes: this.lineBytes,
      queuedBytes: this.queuedBytes,
      queuedFrames: this.queue.length + (this.active ? 1 : 0),
    }
  }
  /** Apply an owned protocol's negotiated lowering limits to existing storage too. */
  setLimits(limits: {
    maxLineBytes: number
    maxQueuedBytes: number
    maxQueuedFrames: number
  }) {
    const line = positiveLimit(limits.maxLineBytes, 'line bytes')
    const bytes = positiveLimit(limits.maxQueuedBytes, 'queued bytes')
    const frames = positiveLimit(limits.maxQueuedFrames, 'queued frames')
    if (
      line > this.maxLineBytes ||
      bytes > this.maxQueuedBytes ||
      frames > this.maxQueuedFrames
    )
      throw new Error('JSONL limits may only decrease')
    if (
      this.lineBytes > line ||
      (this.pendingFrame?.bytes ?? 0) > line ||
      this.unreadBytes > bytes ||
      this.unread.length > frames ||
      this.queuedBytes > bytes ||
      this.state.queuedFrames > frames
    )
      throw new Error('JSONL retained work exceeds negotiated limits')
    if (this.line.length > line) {
      const release = this.reserve('receive', line)
      let smaller: Buffer
      try {
        smaller = Buffer.allocUnsafe(line)
      } catch (error) {
        release()
        throw error
      }
      this.line.copy(smaller, 0, 0, this.lineBytes)
      this.line = smaller
      this.releaseLine()
      this.releaseLine = release
    }
    this.maxLineBytes = line
    this.maxQueuedBytes = bytes
    this.maxUnreadBytes = Math.min(this.maxUnreadBytes, bytes)
    this.maxQueuedFrames = frames
  }
  private reserve(
    kind: 'receive' | 'decode' | 'parse' | 'serialize' | 'write',
    bytes: number,
  ) {
    const release = this.options.resources?.reserve(kind, bytes) ?? (() => {})
    let held = true
    return () => {
      if (held) {
        held = false
        release()
      }
    }
  }

  send(value: unknown, options: SendOptions = {}): Promise<void> {
    return this.sendWithSubmission(value, options).logical
  }

  sendWithSubmission(value: unknown, input: SendOptions = {}): Submission {
    const options = { ...input }
    const operationId = options.operationId ?? randomUUID()
    const transportId = this.transportId
    let complete!: (value: SubmissionEvidence) => void
    const submission = new Promise<SubmissionEvidence>((resolve) => {
      complete = resolve
    })
    const owner: SubmissionOwner = {
      handed: false,
      finished: false,
      cancellation: options.signal?.aborted ? 'before_handoff' : 'none',
      finish: (status) => {
        if (owner.finished) return
        owner.finished = true
        complete(
          Object.freeze({
            operationId,
            transportId,
            status,
            cancellation: owner.cancellation,
          }),
        )
      },
    }
    const logical = this.queueSend(value, options, owner)
    void logical.catch(() => {
      if (!owner.handed) owner.finish('not_written')
    })
    return { logical, submission }
  }

  private queueSend(
    value: unknown,
    options: SendOptions,
    owner: SubmissionOwner,
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
    let releaseText = () => {}
    try {
      if (this.options.resources) {
        const measured = this.options.resources.measureOutgoing(value)
        if (
          !Number.isSafeInteger(measured) ||
          measured < 0 ||
          measured > this.maxLineBytes
        )
          return Promise.reject(new Error('JSONL frame exceeds limit'))
        releaseText = this.reserve('serialize', measured * 2)
      }
      text = JSON.stringify(value)
    } catch {
      /* Never include the value in errors. */
    }
    try {
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
        let releaseValidation = () => {}
        try {
          releaseValidation = this.reserve('parse', length)
          this.options.validateOutgoing(JSON.parse(text))
        } catch (error) {
          return Promise.reject(diagnosticError(error, this.options.secrets))
        } finally {
          releaseValidation()
        }
        const validationError = unavailable()
        if (validationError) return Promise.reject(validationError)
        if (this.queuedBytes + length + 1 > this.maxQueuedBytes)
          return Promise.reject(new Error('JSONL write queue is full'))
      }
      let release: () => void
      try {
        release = this.reserve('write', length + 1)
      } catch (error) {
        return Promise.reject(diagnosticError(error, this.options.secrets))
      }
      let bytes: Buffer
      try {
        bytes = Buffer.allocUnsafe(length + 1)
        bytes.write(text)
        bytes[length] = 10
      } catch (error) {
        release()
        return Promise.reject(diagnosticError(error, this.options.secrets))
      }
      return new Promise<void>((resolve, reject) => {
        const write: Write = {
          bytes,
          deadline: options.deadline,
          resolve,
          reject,
          cleanup: () => {},
          settled: false,
          release,
          owner,
          onHandoff: options.onHandoff,
          callbackPending: false,
          streamClosed: false,
        }
        const cancel = () => {
          write.cleanup()
          owner.cancellation = owner.handed ? 'after_handoff' : 'before_handoff'
          const index = this.queue.indexOf(write)
          if (index >= 0) {
            this.queue.splice(index, 1)
            this.queuedBytes -= write.bytes.length
            write.release()
            this.finishSubmission(write, 'not_written')
          }
          this.settle(write, new Error('JSONL write cancelled'))
        }
        options.signal?.addEventListener('abort', cancel, { once: true })
        write.cleanup = () =>
          options.signal?.removeEventListener('abort', cancel)
        this.queue.push(write)
        this.queuedBytes += bytes.length
        this.pump()
      })
    } finally {
      releaseText()
    }
  }

  close(reason = new Error('JSONL transport closed')): Promise<Error> {
    if (this.reason) return this.done
    this.reason = diagnosticError(reason, this.options.secrets)
    this.line = Buffer.alloc(0)
    this.releaseLine()
    this.releaseLine = () => {}
    this.lineBytes = 0
    this.lineContext = undefined
    const pending = this.pendingFrame
    this.pendingFrame = undefined
    if (pending) this.releaseFrame(pending)
    for (const entry of this.unread.splice(0)) entry.release()
    this.unreadBytes = 0
    this.options.stdout.off('data', this.onData)
    this.options.stdout.off('end', this.onEnd)
    if (this.onDrain) this.options.stdin.off('drain', this.onDrain)
    this.onDrain = undefined
    if (this.active) this.settle(this.active, this.reason)
    this.active = undefined
    for (const write of this.queue) {
      write.release()
      this.finishSubmission(write, 'not_written')
      this.settle(write, this.reason)
    }
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
      expired.release()
      this.finishSubmission(expired, 'not_written')
      this.settle(expired, new Error('JSONL write timed out'))
    }
    const write = this.queue.shift()
    if (!write) return
    this.active = write
    this.physicalWrites.add(write)
    let callbackDone = false
    let drained = false
    let returned = false
    const complete = () => {
      if (!returned || !callbackDone || !drained || this.active !== write)
        return
      write.release()
      this.finishSubmission(write, 'written')
      this.physicalWrites.delete(write)
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
      write.onHandoff?.()
      if (write.settled || this.reason) {
        write.release()
        this.finishSubmission(write, 'not_written')
        this.physicalWrites.delete(write)
        if (this.active === write) {
          this.active = undefined
          this.queuedBytes -= write.bytes.length
          if (this.onDrain) this.options.stdin.off('drain', this.onDrain)
          this.onDrain = undefined
          this.pump()
        }
        return
      }
      write.owner.handed = true
      write.callbackPending = true
      const accepted = this.options.stdin.write(write.bytes, (error) => {
        write.callbackPending = false
        if (write.streamClosed) {
          write.release()
          this.physicalWrites.delete(write)
        }
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
      write.callbackPending = false
      write.release()
      this.finishSubmission(
        write,
        write.owner.handed ? 'failed_after_handoff' : 'not_written',
      )
      this.physicalWrites.delete(write)
      this.onWriteError()
    }
  }

  private finishSubmission(write: Write, status: SubmissionEvidence['status']) {
    write.cleanup()
    write.owner.finish(status)
  }

  private onWriteError = () => {
    void this.close(new Error('JSONL stdin write failed'))
  }
  private onReadError = () => {
    void this.close(new Error('JSONL stdout read failed'))
  }
  private onWriteClose = () => {
    for (const write of this.physicalWrites) {
      write.streamClosed = true
      this.finishSubmission(write, 'failed_after_handoff')
      if (!write.callbackPending) {
        write.release()
        this.physicalWrites.delete(write)
      }
    }
    this.options.stdin.off('error', this.onWriteError)
    // A child can close stdin before its final stdout bytes arrive.
    if (this.active || this.queue.length)
      void this.close(new Error('JSONL stdin closed'))
  }
  private onReadClose = () => {
    this.options.stdout.off('error', this.onReadError)
    if (this.readEnded) this.drainUnread()
    else void this.close(new Error('JSONL stdout closed'))
  }
  private onEnd = () => {
    this.readEnded = true
    this.drainUnread()
  }
  private queueUnread(bytes: Buffer, context: unknown, first = false) {
    if (!bytes.length || this.reason) return
    if (
      this.unreadBytes + bytes.length > this.maxUnreadBytes ||
      this.unread.length >= this.maxQueuedFrames
    ) {
      void this.close(new Error('JSONL unread capacity exceeded'))
      return
    }
    let release: (() => void) | undefined
    try {
      release = this.reserve('receive', bytes.length)
      const owned = Buffer.allocUnsafeSlow(bytes.length)
      bytes.copy(owned)
      const entry = { bytes: owned, context, offset: 0, release }
      if (first) this.unread.unshift(entry)
      else this.unread.push(entry)
      this.unreadBytes += owned.length
    } catch {
      release?.()
      void this.close(new Error('JSONL unread allocation refused'))
    }
  }
  private drainUnread() {
    if (this.reading || this.pendingFrame || this.reason) return
    this.reading = true
    try {
      while (this.unread.length && !this.pendingFrame && !this.reason) {
        const entry = this.unread.shift()!
        let retained = false
        try {
          retained = !!this.consume(entry.bytes, entry.context, entry)
        } finally {
          if (!retained) {
            this.unreadBytes = Math.max(
              0,
              this.unreadBytes - entry.bytes.length,
            )
            entry.release()
          }
        }
      }
      if (!this.pendingFrame && !this.reason && this.readEnded) {
        if (this.lineBytes) {
          this.frame(this.line.subarray(0, this.lineBytes), this.lineContext)
          this.lineBytes = 0
          this.lineContext = undefined
        }
        if (!this.pendingFrame) void this.close(new Error('JSONL stdout ended'))
      }
    } finally {
      this.reading = false
    }
  }
  private onData = (chunk: Buffer) => {
    if (this.reason) return
    if (!(chunk instanceof Uint8Array)) {
      void this.close(new Error('JSONL requires a byte stream'))
      return
    }
    let context: unknown
    try {
      context = this.options.captureReadContext?.()
    } catch {
      void this.close(new Error('JSONL read capture failed'))
      return
    }
    if (this.pendingFrame || this.reading) {
      this.queueUnread(chunk, context)
      return
    }
    this.reading = true
    try {
      this.consume(chunk, context)
    } finally {
      this.reading = false
    }
    this.drainUnread()
  }
  private consume(chunk: Buffer, context: unknown, owned?: UnreadChunk) {
    let offset = owned?.offset ?? 0
    while (offset < chunk.length && !this.reason) {
      const newline = chunk.indexOf(10, offset)
      const end = newline < 0 ? chunk.length : newline
      const part = chunk.subarray(offset, end)
      if (!this.lineBytes) this.lineContext = context
      const required = this.lineBytes + part.length
      if (required > this.maxLineBytes) {
        void this.close(new Error('JSONL frame exceeds limit'))
        return
      }
      if (required > this.line.length) {
        const capacity = Math.min(
          this.maxLineBytes,
          Math.max(required, this.line.length * 2, 4096),
        )
        let release: () => void
        try {
          release = this.reserve('receive', capacity)
        } catch {
          void this.close(new Error('JSONL receive allocation refused'))
          return
        }
        let grown: Buffer
        try {
          grown = Buffer.allocUnsafe(capacity)
        } catch {
          release()
          void this.close(new Error('JSONL receive allocation failed'))
          return
        }
        this.line.copy(grown, 0, 0, this.lineBytes)
        this.line = grown
        this.releaseLine()
        this.releaseLine = release
      }
      part.copy(this.line, this.lineBytes)
      this.lineBytes = required
      if (newline < 0) break
      this.frame(this.line.subarray(0, this.lineBytes), this.lineContext)
      this.lineBytes = 0
      this.lineContext = undefined
      offset = newline + 1
      if (this.pendingFrame) {
        if (owned && offset < chunk.length) {
          owned.offset = offset
          this.unread.unshift(owned)
          return true
        }
        this.queueUnread(chunk.subarray(offset), context, true)
        return false
      }
    }
  }
  private releaseFrame(frame: CapturedFrame) {
    if (frame.references <= 0 || --frame.references !== 0) return
    frame.releaseDecoded()
    frame.releaseParsed()
    frame.capture?.release()
    frame.line = ''
    frame.context = undefined
    frame.capture = undefined
  }
  private pauseFrame(frame: CapturedFrame) {
    this.pendingFrame = frame
    if (!this.options.stdout.isPaused()) {
      this.ownsReadPause = true
      this.options.stdout.pause()
    }
    const id = frame.id
    const capture = frame.capture as JsonlDeferredCapture
    void capture.ready.then(
      () => this.resumeFrame(id),
      () => {
        if (this.pendingFrame?.id === id)
          void this.close(new Error('JSONL frame admission failed'))
      },
    )
  }
  private resumeFrame(id: number) {
    const frame = this.pendingFrame
    if (!frame || frame.id !== id || this.reason) return
    this.pendingFrame = undefined
    this.reading = true
    try {
      frame.capture = (frame.capture as JsonlDeferredCapture).resume()
      if (this.reason) {
        this.releaseFrame(frame)
        return
      }
      if ('ready' in frame.capture) {
        this.pauseFrame(frame)
        return
      }
      if (this.ownsReadPause) {
        this.ownsReadPause = false
        this.options.stdout.resume()
      }
      this.dispatchFrame(frame)
    } catch {
      this.releaseFrame(frame)
      void this.close(new Error('JSONL frame admission failed'))
    } finally {
      this.reading = false
    }
    this.drainUnread()
  }
  private frame(bytes: Buffer, context: unknown) {
    const frame: CapturedFrame = {
      id: ++this.frameSequence,
      line: '',
      bytes: bytes.length,
      context,
      references: 1,
      releaseDecoded: () => {},
      releaseParsed: () => {},
    }
    try {
      try {
        frame.releaseDecoded = this.reserve('decode', bytes.length * 2)
        frame.line = this.decoder.decode(bytes)
      } catch {
        throw new Error('Invalid JSONL UTF-8')
      }
      if (!frame.line.trim()) {
        this.releaseFrame(frame)
        return
      }
      try {
        frame.capture = this.options.captureFrame?.(frame.line, context)
      } catch {
        throw new Error('JSONL frame capture failed')
      }
      if (this.reason) {
        this.releaseFrame(frame)
        return
      }
      if (frame.capture && 'ready' in frame.capture) {
        this.pauseFrame(frame)
        return
      }
      this.dispatchFrame(frame)
    } catch (error) {
      this.releaseFrame(frame)
      void this.close(
        error instanceof Error ? error : new Error('JSONL frame failed'),
      )
    }
  }
  private dispatchFrame(frame: CapturedFrame) {
    const ownership: JsonlValueOwnership = {
      get capture() {
        return (frame.capture as JsonlFrameCapture | undefined)?.context
      },
      retain: () => {
        if (!frame.references) throw new Error('JSONL value already released')
        frame.references++
        let held = true
        return () => {
          if (held) {
            held = false
            this.releaseFrame(frame)
          }
        }
      },
    }
    try {
      let value: unknown
      try {
        frame.releaseParsed = this.reserve('parse', frame.bytes)
        value = JSON.parse(frame.line)
      } catch {
        void this.close(new Error('Malformed JSONL frame'))
        return
      }
      try {
        const work: unknown = this.options.onValue(
          value,
          frame.bytes,
          ownership,
        )
        if (work && typeof (work as Promise<unknown>).then === 'function') {
          void Promise.resolve(work).catch(() => {})
          void this.close(new Error('JSONL frame handler must be synchronous'))
        }
      } catch {
        void this.close(new Error('JSONL handler failed'))
      }
    } finally {
      this.releaseFrame(frame)
    }
  }
}
