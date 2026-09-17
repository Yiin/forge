import { randomUUID } from 'node:crypto'
import {
  constants,
  accessSync,
  closeSync,
  fstatSync,
  openSync,
  realpathSync,
} from 'node:fs'
import { basename, isAbsolute } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { WebSocket } from 'ws'
import {
  terminalCreateSchema,
  terminalDescriptorSchema,
  terminalDimensionsSchema,
  terminalIdSchema,
  terminalRenameSchema,
  type TerminalDescriptor,
  type TerminalEvent,
} from '@forge/protocol/terminal'
import { KeyedQueue } from '../keyed-queue.js'
import {
  WorkspaceTargets,
  publicWorkspace,
  type WorkspaceResolution,
} from '../workspace/target.js'
import { identity, WorkspaceError } from '../workspace/paths.js'
import { WebSocketEventWriter } from '../ws-writer.js'
import { TerminalError } from './error.js'
import { LinuxPty } from './linux-pty.js'
import { TerminalInputScheduler, type InputOwner } from './input.js'
import {
  MAX_FINAL_EVENT_BYTES,
  resolveTerminalLimits,
  type TerminalLimitValues,
} from './limits.js'

type Entry = { seq: number; text: string; bytes: number }
type Subscriber = {
  socket: WebSocket | null
  writer: WebSocketEventWriter | null
  next: number
  active: boolean
  pumping: boolean
  closing: boolean
  closeTimer?: ReturnType<typeof setTimeout>
  closed: Promise<void>
  resolveClosed: () => void
  physicalClosed: boolean
  openingWrite: boolean
  chargedBytes: number
  release?: () => void
}
type Record = InputOwner & {
  descriptor: TerminalDescriptor
  workspace: WorkspaceResolution | null
  startup?: Promise<void>
  ring: Entry[]
  ringBytes: number
  batch: Buffer[]
  batchBytes: number
  batchTimer?: ReturnType<typeof setTimeout>
  subscribers: Set<Subscriber>
  final: boolean
  explicit: boolean
  hidden: boolean
  cleanup?: Promise<boolean>
  expires: number | null
  abortStartup?: () => void
}
type SessionOwner = {
  project_id: string | null
  cwd: string
  worktree_path: string | null
  deleted_at: number | null
  status: string
  archived_at: number | null
}
export type TerminalManagerOptions = {
  limits?: Partial<TerminalLimitValues>
  environment?: () => NodeJS.ProcessEnv
  native?: typeof LinuxPty
}
export class TerminalManager {
  readonly serverEpoch = randomUUID()
  readonly limits: Readonly<TerminalLimitValues>
  readonly inputs: TerminalInputScheduler
  private readonly records = new Map<string, Record>()
  private readonly projects = new KeyedQueue()
  private readonly Native: typeof LinuxPty
  private accepting = true
  private starts = 0
  private removals = 0
  private subscriptions = 0
  private subscriptionBytes = 0
  private expiryTimer?: ReturnType<typeof setTimeout>
  private capability?: Promise<
    Awaited<ReturnType<typeof LinuxPty.capabilities>>
  >
  private capabilityReady?: Promise<
    Awaited<ReturnType<typeof LinuxPty.capabilities>>
  >
  private shutdown?: Promise<boolean>
  constructor(
    readonly db: DatabaseSync,
    readonly targets: WorkspaceTargets,
    private readonly options: TerminalManagerOptions = {},
  ) {
    this.limits = resolveTerminalLimits(options.limits)
    this.inputs = new TerminalInputScheduler(this.limits)
    this.Native = options.native ?? LinuxPty
  }
  private assertAccepting() {
    if (!this.accepting)
      throw new TerminalError(
        'unavailable',
        503,
        'Terminal shutdown is in progress',
      )
  }
  private capabilities() {
    if (!this.capabilityReady) {
      this.capability = this.Native.capabilities()
      let timer: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new TerminalError(
                'unavailable',
                503,
                'Terminal capability check timed out',
              ),
            ),
          1000,
        )
      })
      this.capabilityReady = Promise.race([this.capability, deadline])
      // The physical probe remains owned by Native and joined by shutdown.
      void this.capability
        .finally(() => {
          if (timer) clearTimeout(timer)
        })
        .catch(() => {})
    }
    return this.capabilityReady
  }
  private owner(sessionId: string, create = false) {
    if (!sessionId || Buffer.byteLength(sessionId) > 256)
      throw new TerminalError(
        'invalid_request',
        400,
        'Invalid session identifier',
      )
    const row = this.db
      .prepare(
        'SELECT s.project_id,s.cwd,s.worktree_path,s.deleted_at,s.status,p.archived_at FROM sessions s LEFT JOIN projects p ON p.id=s.project_id WHERE s.id=? AND p.deleted_at IS NULL',
      )
      .get(sessionId) as SessionOwner | undefined
    if (!row || row.deleted_at !== null)
      throw new TerminalError('not_found', 404, 'Session not found')
    if (create && (row.status === 'archived' || row.archived_at !== null))
      throw new TerminalError(
        'unavailable',
        503,
        'Archived sessions cannot create terminals',
      )
    return row
  }
  private record(sessionId: string, id: string) {
    this.owner(sessionId)
    if (!terminalIdSchema.safeParse(id).success)
      throw new TerminalError(
        'invalid_request',
        400,
        'Invalid terminal identifier',
      )
    if (!id.startsWith(`${this.serverEpoch}.`))
      throw new TerminalError(
        'previous_server',
        410,
        'Terminal belongs to a previous server',
      )
    const record = this.records.get(id)
    if (!record || record.hidden || record.descriptor.sessionId !== sessionId)
      throw new TerminalError('not_found', 404, 'Terminal not found')
    return record
  }
  private public(record: Record) {
    return structuredClone(record.descriptor)
  }
  list(sessionId: string) {
    this.owner(sessionId)
    return {
      serverEpoch: this.serverEpoch,
      terminals: [...this.records.values()]
        .filter(
          (record) =>
            !record.hidden && record.descriptor.sessionId === sessionId,
        )
        .map((record) => this.public(record)),
    }
  }
  get(sessionId: string, id: string) {
    return this.public(this.record(sessionId, id))
  }
  private activity(record: Record) {
    record.descriptor.lastActivityAt = new Date().toISOString()
    if (
      record.descriptor.state === 'exited' &&
      record.descriptor.cleanup === 'complete'
    ) {
      record.expires = performance.now() + this.limits.exitedTtlMs
      record.descriptor.expiresAt = new Date(
        Date.now() + this.limits.exitedTtlMs,
      ).toISOString()
      this.scheduleExpiry()
    }
  }
  async create(sessionId: string, input: unknown, signal?: AbortSignal) {
    const parsed = terminalCreateSchema.safeParse(input)
    if (!parsed.success)
      throw new TerminalError(
        'invalid_request',
        400,
        'Invalid terminal create request',
      )
    const value = parsed.data
    this.assertAccepting()
    const owner = this.owner(sessionId, true)
    if (
      this.records.size >= this.limits.terminals ||
      this.starts >= this.limits.startups
    )
      throw new TerminalError('capacity', 429, 'Terminal capacity reached')
    const environment = this.options.environment?.() ?? process.env
    const shell = environment.SHELL || '/bin/bash'
    if (!isAbsolute(shell) || Buffer.byteLength(shell) > 4096)
      throw new TerminalError(
        'invalid_request',
        400,
        'SHELL must name an absolute executable',
      )
    try {
      accessSync(shell, constants.X_OK)
    } catch {
      throw new TerminalError(
        'unavailable',
        503,
        'Selected shell is unavailable',
      )
    }
    const env: { [key: string]: string } = {}
    let envBytes = 0
    for (const [key, item] of Object.entries(environment)) {
      if (item === undefined) continue
      if (
        !key ||
        key.includes('=') ||
        key.includes('\0') ||
        item.includes('\0')
      )
        throw new TerminalError(
          'invalid_request',
          400,
          'Invalid terminal environment',
        )
      env[key] = item
      envBytes += Buffer.byteLength(key) + Buffer.byteLength(item) + 2
      if (Object.keys(env).length > 256 || envBytes > 65536)
        throw new TerminalError(
          'capacity',
          429,
          'Terminal environment exceeds its limit',
        )
    }
    env.TERM = 'xterm-256color'
    env.COLORTERM = 'truecolor'
    env.TERM_PROGRAM = 'Forge'
    const now = new Date().toISOString()
    const id = `${this.serverEpoch}.${randomUUID()}`
    const record: Record = {
      descriptor: {
        id,
        serverEpoch: this.serverEpoch,
        sessionId,
        projectId: owner.project_id,
        workspace: {
          target: { kind: 'session', sessionId },
          projectId: owner.project_id,
          cwd: owner.cwd,
          worktreePath: owner.worktree_path,
          workspaceId: value.expectedWorkspaceId,
          workspaceRevision: value.expectedWorkspaceRevision,
        },
        title: value.title ?? basename(shell),
        shell: basename(shell),
        cols: value.cols ?? 80,
        rows: value.rows ?? 24,
        state: 'starting',
        createdAt: now,
        lastActivityAt: now,
        exitedAt: null,
        expiresAt: null,
        firstRetainedSeq: 1,
        lastSeq: 0,
        exitCode: null,
        signal: null,
        outputComplete: null,
        cleanup: 'pending',
      },
      native: null,
      input: [],
      inputBytes: 0,
      acceptingInput: false,
      workspace: null,
      ring: [],
      ringBytes: 0,
      batch: [],
      batchBytes: 0,
      subscribers: new Set(),
      final: false,
      explicit: false,
      hidden: true,
      expires: null,
    }
    terminalDescriptorSchema.parse(record.descriptor)
    this.records.set(id, record)
    this.starts++
    const controller = new AbortController()
    record.abortStartup = () =>
      controller.abort(new Error('Terminal startup was revoked'))
    const cancel = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
    const timer = setTimeout(
      () => controller.abort(new Error('Terminal startup deadline')),
      this.limits.startupDeadlineMs,
    )
    const startup = this.projects.run(
      owner.project_id ?? `session:${sessionId}`,
      async () => {
        this.assertAccepting()
        controller.signal.throwIfAborted()
        const capabilities = await this.capabilities()
        if (!capabilities.supported)
          throw new TerminalError(
            'unavailable',
            503,
            capabilities.reason ?? 'Owned terminal support is unavailable',
          )
        const initial = await this.targets.resolve(
          { kind: 'session', sessionId },
          controller.signal,
        )
        this.targets.checkExpected(initial, value)
        await this.targets.mutations.run(
          initial.gateKey,
          async () => {
            const workspace = await this.targets.resolve(
              { kind: 'session', sessionId },
              controller.signal,
            )
            this.targets.checkExpected(workspace, value)
            if (
              workspace.fingerprint !== initial.fingerprint ||
              workspace.gateKey !== initial.gateKey
            )
              throw new TerminalError(
                'workspace_changed',
                409,
                'Workspace changed',
              )
            let fd: number | undefined
            try {
              fd = openSync(
                workspace.cwd,
                constants.O_RDONLY |
                  constants.O_DIRECTORY |
                  constants.O_NOFOLLOW,
              )
              if (
                identity(fstatSync(fd, { bigint: true })) !==
                  workspace.rootIdentity ||
                realpathSync(`/proc/self/fd/${fd}`) !== workspace.cwd
              )
                throw new TerminalError(
                  'workspace_changed',
                  409,
                  'Workspace changed',
                )
              this.owner(sessionId, true)
              this.assertAccepting()
              controller.signal.throwIfAborted()
              record.workspace = workspace
              record.descriptor.workspace = publicWorkspace(workspace)
              record.hidden = false
              record.native = new this.Native(
                '/usr/bin/env',
                [`PWD=${workspace.cwd}`, shell, '-l'],
                `/proc/self/fd/${fd}`,
                Object.freeze(env),
                record.descriptor.cols,
                record.descriptor.rows,
                this.limits,
                (data) => this.output(record, data),
              )
              void record.native.receipt.leaderExit
                .then((exit) => {
                  record.descriptor.exitCode = exit.exitCode
                  record.descriptor.signal = exit.signal
                  if (record.descriptor.state === 'running')
                    return this.clean(record, 'process_exit')
                })
                .catch(() => {
                  record.descriptor.state = 'unavailable'
                  record.descriptor.cleanup = 'unknown'
                })
            } finally {
              if (fd !== undefined) closeSync(fd)
            }
            await record.native.ready()
            const final = await this.targets.resolve(
              { kind: 'session', sessionId },
              controller.signal,
            )
            this.targets.checkExpected(final, value)
            if (
              final.fingerprint !== workspace.fingerprint ||
              final.rootIdentity !== workspace.rootIdentity
            )
              throw new TerminalError(
                'workspace_changed',
                409,
                'Workspace changed',
              )
            this.owner(sessionId, true)
            this.assertAccepting()
            controller.signal.throwIfAborted()
            record.native.release()
            record.descriptor.state = 'running'
            record.acceptingInput = true
          },
          controller.signal,
        )
      },
      controller.signal,
    )
    record.startup = startup
    try {
      await startup
      return this.public(record)
    } catch (error) {
      if (record.native) await this.clean(record, 'startup_failed')
      else this.records.delete(id)
      if (error instanceof TerminalError) throw error
      if (error instanceof WorkspaceError && error.status === 409)
        throw new TerminalError('workspace_changed', 409, 'Workspace changed')
      if (error instanceof WorkspaceError && error.status === 404) {
        // The session can disappear after the initial owner check.
        this.owner(sessionId, true)
        throw new TerminalError('not_found', 404, 'Workspace target not found')
      }
      throw new TerminalError('unavailable', 503, 'Terminal startup failed')
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      await record.native?.joinCleanup()
      this.starts--
      record.startup = undefined
      record.abortStartup = undefined
      this.collect(record)
    }
  }
  rename(sessionId: string, id: string, value: unknown) {
    this.assertAccepting()
    const parsed = terminalRenameSchema.safeParse(value)
    if (!parsed.success)
      throw new TerminalError('invalid_request', 400, 'Invalid terminal title')
    const record = this.record(sessionId, id)
    record.descriptor.title = parsed.data.title
    this.activity(record)
    return this.public(record)
  }
  async input(
    sessionId: string,
    id: string,
    data: string,
    signal?: AbortSignal,
  ) {
    this.assertAccepting()
    const record = this.record(sessionId, id)
    const operation = this.inputs.submit(record, data, signal)
    this.activity(record)
    const result = await operation
    if (result.status !== 'written')
      throw new TerminalError(
        'input_incomplete',
        409,
        'Terminal input stopped',
        { input: result },
      )
    return result
  }
  resize(sessionId: string, id: string, value: unknown) {
    this.assertAccepting()
    const record = this.record(sessionId, id)
    const parsed = terminalDimensionsSchema.safeParse(value)
    if (!parsed.success)
      throw new TerminalError(
        'invalid_request',
        400,
        'Invalid terminal dimensions',
      )
    if (record.descriptor.state !== 'running')
      throw new TerminalError('unavailable', 503, 'Terminal is not running')
    record.native!.resize(parsed.data.cols, parsed.data.rows)
    Object.assign(record.descriptor, parsed.data)
    this.activity(record)
    return this.public(record)
  }
  async close(sessionId: string, id: string) {
    const record = this.record(sessionId, id)
    record.explicit = true
    if (!(await this.clean(record, 'explicit_close')))
      throw new TerminalError(
        'cleanup_unknown',
        503,
        'Terminal cleanup is unknown',
      )
    record.hidden = true
    this.collect(record)
    return { closed: true as const }
  }
  private clean(record: Record, reason: string) {
    if (record.cleanup) return record.cleanup
    this.inputs.close(record)
    record.native?.fence()
    record.descriptor.state = 'closing'
    const attempt = (async () => {
      const complete = record.native ? await record.native.cleanup() : true
      record.descriptor.cleanup = complete ? 'complete' : 'unknown'
      record.descriptor.state = complete ? 'exited' : 'unavailable'
      if (complete || record.native?.socket?.closed) {
        record.descriptor.outputComplete =
          record.native?.outputComplete ?? false
        record.descriptor.exitedAt ??= new Date().toISOString()
        this.flush(record)
        if (!record.final) {
          record.final = true
          this.event(record, {
            type: 'exit',
            terminalId: record.descriptor.id,
            seq: record.descriptor.lastSeq + 1,
            exitCode: record.descriptor.exitCode,
            signal: record.descriptor.signal,
            outputComplete: record.descriptor.outputComplete,
            cleanup: record.descriptor.cleanup,
            reason,
          })
        }
      }
      if (complete && !record.explicit) this.activity(record)
      return complete
    })()
    record.cleanup = attempt
    void attempt
      .finally(() => {
        if (record.cleanup === attempt) record.cleanup = undefined
      })
      .catch(() => {})
    return attempt
  }
  private output(record: Record, data: Buffer) {
    if (record.final || !Buffer.isBuffer(data)) return
    for (let offset = 0; offset < data.length;) {
      const size = Math.min(
        this.limits.batchBytes - record.batchBytes,
        data.length - offset,
      )
      record.batch.push(Buffer.from(data.subarray(offset, offset + size)))
      record.batchBytes += size
      offset += size
      if (record.batchBytes >= this.limits.batchBytes) this.flush(record)
    }
    if (record.batchBytes && !record.batchTimer)
      record.batchTimer = setTimeout(() => {
        record.batchTimer = undefined
        this.flush(record)
      }, this.limits.batchMs)
  }
  private flush(record: Record) {
    if (record.batchTimer) clearTimeout(record.batchTimer)
    record.batchTimer = undefined
    if (!record.batchBytes) return
    const data = Buffer.concat(record.batch, record.batchBytes).toString(
      'base64',
    )
    record.batch = []
    record.batchBytes = 0
    this.event(record, {
      type: 'data',
      terminalId: record.descriptor.id,
      seq: record.descriptor.lastSeq + 1,
      data,
    })
  }
  private event(
    record: Record,
    event: Exclude<TerminalEvent, { type: 'snapshot' }>,
  ) {
    if (event.seq >= Number.MAX_SAFE_INTEGER && event.type !== 'exit') {
      void this.clean(record, 'sequence_limit')
      return
    }
    const text = JSON.stringify(event),
      bytes = Buffer.byteLength(text)
    const reserve = event.type === 'exit' ? 0 : MAX_FINAL_EVENT_BYTES
    while (
      record.ring.length &&
      (record.ring.length >= this.limits.replayEvents - (reserve ? 1 : 0) ||
        record.ringBytes + bytes + reserve > this.limits.replayBytes)
    )
      record.ringBytes -= record.ring.shift()!.bytes
    record.ring.push({ seq: event.seq, text, bytes })
    record.ringBytes += bytes
    record.descriptor.lastSeq = event.seq
    record.descriptor.firstRetainedSeq = record.ring[0]!.seq
    for (const sub of record.subscribers) void this.pump(record, sub)
  }
  reserveSubscription(sessionId: string, id: string, afterSeq: number) {
    this.assertAccepting()
    const record = this.record(sessionId, id)
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0)
      throw new TerminalError('invalid_request', 400, 'Invalid terminal cursor')
    if (afterSeq > record.descriptor.lastSeq)
      throw new TerminalError(
        'future_cursor',
        409,
        'Terminal cursor is ahead of output',
      )
    if (
      record.subscribers.size >= this.limits.subscriptions ||
      this.subscriptions >= this.limits.hostSubscriptions
    )
      throw new TerminalError(
        'capacity',
        429,
        'Terminal subscription capacity reached',
      )
    let resolveClosed!: () => void
    const sub: Subscriber = {
      socket: null,
      writer: null,
      next: afterSeq + 1,
      active: false,
      pumping: false,
      closing: false,
      physicalClosed: false,
      openingWrite: false,
      chargedBytes: 0,
      closed: new Promise((resolve) => {
        resolveClosed = resolve
      }),
      resolveClosed: () => resolveClosed(),
    }
    record.subscribers.add(sub)
    this.subscriptions++
    const release = () => {
      sub.physicalClosed = true
      sub.closing = true
      sub.writer?.close()
      if (sub.pumping || sub.openingWrite) return
      if (!record.subscribers.delete(sub)) return
      if (sub.closeTimer) clearTimeout(sub.closeTimer)
      this.subscriptionBytes -= sub.chargedBytes
      sub.chargedBytes = 0
      sub.resolveClosed()
      this.subscriptions--
      this.collect(record)
    }
    sub.release = release
    return {
      releaseOpening: release,
      open: (socket: WebSocket) => {
        if (sub.closing || !this.accepting) {
          sub.socket = socket
          socket.once('close', release)
          this.closeSubscriber(sub)
          return
        }
        sub.socket = socket
        socket.once('close', release)
        socket.on('error', () => this.closeSubscriber(sub))
        socket.on('message', () => this.closeSubscriber(sub))
        sub.writer = new WebSocketEventWriter(
          socket,
          () => this.closeSubscriber(sub),
          this.limits.subscriptionEvents,
          {
            maxQueuedBytes: this.limits.subscriptionBytes,
            writeDeadlineMs: this.limits.writeDeadlineMs,
            reserve: (bytes) => {
              if (
                this.subscriptionBytes + bytes >
                this.limits.hostSubscriptionBytes
              )
                return false
              this.subscriptionBytes += bytes
              sub.chargedBytes += bytes
              return true
            },
            release: (bytes) => {
              if (
                !sub.closing &&
                socket.readyState === socket.OPEN &&
                socket.bufferedAmount === 0
              ) {
                this.subscriptionBytes -= bytes
                sub.chargedBytes -= bytes
              }
            },
          },
        )
        // Attach, snapshot, and replay cut use one synchronous turn.
        const first = record.descriptor.firstRetainedSeq
        const snapshot = {
          type: 'snapshot',
          descriptor: this.public(record),
          requestedAfterSeq: afterSeq,
          firstRetainedSeq: first,
          lastSeq: record.descriptor.lastSeq,
          replayGap:
            afterSeq + 1 < first
              ? { fromSeq: afterSeq + 1, toSeq: first - 1, reason: 'evicted' }
              : null,
        }
        sub.next = Math.max(afterSeq + 1, first)
        this.activity(record)
        sub.openingWrite = true
        void sub.writer
          .write(JSON.stringify(snapshot))
          .then((sent) => {
            if (!sent) return this.closeSubscriber(sub)
            sub.active = true
            return this.pump(record, sub)
          })
          .finally(() => {
            sub.openingWrite = false
            if (sub.physicalClosed) release()
          })
      },
      closed: sub.closed,
    }
  }
  private async pump(record: Record, sub: Subscriber) {
    if (!sub.active || sub.pumping || sub.closing || !sub.writer) return
    sub.pumping = true
    try {
      while (!sub.closing) {
        if (sub.next < record.descriptor.firstRetainedSeq) {
          this.closeSubscriber(sub)
          break
        }
        const entry = record.ring[sub.next - record.descriptor.firstRetainedSeq]
        if (!entry) {
          if (record.final) this.closeSubscriber(sub)
          break
        }
        if (!(await sub.writer.write(entry.text))) {
          this.closeSubscriber(sub)
          break
        }
        sub.next++
      }
    } finally {
      sub.pumping = false
      if (sub.physicalClosed) sub.release?.()
    }
  }
  private closeSubscriber(sub: Subscriber) {
    if (sub.closing) return
    sub.closing = true
    sub.writer?.close()
    if (!sub.socket) return
    if (sub.socket.readyState < 2) sub.socket.close()
    sub.closeTimer = setTimeout(() => {
      sub.closeTimer = undefined
      sub.socket?.terminate()
    }, this.limits.socketCloseMs)
  }
  private collect(record: Record) {
    if (
      record.hidden &&
      record.descriptor.cleanup === 'complete' &&
      !record.subscribers.size &&
      !record.startup &&
      !record.cleanup
    )
      this.records.delete(record.descriptor.id)
  }
  private scheduleExpiry() {
    if (this.expiryTimer) clearTimeout(this.expiryTimer)
    this.expiryTimer = undefined
    const values = [...this.records.values()].filter(
      (record) =>
        record.expires !== null &&
        record.descriptor.cleanup === 'complete' &&
        !record.hidden,
    )
    if (!values.length || !this.accepting) return
    this.expiryTimer = setTimeout(
      () => {
        this.expiryTimer = undefined
        for (const record of values)
          if (record.expires! <= performance.now()) {
            record.hidden = true
            for (const sub of record.subscribers) this.closeSubscriber(sub)
            this.collect(record)
          }
        this.scheduleExpiry()
      },
      Math.max(
        1,
        Math.min(
          ...values.map((record) => record.expires! - performance.now()),
        ),
      ),
    )
    this.expiryTimer.unref?.()
  }
  async removeSession<T>(sessionId: string, operation: () => Promise<T>) {
    const row = this.db
      .prepare('SELECT project_id FROM sessions WHERE id=?')
      .get(sessionId) as { project_id: string | null } | undefined
    const project = row?.project_id ?? `session:${sessionId}`
    return this.remove(
      project,
      (record) => record.descriptor.sessionId === sessionId,
      operation,
    )
  }
  async removeProject<T>(projectId: string, operation: () => Promise<T>) {
    return this.remove(
      projectId,
      (record) => record.descriptor.projectId === projectId,
      operation,
    )
  }
  async removeWorkspace<T>(sessionId: string, operation: () => Promise<T>) {
    const owner = this.owner(sessionId)
    let workspace: WorkspaceResolution
    return this.remove(
      owner.project_id ?? `session:${sessionId}`,
      (record) =>
        record.workspace?.rootIdentity === workspace.rootIdentity &&
        record.workspace?.cwd === workspace.cwd,
      operation,
      async () => {
        if (this.owner(sessionId).project_id !== owner.project_id)
          throw new TerminalError(
            'workspace_changed',
            409,
            'Workspace owner changed',
          )
        workspace = await this.targets.resolve({ kind: 'session', sessionId })
        return workspace
      },
    )
  }
  private async remove<T>(
    ownerKey: string,
    match: (record: Record) => boolean,
    operation: () => Promise<T>,
    resolveWorkspace?: () => Promise<WorkspaceResolution>,
  ) {
    this.assertAccepting()
    if (this.removals >= this.limits.removals)
      throw new TerminalError(
        'capacity',
        429,
        'Terminal removal capacity reached',
      )
    this.removals++
    try {
      return await this.projects.run(ownerKey, async () => {
        this.assertAccepting()
        const workspace = await resolveWorkspace?.()
        const owners = [...this.records.values()].filter(match)
        const gates = [
          ...new Set([
            ...(workspace ? [workspace.gateKey] : []),
            ...owners.flatMap((record) =>
              record.workspace ? [record.workspace.gateKey] : [],
            ),
          ]),
        ].sort()
        const guarded = async (at: number): Promise<T> => {
          if (at < gates.length)
            return this.targets.mutations.run(gates[at]!, () => guarded(at + 1))
          if (workspace && resolveWorkspace) {
            const confirmed = await resolveWorkspace()
            if (
              workspace.fingerprint !== confirmed.fingerprint ||
              workspace.rootIdentity !== confirmed.rootIdentity
            )
              throw new TerminalError(
                'workspace_changed',
                409,
                'Workspace changed before removal',
              )
          }
          // Another project can share this physical directory. Include any owner
          // that completed startup before this operation acquired its physical gate.
          const captured = workspace
            ? [...this.records.values()].filter(match)
            : owners
          for (const record of captured) {
            record.abortStartup?.()
            if (!(await this.clean(record, 'workspace_removed')))
              throw new TerminalError(
                'cleanup_unknown',
                503,
                'Terminal cleanup prevents deletion',
              )
          }
          this.assertAccepting()
          const result = await operation()
          for (const record of captured) {
            record.explicit = true
            record.hidden = true
            this.collect(record)
          }
          return result
        }
        return guarded(0)
      })
    } finally {
      this.removals--
    }
  }
  stopAccepting() {
    this.accepting = false
    this.inputs.stop()
    if (this.expiryTimer) clearTimeout(this.expiryTimer)
    this.expiryTimer = undefined
    for (const record of this.records.values()) {
      record.abortStartup?.()
      record.native?.fence()
    }
  }
  closeAll(): Promise<boolean> {
    if (this.shutdown) return this.shutdown
    this.stopAccepting()
    const attempt = (async () => {
      await Promise.allSettled(
        [...this.records.values()].flatMap((record) =>
          record.startup ? [record.startup] : [],
        ),
      )
      if (!(await this.Native.drainCapabilities())) return false
      if (this.removals) return false
      for (const record of this.records.values())
        if (!(await this.clean(record, 'server_shutdown'))) return false
      for (const record of this.records.values())
        for (const sub of record.subscribers) this.closeSubscriber(sub)
      const pending = [...this.records.values()].flatMap((record) =>
        [...record.subscribers].map((sub) => sub.closed),
      )
      if (pending.length) {
        let timer: ReturnType<typeof setTimeout> | undefined
        await Promise.race([
          Promise.all(pending),
          new Promise((resolve) => {
            timer = setTimeout(resolve, this.limits.socketCloseMs + 50)
          }),
        ])
        if (timer) clearTimeout(timer)
      }
      if (this.subscriptions) return false
      for (const record of this.records.values()) {
        record.hidden = true
        this.collect(record)
      }
      return this.records.size === 0
    })()
    this.shutdown = attempt
    void attempt
      .finally(() => {
        if (this.shutdown === attempt) this.shutdown = undefined
      })
      .catch(() => {})
    return attempt
  }
  resourceState() {
    return {
      terminals: this.records.size,
      startups: this.starts,
      removals: this.removals,
      subscriptions: this.subscriptions,
      subscriptionBytes: this.subscriptionBytes,
      inputBytes: this.inputs.retainedBytes,
    }
  }
}
