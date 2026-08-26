type Socket = {
  send(value: string): void
  close(): void
  bufferedAmount?: number
}

const BACKPRESSURE_LIMIT = 64 * 1024
const MAX_QUEUED_EVENTS = 256
const DRAIN_POLL_MS = 10

type PendingWrite = {
  value: string
  resolve: (sent: boolean) => void
}

/**
 * Keep application memory bounded when a client reads slower than the server.
 * A write resolves only after the underlying socket buffer drains. If the
 * queue fills, closing forces the client to reconnect from its last seq.
 */
export class WebSocketEventWriter {
  private readonly queue: PendingWrite[] = []
  private pumping = false
  private closed = false
  private pollTimer: ReturnType<typeof setTimeout> | undefined
  private active: PendingWrite | undefined

  constructor(
    private readonly socket: Pick<Socket, 'send' | 'close' | 'bufferedAmount'>,
    private readonly onOverflow: () => void,
    private readonly maxQueuedEvents = MAX_QUEUED_EVENTS,
  ) {}

  write(value: string): Promise<boolean> {
    if (
      this.closed ||
      this.queue.length + (this.pumping ? 1 : 0) >= this.maxQueuedEvents
    ) {
      if (!this.closed) {
        this.close()
        this.onOverflow()
      }
      return Promise.resolve(false)
    }
    return new Promise((resolve) => {
      this.queue.push({ value, resolve })
      void this.pump()
    })
  }

  close() {
    this.closed = true
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = undefined
    this.active?.resolve(false)
    this.active = undefined
    for (const pending of this.queue.splice(0)) pending.resolve(false)
  }

  private async pump() {
    if (this.pumping || this.closed) return
    this.pumping = true
    try {
      while (!this.closed && this.queue.length) {
        if ((this.socket.bufferedAmount ?? 0) > BACKPRESSURE_LIMIT) {
          await this.waitForDrain()
          continue
        }
        const pending = this.queue.shift()
        if (!pending) continue
        this.active = pending
        try {
          this.socket.send(pending.value)
          await this.waitForDrain()
          pending.resolve(!this.closed)
        } catch {
          pending.resolve(false)
          this.closed = true
          this.socket.close()
        } finally {
          this.active = undefined
        }
      }
    } finally {
      this.pumping = false
    }
  }

  private waitForDrain(): Promise<void> {
    if ((this.socket.bufferedAmount ?? 0) === 0) return Promise.resolve()
    return new Promise((resolve) => {
      const poll = () => {
        this.pollTimer = undefined
        if (this.closed || (this.socket.bufferedAmount ?? 0) === 0) {
          resolve()
          return
        }
        this.pollTimer = setTimeout(poll, DRAIN_POLL_MS)
        this.pollTimer.unref?.()
      }
      this.pollTimer = setTimeout(poll, DRAIN_POLL_MS)
      this.pollTimer.unref?.()
    })
  }
}
