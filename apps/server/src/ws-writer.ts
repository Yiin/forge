type Socket = {
  send(value: string): void
  close(): void
  bufferedAmount?: number
}
type PendingWrite = {
  value: string
  bytes: number
  resolve: (sent: boolean) => void
}
export type WebSocketWriterBudget = {
  maxQueuedBytes: number
  writeDeadlineMs: number
  reserve?: (bytes: number) => boolean
  release?: (bytes: number) => void
}

/** Settle every admitted write when a socket fails, including a lone final write. */
export class WebSocketEventWriter {
  private readonly queue: PendingWrite[] = []
  private pumping = false
  private closed = false
  private pollTimer: ReturnType<typeof setTimeout> | undefined
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined
  private drain: (() => void) | undefined
  private active: PendingWrite | undefined
  private bytes = 0
  constructor(
    private readonly socket: Socket,
    private readonly onOverflow: () => void,
    private readonly maxQueuedEvents = 256,
    private readonly budget?: WebSocketWriterBudget,
  ) {
    if (
      !Number.isSafeInteger(maxQueuedEvents) ||
      maxQueuedEvents < 1 ||
      (budget &&
        (!Number.isSafeInteger(budget.maxQueuedBytes) ||
          budget.maxQueuedBytes < 1 ||
          !Number.isSafeInteger(budget.writeDeadlineMs) ||
          budget.writeDeadlineMs < 1))
    )
      throw new RangeError('Invalid WebSocket writer budget')
  }
  write(value: string): Promise<boolean> {
    if (this.closed) return Promise.resolve(false)
    const bytes = Buffer.byteLength(value)
    if (
      this.queue.length + (this.active ? 1 : 0) >= this.maxQueuedEvents ||
      (this.budget && this.bytes + bytes > this.budget.maxQueuedBytes) ||
      this.budget?.reserve?.(bytes) === false
    ) {
      this.fail()
      return Promise.resolve(false)
    }
    this.bytes += bytes
    return new Promise((resolve) => {
      this.queue.push({ value, bytes, resolve })
      void this.pump()
    })
  }
  close() {
    if (this.closed) return
    this.closed = true
    if (this.pollTimer) clearTimeout(this.pollTimer)
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer)
    this.pollTimer = this.deadlineTimer = undefined
    this.drain?.()
    this.drain = undefined
    if (this.active) {
      this.finish(this.active, false)
      this.active = undefined
    }
    for (const pending of this.queue.splice(0)) this.finish(pending, false)
  }
  private finish(pending: PendingWrite, sent: boolean) {
    this.bytes -= pending.bytes
    this.budget?.release?.(pending.bytes)
    pending.resolve(sent)
  }
  private fail() {
    if (this.closed) return
    this.close()
    try {
      this.socket.close()
    } finally {
      this.onOverflow()
    }
  }
  private async pump() {
    if (this.pumping || this.closed) return
    this.pumping = true
    try {
      while (!this.closed && this.queue.length) {
        const pending = this.queue.shift()!
        this.active = pending
        if (this.budget)
          this.deadlineTimer = setTimeout(
            () => this.fail(),
            this.budget.writeDeadlineMs,
          )
        try {
          if ((this.socket.bufferedAmount ?? 0) > 64 * 1024)
            await this.waitForDrain()
          if (this.closed) break
          this.socket.send(pending.value)
          await this.waitForDrain()
          if (this.active === pending) {
            this.active = undefined
            this.finish(pending, !this.closed)
          }
        } catch {
          this.fail()
        } finally {
          if (this.deadlineTimer) clearTimeout(this.deadlineTimer)
          this.deadlineTimer = undefined
        }
      }
    } finally {
      this.pumping = false
    }
  }
  private waitForDrain(): Promise<void> {
    if (this.closed || (this.socket.bufferedAmount ?? 0) === 0)
      return Promise.resolve()
    return new Promise((resolve) => {
      this.drain = resolve
      const poll = () => {
        this.pollTimer = undefined
        if (this.closed || (this.socket.bufferedAmount ?? 0) === 0) {
          this.drain = undefined
          resolve()
          return
        }
        this.pollTimer = setTimeout(poll, 10)
        this.pollTimer.unref?.()
      }
      this.pollTimer = setTimeout(poll, 10)
      this.pollTimer.unref?.()
    })
  }
}
