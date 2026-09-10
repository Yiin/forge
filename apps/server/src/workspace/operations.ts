import { WorkspaceError } from './paths.js'
import { WORKSPACE_LIMITS } from './limits.js'

export class WorkspaceOperations {
  private controllers = new Set<AbortController>()
  private pending = new Set<Promise<unknown>>()
  private closed = false
  get size() {
    return this.controllers.size
  }
  lease(signal?: AbortSignal, timeout = true) {
    if (this.closed)
      throw new WorkspaceError(
        'unavailable',
        503,
        'Workspace service is closed',
      )
    if (this.controllers.size >= WORKSPACE_LIMITS.operations)
      throw new WorkspaceError('busy', 429, 'Workspace operation limit reached')
    const controller = new AbortController()
    this.controllers.add(controller)
    const abort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const timer = timeout
      ? setTimeout(
          () => controller.abort(new Error('Workspace operation timed out')),
          WORKSPACE_LIMITS.timeoutMs,
        )
      : undefined
    let resolve!: () => void
    const done = new Promise<void>((r) => {
      resolve = r
    })
    this.pending.add(done)
    let released = false
    return {
      signal: controller.signal,
      release: () => {
        if (released) return
        released = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        this.controllers.delete(controller)
        this.pending.delete(done)
        resolve()
      },
    }
  }
  async operation<T>(
    signal: AbortSignal | undefined,
    action: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const lease = this.lease(signal)
    try {
      return await action(lease.signal)
    } catch (error) {
      if (
        error instanceof WorkspaceError &&
        error.code === 'publication_uncertain'
      )
        throw error
      if (lease.signal.aborted)
        throw new WorkspaceError(
          'interrupted',
          503,
          'Workspace operation interrupted',
        )
      throw error
    } finally {
      lease.release()
    }
  }
  async close() {
    this.closed = true
    for (const controller of this.controllers) controller.abort()
    await Promise.allSettled(this.pending)
  }
}
