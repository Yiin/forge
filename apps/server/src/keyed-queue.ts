export class KeyedQueue {
  private tails = new Map<string, Promise<void>>()
  get size() {
    return this.tails.size
  }
  async run<T>(
    key: string,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted()
    const previous = this.tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    // A cancelled middle caller must not let its successor pass the predecessor.
    const current = previous.then(() => released)
    this.tails.set(key, current)
    void current.then(() => {
      if (this.tails.get(key) === current) this.tails.delete(key)
    })
    let abort: (() => void) | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        abort = () => reject(signal!.reason)
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
        void previous.then(resolve)
      })
      signal?.throwIfAborted()
      return await operation()
    } finally {
      if (abort) signal?.removeEventListener('abort', abort)
      release()
    }
  }
}
