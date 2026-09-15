import type { Server } from 'node:http'
import { TerminalError } from './terminals/error.js'

export type CleanupHook = () => Promise<void> | void
/** Retain ownership after a failed cleanup. A later close retries the same owners. */
export class ServerShutdown {
  private readonly hooks: CleanupHook[] = []
  private readonly callbacks: Array<(error?: Error) => void> = []
  private attempt?: Promise<void>
  private expired = false
  private stopped = false
  private admissionStopped = false
  private signalExit = false
  private completedHooks = 0
  private httpClose?: Promise<void>
  private readonly closeHttp: Server['close']
  constructor(
    private readonly server: Server,
    private readonly stopAdmission: () => void,
    private readonly markStopped: () => void,
    private readonly maxCallbacks = 32,
    private readonly deadlineMs = 6000,
  ) {
    this.closeHttp = server.close.bind(server)
    server.close = (callback?: (error?: Error) => void) => {
      this.close(callback)
      return server
    }
  }
  addCleanupHook(hook: CleanupHook) {
    if (this.admissionStopped) throw new Error('Shutdown has already started')
    this.hooks.push(hook)
  }
  close(callback?: (error?: Error) => void) {
    if (this.stopped) {
      callback?.()
      return
    }
    if (this.attempt && this.expired) {
      callback?.(this.unknown())
      return
    }
    if (callback) {
      if (this.callbacks.length >= this.maxCallbacks) {
        callback(
          new TerminalError(
            'shutdown_busy',
            503,
            'Shutdown callback capacity reached',
          ),
        )
        return
      }
      this.callbacks.push(callback)
    }
    if (this.attempt) return
    this.expired = false
    if (!this.admissionStopped) {
      this.admissionStopped = true
      this.stopAdmission()
    }
    const attempt = (async () => {
      while (this.completedHooks < this.hooks.length) {
        await this.hooks[this.completedHooks]!()
        this.completedHooks++
      }
      // HTTP close is irreversible. A later bookkeeping failure retries only
      // that bookkeeping, using the original physical close result.
      this.httpClose ??= new Promise<void>((resolve, reject) =>
        this.closeHttp((error) => (error ? reject(error) : resolve())),
      )
      await this.httpClose
      this.markStopped()
      this.stopped = true
    })()
    this.attempt = attempt
    const timer = setTimeout(() => {
      this.expired = true
      this.deliver(this.unknown())
    }, this.deadlineMs)
    void attempt.then(
      () => {
        clearTimeout(timer)
        this.finish()
      },
      () => {
        clearTimeout(timer)
        this.finish(this.unknown())
      },
    )
  }
  private unknown() {
    return new TerminalError(
      'shutdown_cleanup_unknown',
      503,
      'Server cleanup is unknown',
    )
  }
  private finish(error?: Error) {
    this.attempt = undefined
    this.deliver(error)
    if (!error && this.signalExit) process.exit(0)
  }
  private deliver(error?: Error) {
    const callbacks = this.callbacks.splice(0)
    for (const callback of callbacks) {
      try {
        callback(error)
      } catch {
        /* A caller cannot prevent other completion callbacks. */
      }
    }
  }
  signal = () => {
    this.signalExit = true
    this.close()
  }
}
