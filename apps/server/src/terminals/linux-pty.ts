import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  readSync,
  writeSync,
} from 'node:fs'
import type { ReadStream } from 'node:tty'
import * as nodePty from 'node-pty'
import type { IPty, LeaderIdentity, OwnedLinuxV1, OwnedReceipt } from 'node-pty'
import type { TerminalLimitValues } from './limits.js'
import { TerminalError } from './error.js'

type OriginalSocket = ReadStream & {
  _handle: { fd: number } | null
  closed: boolean
}
type NativePty = IPty & { fd: number; _socket: OriginalSocket }
function binding() {
  if (
    process.platform !== 'linux' ||
    process.versions.bun ||
    process.versions.node.split('.')[0] !== '24'
  )
    throw new TerminalError(
      'unavailable',
      503,
      'Terminals require Node 24 on Linux',
    )
  const module = nodePty
  if (module.ownedLinuxV1?.forgeOwnedApiVersion !== 1)
    throw new TerminalError(
      'unavailable',
      503,
      'The owned terminal native build is unavailable',
    )
  return module
}
const identity = (fd: number) => {
  const stat = fstatSync(fd, { bigint: true })
  return `${stat.dev}:${stat.ino}:${stat.rdev}`
}
function nonblocking(fd: number) {
  const info = openSync(
    `/proc/self/fdinfo/${fd}`,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  )
  try {
    const buffer = Buffer.allocUnsafe(4097)
    const size = readSync(info, buffer, 0, buffer.length, 0)
    if (size === buffer.length) return false
    const flags = /^flags:\s*([0-7]+)$/m.exec(buffer.toString('ascii', 0, size))
    return !!flags && (parseInt(flags[1]!, 8) & constants.O_NONBLOCK) !== 0
  } finally {
    closeSync(info)
  }
}

export class LinuxPty {
  private static operations = 0
  private static capability?: Promise<
    Awaited<ReturnType<OwnedLinuxV1['probeOwnedLinuxV1']>>
  >
  private static retryProbeCleanup = false
  readonly receipt: OwnedReceipt
  readonly api: OwnedLinuxV1
  readonly socket: OriginalSocket | null
  private readonly handle: OriginalSocket['_handle']
  private readonly masterIdentity: string | null
  private readonly fd: number | null
  readonly closed: Promise<void>
  private cleanupAttempt: Promise<boolean> | undefined
  private cleanupWork: Promise<boolean> | undefined
  private fenced = false
  outputComplete = false
  leader: LeaderIdentity | null = null
  static capabilities() {
    // This Promise describes physical probe work. Callers retain it after their
    // own logical deadline and never replace it with an unavailable result.
    LinuxPty.capability ??= binding().ownedLinuxV1.probeOwnedLinuxV1(1000)
    return LinuxPty.capability
  }
  static async drainCapabilities() {
    if (!LinuxPty.capability) return true
    if (LinuxPty.retryProbeCleanup) {
      LinuxPty.retryProbeCleanup = false
      LinuxPty.capability = binding().ownedLinuxV1.probeOwnedLinuxV1(1000)
    }
    const result = await LinuxPty.capability
    LinuxPty.retryProbeCleanup = !result.cleanupComplete
    return result.cleanupComplete
  }
  private async operation<T>(end: number, run: () => Promise<T>): Promise<T> {
    while (LinuxPty.operations >= this.limits.inspections) {
      if (performance.now() >= end)
        throw new Error('Native terminal admission deadline')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    if (performance.now() >= end)
      throw new Error('Native terminal admission deadline')
    LinuxPty.operations++
    try {
      return await run()
    } finally {
      LinuxPty.operations--
    }
  }
  constructor(
    file: string,
    args: string[],
    cwd: string,
    env: Readonly<Record<string, string>>,
    cols: number,
    rows: number,
    private readonly limits: Readonly<TerminalLimitValues>,
    onData: (data: Buffer) => void,
  ) {
    const module = binding()
    this.api = module.ownedLinuxV1
    this.receipt = module.spawnOwnedLinuxV1(file, args, {
      cwd,
      env,
      cols,
      rows,
      name: 'xterm-256color',
      encoding: null,
      startupDeadlineMs: limits.startupDeadlineMs,
    })
    const pty = this.receipt.pty as NativePty | null
    this.socket = pty?._socket ?? null
    this.handle = this.socket?._handle ?? null
    this.fd = pty?.fd ?? null
    // After fork, capture failures stay attached to this receipt for cleanup.
    let master: string | null = null
    try {
      if (this.fd !== null && nonblocking(this.fd)) master = identity(this.fd)
    } catch {
      /* ready() refuses; cleanup owns the child */
    }
    this.masterIdentity = master
    this.closed = new Promise((resolve) => {
      if (!this.socket) {
        resolve()
        return
      }
      this.socket.on('data', (data: Buffer) => onData(data))
      this.socket.on('end', () => {
        this.outputComplete = true
      })
      this.socket.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EIO') this.outputComplete = true
      })
      this.socket.once('close', () => resolve())
      if (this.socket.closed) resolve()
    })
    void this.receipt.ready.catch(() => {})
  }
  async ready() {
    const { identity } = await this.receipt.ready
    this.leader = identity
    if (!this.checkMaster())
      throw new TerminalError(
        'unavailable',
        503,
        'Owned terminal descriptor setup failed',
      )
  }
  release() {
    if (
      this.fenced ||
      !this.checkMaster() ||
      !this.api.releaseOwnedV1(this.receipt.token).released
    )
      throw new TerminalError(
        'unavailable',
        503,
        'Terminal startup was revoked',
      )
  }
  fence() {
    this.fenced = true
    this.api.abortBeforeReleaseV1(this.receipt.token)
  }
  checkMaster() {
    if (
      !this.socket ||
      this.socket.destroyed ||
      this.socket._handle !== this.handle ||
      !this.handle ||
      this.fd === null ||
      this.handle.fd !== this.fd ||
      !this.masterIdentity
    )
      return false
    try {
      return identity(this.fd) === this.masterIdentity && nonblocking(this.fd)
    } catch {
      return false
    }
  }
  write(bytes: Buffer, offset: number, count: number): number {
    if (this.fenced || !this.checkMaster())
      throw new TerminalError('unavailable', 503, 'Terminal input is closed')
    return writeSync(this.fd!, bytes, offset, count)
  }
  resize(cols: number, rows: number) {
    if (this.fenced || !this.checkMaster())
      throw new TerminalError('unavailable', 503, 'Terminal resize is closed')
    this.receipt.pty!.resize(cols, rows)
  }
  private closeSocket() {
    if (!this.socket || this.socket.closed) return
    if (this.socket._handle !== this.handle && this.socket._handle !== null)
      throw new TerminalError(
        'cleanup_unknown',
        503,
        'Terminal socket identity changed',
      )
    // This is the original socket. UnixTerminal.destroy installs an unchecked kill.
    this.socket.destroy()
  }
  cleanup(): Promise<boolean> {
    if (this.cleanupAttempt) return this.cleanupAttempt
    this.fence()
    let timer: ReturnType<typeof setTimeout> | undefined
    const work = this.performCleanup()
    this.cleanupWork = work
    const result = Promise.race([
      work,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          this.outputComplete = false
          try {
            this.closeSocket()
          } catch {
            /* Keep the original owner on an identity failure. */
          }
          resolve(false)
        }, this.limits.cleanupDeadlineMs)
      }),
    ])
    this.cleanupAttempt = result
    // Logical expiry does not release an in-flight native operation or enable overlap.
    void work
      .finally(() => {
        if (timer) clearTimeout(timer)
        if (this.cleanupAttempt === result) this.cleanupAttempt = undefined
        if (this.cleanupWork === work) this.cleanupWork = undefined
      })
      .catch(() => {})
    return result
  }
  async joinCleanup() {
    await this.cleanupWork
  }
  private async performCleanup() {
    const start = performance.now()
    const end = start + this.limits.cleanupDeadlineMs
    const scanLimits = () => ({
      maxEntries: this.limits.scanEntries,
      maxBytes: this.limits.scanBytes,
      maxStatBytes: this.limits.statBytes,
      maxMembers: this.limits.members,
      deadlineMs: Math.max(1, Math.floor(end - performance.now())),
    })
    try {
      await this.receipt.ready.catch(() => {})
      for (
        let round = 0;
        round < this.limits.scanRounds && performance.now() < end;
        round++
      ) {
        const state = this.api.ownedStateV1(this.receipt.token)
        if (state.phase === 'reaped') return true
        if (state.phase === 'aborted' && state.waitWorkerSettled) break
        const scan = await this.operation(end, () =>
          this.api.inspectOwnedV1(this.receipt.token, scanLimits()),
        )
        if (performance.now() >= end) return false
        if (
          scan.status === 'complete' &&
          scan.members.length === 0 &&
          this.api.ownedStateV1(this.receipt.token).waitWorkerSettled
        )
          break
        const signal =
          performance.now() - start < this.limits.termGraceMs
            ? 'SIGTERM'
            : 'SIGKILL'
        for (const member of scan.members) {
          if (performance.now() >= end) break
          await this.operation(end, () =>
            this.api.signalOwnedV1(this.receipt.token, member, signal),
          )
        }
        const wait =
          signal === 'SIGTERM'
            ? Math.min(this.limits.termGraceMs, end - performance.now())
            : Math.min(20, end - performance.now())
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      }
      if (performance.now() >= end) return false
      if (this.socket && !this.socket.closed) {
        const remaining = Math.max(0, end - performance.now())
        let timer: ReturnType<typeof setTimeout> | undefined
        await Promise.race([
          this.closed,
          new Promise((resolve) => {
            timer = setTimeout(resolve, remaining)
          }),
        ])
        if (timer) clearTimeout(timer)
        if (!this.socket?.closed) {
          this.outputComplete = false
          this.closeSocket()
        }
      }
      // A timeout never substitutes for original close. Keep its owner if close is delayed.
      if (
        this.socket
          ? !this.socket.closed || this.socket._handle !== null
          : !this.api.ownedStateV1(this.receipt.token).socketClosed
      )
        return false
      const result = await this.operation(end, () =>
        this.api.reapOwnedV1(this.receipt.token, {
          ...scanLimits(),
          deadlineMs: Math.min(
            this.limits.cleanupDeadlineMs,
            Math.max(1, Math.floor(end - performance.now())),
          ),
        }),
      )
      return result.status === 'complete'
    } catch {
      return false
    }
  }
}
