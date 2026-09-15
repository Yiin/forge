/** Public classification only. Raw cleanup errors can contain credentials. */
export class NativeCleanupError extends Error {
  #cleanup: () => Promise<unknown>
  #pending?: Promise<void>
  constructor(cleanup: () => Promise<unknown>) {
    super('Native cleanup failed')
    this.name = 'NativeCleanupError'
    this.#cleanup = cleanup
  }
  retryCleanup(): Promise<void> {
    if (this.#pending) return this.#pending
    const pending = Promise.resolve()
      .then(this.#cleanup)
      .then(
        () => undefined,
        () => {
          throw this
        },
      )
    this.#pending = pending
    void pending.catch(() => {
      if (this.#pending === pending) this.#pending = undefined
    })
    return pending
  }
}

export async function closeNativeDiscovery(
  close: () => Promise<unknown>,
  retry = close,
): Promise<void> {
  try {
    await close()
  } catch (error) {
    if (error instanceof NativeCleanupError) throw error
    throw new NativeCleanupError(retry)
  }
}
