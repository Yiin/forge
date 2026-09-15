import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import * as processGroups from './process-group.js'
import {
  DiagnosticTail,
  diagnosticError,
  positiveLimit,
} from './diagnostics.js'

export type NativeProcessOptions = {
  command: string
  args?: string[]
  cwd?: string
  /** Pass accountEnv overrides here. Other inherited values remain available. */
  env?: NodeJS.ProcessEnv
  /** Use only env when the caller has captured its complete launch environment. */
  inheritEnv?: boolean
  onCreated?: (runtime: NativeProcess) => void
  secrets?: readonly string[]
  stderrLimit?: number
  signal?: AbortSignal
  startupTimeoutMs?: number
  killGraceMs?: number
  cleanupTimeoutMs?: number
}

type OwnedTransport = {
  done: Promise<Error>
  close: (reason: Error) => unknown
}

/** Owns one Linux process group. Create it through startNativeProcess. */
export class NativeProcess {
  readonly child: ChildProcessWithoutNullStreams
  readonly done: Promise<Error>
  readonly signal: AbortSignal
  private readonly controller = new AbortController()
  private readonly tail: DiagnosticTail
  private readonly exited: Promise<void>
  private readonly spawned: Promise<void>
  private readonly ended: Promise<Error>
  private finish!: (reason: Error) => void
  private end!: (reason: Error) => void
  private closing?: Promise<void>
  private groupRetired = false
  private reason?: Error
  private transport?: OwnedTransport
  private readonly graceMs: number
  private readonly cleanupTimeoutMs: number

  private constructor(private readonly options: NativeProcessOptions) {
    this.graceMs = positiveLimit(options.killGraceMs ?? 500, 'kill grace')
    this.cleanupTimeoutMs = positiveLimit(
      options.cleanupTimeoutMs ?? 1000,
      'cleanup timeout',
    )
    this.tail = new DiagnosticTail(options.stderrLimit, options.secrets)
    this.signal = this.controller.signal
    this.done = new Promise((resolve) => {
      this.finish = resolve
    })
    this.ended = new Promise((resolve) => {
      this.end = resolve
    })
    this.child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env:
        options.inheritEnv === false
          ? { ...options.env }
          : { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
    this.exited = new Promise((resolve) =>
      this.child.once('close', () => resolve()),
    )
    this.spawned = new Promise((resolve, reject) => {
      const spawned = () => {
        this.child.off('error', failed)
        resolve()
      }
      const failed = () => {
        this.child.off('spawn', spawned)
        reject(new Error('Native process failed to spawn'))
      }
      this.child.once('spawn', spawned)
      this.child.once('error', failed)
    })
    this.child.on('error', this.onSpawnError)
    this.child.once('exit', this.onExit)
    this.child.stdin.on('error', this.onWriteError)
    this.child.stdout.on('error', this.onReadError)
    this.child.stdout.once('end', this.onEnd)
    this.child.stderr.on('data', this.onStderr)
    this.child.stderr.on('error', this.onStderrError)
    this.child.stderr.once('end', this.onStderrEnd)
    options.signal?.addEventListener('abort', this.onAbort, { once: true })
  }

  /** Startup includes the provider transaction, including resume when requested. */
  static async start<T>(
    options: NativeProcessOptions,
    initialize: (runtime: NativeProcess) => Promise<T>,
  ): Promise<{ process: NativeProcess; value: T }> {
    if (options.signal?.aborted) throw new Error('Native startup cancelled')
    if (process.platform !== 'linux')
      throw new Error('Native process supervision requires Linux')
    const timeoutMs = positiveLimit(
      options.startupTimeoutMs ?? 15_000,
      'startup timeout',
    )
    const deadline = performance.now() + timeoutMs
    let runtime: NativeProcess
    try {
      runtime = new NativeProcess(options)
    } catch {
      throw new Error('Native process failed to spawn')
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    void runtime.spawned.catch(() => {})
    try {
      options.onCreated?.(runtime)
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Native startup timed out')),
          Math.max(0, deadline - performance.now()),
        )
      })
      const ended = runtime.ended.then((reason) => {
        throw reason
      })
      const initializeOnce = async () => {
        await runtime.spawned
        if (runtime.signal.aborted) throw new Error('Native startup cancelled')
        return initialize(runtime)
      }
      const value = await Promise.race([initializeOnce(), timeout, ended])
      if (runtime.reason) throw runtime.reason
      if (performance.now() >= deadline)
        throw new Error('Native startup timed out')
      return { process: runtime, value }
    } catch (error) {
      const safe = diagnosticError(error, options.secrets)
      try {
        await runtime.close(safe)
      } catch {
        throw diagnosticError(
          new Error(`${safe.message}; native process cleanup failed`),
          options.secrets,
        )
      }
      throw safe
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  get diagnostics() {
    return this.tail.text
  }

  ownTransport(transport: OwnedTransport) {
    if (this.transport)
      throw new Error('Native process already owns a transport')
    this.transport = transport
    if (this.reason) {
      transport.close(this.reason)
      return
    }
    void transport.done.then((reason) => this.close(reason)).catch(() => {})
  }

  close(reason = new Error('Native process closed')): Promise<void> {
    return this.stop(reason, false)
  }

  private stop(reason: Error, drainOutput: boolean): Promise<void> {
    if (this.closing) return this.closing
    this.reason = diagnosticError(reason, this.options.secrets)
    this.options.signal?.removeEventListener('abort', this.onAbort)
    // Defer shutdown so reentrant abort callbacks observe the same closing promise.
    const attempt = Promise.resolve().then(async () => {
      let cleanupError: Error | undefined
      let deadline = performance.now() + this.graceMs + this.cleanupTimeoutMs
      try {
        if (!drainOutput) this.transport?.close(this.reason!)
        const pid = this.child.pid
        if (!this.groupRetired && pid) {
          let alive = processGroups.signalProcessGroup(pid, 'SIGTERM')
          const graceDeadline = performance.now() + this.graceMs
          while (alive && performance.now() < graceDeadline) {
            await delay(
              Math.min(10, Math.max(1, graceDeadline - performance.now())),
            )
            alive = processGroups.signalProcessGroup(pid, 0)
          }
          deadline = performance.now() + this.cleanupTimeoutMs
          // Never check this group again after observing its removal.
          if (alive && processGroups.signalProcessGroup(pid, 'SIGKILL'))
            await processGroups.waitForProcessGroupExit(pid, deadline)
        }
        this.groupRetired = true
      } catch (error) {
        cleanupError = new Error('Native process group cleanup failed', {
          cause: error,
        })
        this.reason = cleanupError
      } finally {
        if (drainOutput) await this.drainOutput(deadline)
        this.end(this.reason!)
        this.controller.abort()
        this.transport?.close(this.reason!)
        this.child.stdin.destroy()
        this.child.stdout.destroy()
        this.child.stderr.destroy()
        if (!(await this.waitForChildClose(deadline))) {
          cleanupError = new Error('Native process cleanup timed out')
          this.reason = cleanupError
        }
        this.tail.finish()
        this.child.off('error', this.onSpawnError)
        this.child.off('exit', this.onExit)
        this.child.stdin.off('error', this.onWriteError)
        this.child.stdout.off('error', this.onReadError)
        this.child.stdout.off('end', this.onEnd)
        this.child.stderr.off('data', this.onStderr)
        this.child.stderr.off('error', this.onStderrError)
        this.child.stderr.off('end', this.onStderrEnd)
        this.finish(this.reason!)
      }
      if (cleanupError) throw cleanupError
    })
    const retryable = attempt.catch((error) => {
      // Only the original child-close observation can retry after group retirement.
      // A failed group proof never grants another use of its numeric PID.
      if (this.groupRetired && this.closing === retryable)
        this.closing = undefined
      throw error
    })
    this.closing = retryable
    if (!drainOutput) {
      this.end(this.reason)
      this.controller.abort()
    }
    return this.closing
  }

  private async drainOutput(deadline: number) {
    const stdout = this.child.stdout
    if (stdout.readableEnded || stdout.destroyed) return
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer)
        stdout.off('end', finish)
        stdout.off('close', finish)
        resolve()
      }
      const timer = setTimeout(
        finish,
        Math.max(1, deadline - performance.now()),
      )
      stdout.once('end', finish)
      stdout.once('close', finish)
    })
  }

  private async waitForChildClose(deadline: number) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.exited.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(
            () => resolve(false),
            Math.max(1, deadline - performance.now()),
          )
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private onSpawnError = () => {
    void this.close(new Error('Native process failed to spawn')).catch(() => {})
  }
  private onWriteError = () => {
    void this.close(new Error('Native stdin write failed')).catch(() => {})
  }
  private onReadError = () => {
    void this.close(new Error('Native stdout read failed')).catch(() => {})
  }
  private onStderrError = () => {
    void this.close(new Error('Native stderr read failed')).catch(() => {})
  }
  private onAbort = () => {
    void this.close(new Error('Native process cancelled')).catch(() => {})
  }
  private onExit = () => {
    void this.stop(new Error('Native process exited'), true).catch(() => {})
  }
  private onEnd = () => {
    queueMicrotask(() => {
      void this.close(new Error('Native stdout ended')).catch(() => {})
    })
  }
  private onStderr = (chunk: Buffer) => {
    this.tail.append(chunk)
  }
  private onStderrEnd = () => {
    this.tail.finish()
  }
}

export const startNativeProcess = NativeProcess.start
