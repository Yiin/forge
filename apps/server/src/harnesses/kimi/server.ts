import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { access, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { JsonlTransport } from '../jsonl.js'
import {
  KimiBudget,
  KimiError,
  boundedString,
  deadline,
  jsonBytes,
  reserveAll,
  guardianLimits,
} from './limits.js'
import {
  object,
  parseHttpEnvelope,
  type HttpOptions,
  type KimiOwnedBytes,
} from './transport.js'
import type { EffectiveAuthority } from './authority.js'

/** Both candidates derive from this trusted module. Session cwd cannot choose executable code. */
export async function resolveKimiGuardian(
  moduleUrl = import.meta.url,
): Promise<string> {
  const candidates = [
    new URL('./kimi-guardian.js', moduleUrl),
    new URL('../../../../../dist/kimi-guardian.js', moduleUrl),
  ]
  for (const candidate of candidates) {
    const path = fileURLToPath(candidate)
    try {
      const info = await stat(path)
      if (info.isFile()) return await realpath(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  throw new KimiError(
    'kimi_guardian_artifact_missing',
    'Build the Kimi guardian before starting Kimi',
  )
}
async function nodeExecutable() {
  if (
    basename(process.execPath) === 'node' &&
    Number(process.versions.node.split('.')[0]) === 24
  )
    return process.execPath
  for (const entry of (process.env.PATH ?? '').split(':')) {
    if (!isAbsolute(entry)) continue
    try {
      const candidate = await realpath(join(entry, 'node'))
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      /* Continue through the backend's trusted PATH. */
    }
  }
  throw new KimiError('kimi_node_unavailable')
}
type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  release: () => void
}
/** A guardian error reply proves dispatch settled without returning an owned blob. */
class KimiGuardianError extends KimiError {}
export class KimiServer {
  readonly transcriptStore = randomUUID()
  readonly done: Promise<void>
  private readonly child: ChildProcessWithoutNullStreams
  private readonly ipc: JsonlTransport
  private readonly pending = new Map<string, Pending>()
  private readonly httpReleases = new Map<string, () => void>()
  private readonly httpReleaseWaiters = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >()
  private readonly transfers = new Set<Promise<unknown>>()
  private readonly socketReleases = new Map<string, () => void>()
  private readonly blobReleases = new Set<() => void>()
  private readonly sockets = new Map<
    string,
    { frame: (frame: unknown) => void; failure: (error: Error) => void }
  >()
  private ordinal = 0
  private closing?: Promise<void>
  private stopped = false
  cleanupProved = false
  private failure?: Error
  private constructor(
    command: string,
    artifact: string,
    readonly authority: EffectiveAuthority,
    readonly hostBudget: KimiBudget,
    private readonly releaseGuardian: () => void,
    private readonly releaseNative: () => void,
  ) {
    this.child = spawn(
      command,
      [artifact, JSON.stringify(guardianLimits(hostBudget.limits))],
      {
        cwd: authority.bootstrapCwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
        detached: false,
      },
    )
    this.done = new Promise((resolve) =>
      this.child.once('close', () => {
        this.stopped = true
        this.fail(new KimiError('kimi_guardian_ended'))
        releaseGuardian()
        if (this.cleanupProved) releaseNative()
        for (const pending of this.pending.values()) pending.release()
        this.pending.clear()
        for (const release of this.httpReleases.values()) release()
        this.httpReleases.clear()
        for (const waiter of this.httpReleaseWaiters.values())
          waiter.reject(this.failure ?? new KimiError('kimi_server_closed'))
        this.httpReleaseWaiters.clear()
        for (const release of this.socketReleases.values()) release()
        this.socketReleases.clear()
        for (const release of this.blobReleases) release()
        this.blobReleases.clear()
        resolve()
      }),
    )
    this.child.once('error', () =>
      this.fail(new KimiError('kimi_guardian_start_failed')),
    )
    let stderr = 0
    this.child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.length
      if (stderr > hostBudget.limits.stderrBytes)
        this.fail(new KimiError('kimi_guardian_stderr_limit'))
    })
    this.ipc = new JsonlTransport({
      stdin: this.child.stdin,
      stdout: this.child.stdout,
      maxLineBytes: hostBudget.limits.ipcMessageBytes,
      maxQueuedBytes: hostBudget.limits.ipcBufferedBytes,
      maxQueuedFrames: hostBudget.limits.replayFrames,
      resources: {
        measureOutgoing: (value) =>
          jsonBytes(
            value,
            hostBudget.limits,
            hostBudget.limits.ipcMessageBytes,
          ),
        reserve: (_kind, bytes) => hostBudget.reserve('hostIpcBytes', bytes),
      },
      validateOutgoing: (value) => {
        jsonBytes(value, hostBudget.limits, hostBudget.limits.ipcMessageBytes)
      },
      onValue: (value) => {
        try {
          const message = object(value)
          if (message.type === 'cleanup_proved') {
            this.cleanupProved = true
            return
          }
          if (message.type === 'http_released') {
            const id = boundedString(
              message.id,
              hostBudget.limits.controlIdBytes,
            )
            this.httpReleases.get(id)?.()
            this.httpReleases.delete(id)
            this.httpReleaseWaiters.get(id)?.resolve()
            this.httpReleaseWaiters.delete(id)
            return
          }
          if (message.type === 'frame') {
            this.sockets
              .get(
                boundedString(message.socketId, hostBudget.limits.forgeIdBytes),
              )
              ?.frame(message.frame)
            return
          }
          if (message.type === 'socket_failed') {
            this.sockets
              .get(
                boundedString(message.socketId, hostBudget.limits.forgeIdBytes),
              )
              ?.failure(new KimiError('kimi_socket_failed'))
            return
          }
          if (message.type === 'server_failed') {
            this.fail(new KimiError('kimi_native_process_ended'))
            return
          }
          const id = boundedString(
              message.id,
              hostBudget.limits.controlIdBytes,
            ),
            pending = this.pending.get(id)
          if (!pending) return
          this.pending.delete(id)
          pending.release()
          if (message.type === 'result') pending.resolve(message.data)
          else
            pending.reject(
              new KimiGuardianError(
                boundedString(message.code, 256),
                boundedString(message.code, 256),
                message.uncertain === true,
              ),
            )
        } catch {
          this.fail(new KimiError('kimi_guardian_protocol'))
        }
      },
    })
    void this.ipc.done.then(() => {
      if (!this.closing)
        this.fail(new KimiError('kimi_guardian_channel_closed'))
    })
  }
  static async start(authority: EffectiveAuthority, hostBudget: KimiBudget) {
    const artifact = await resolveKimiGuardian(),
      command = await nodeExecutable()
    const releaseGuardian = reserveAll([
      [hostBudget, 'hostGuardians'],
      [hostBudget, 'hostProcesses'],
      [
        hostBudget,
        'hostIpcBytes',
        guardianLimits(hostBudget.limits).hostIpcBytes,
      ],
      [hostBudget, 'hostTimers', guardianLimits(hostBudget.limits).hostTimers],
      [
        hostBudget,
        'hostRetainedBytes',
        guardianLimits(hostBudget.limits).hostRetainedBytes,
      ],
    ])
    let releaseNative: () => void
    try {
      releaseNative = hostBudget.reserve('hostProcesses')
    } catch (error) {
      releaseGuardian()
      throw error
    }
    let server: KimiServer
    try {
      server = new KimiServer(
        command,
        artifact,
        authority,
        hostBudget,
        releaseGuardian,
        releaseNative,
      )
    } catch (error) {
      releaseGuardian()
      releaseNative()
      throw error
    }
    try {
      const releaseUtility = hostBudget.reserve('hostLockUtilities')
      try {
        await server.rpc(
          {
            op: 'initialize',
            authority: authority.selected,
            removals: Object.keys(authority.selected.environment).filter(
              (key) => authority.selected.environment[key] === undefined,
            ),
            limits: guardianLimits(hostBudget.limits),
          },
          hostBudget.limits.startupMs + hostBudget.limits.shutdownMs,
          false,
          true,
        )
      } finally {
        releaseUtility()
      }
      return server
    } catch (error) {
      try {
        await server.close()
      } catch {
        throw new KimiError(
          'kimi_home_cleanup_unproved',
          'Kimi home cleanup remains unproved',
          true,
        )
      }
      throw error
    }
  }
  private fail(error: Error) {
    if (this.failure) return
    this.failure = error
    for (const socket of this.sockets.values()) socket.failure(error)
    for (const pending of this.pending.values()) pending.reject(error)
    // Physical IPC charges remain until the guardian closes or returns the original call.
    if (this.stopped) {
      for (const pending of this.pending.values()) pending.release()
      this.pending.clear()
    }
    if (!this.closing && !this.stopped) void this.close().catch(() => {})
  }
  rpc(
    message: Record<string, unknown>,
    ms = this.hostBudget.limits.guardianControlMs,
    physicalOnly = false,
    waitForRelease = false,
  ): Promise<unknown> {
    if (this.stopped || (this.failure && message.op !== 'close'))
      return Promise.reject(this.failure ?? new KimiError('kimi_server_closed'))
    jsonBytes(
      message,
      this.hostBudget.limits,
      this.hostBudget.limits.ipcMessageBytes,
    )
    const isHttp =
      message.op === 'http' ||
      message.op === 'http_wire' ||
      message.op === 'blob_http' ||
      message.op === 'initialize'
    const options = message.options as HttpOptions | undefined
    const bodyBytes =
      options?.body === undefined
        ? 0
        : jsonBytes(
            options.body,
            this.hostBudget.limits,
            this.hostBudget.limits.httpControlBytes,
          )
    const copies = options?.raw ? 2 : 5
    const requested =
      message.op === 'initialize'
        ? this.hostBudget.limits.startupBytes
        : (options?.maxBytes ?? this.hostBudget.limits.httpControlBytes)
    const available =
      this.hostBudget.limits.hostHttpBufferBytes -
      this.hostBudget.count('hostHttpBufferBytes') -
      bodyBytes * 3
    const maximum = requested
    if (isHttp && message.op !== 'http_wire' && maximum < 1)
      throw new KimiError('kimi_http_buffer_limit')
    if (isHttp && message.op !== 'initialize' && message.op !== 'http_wire')
      message = { ...message, options: { ...options, maxBytes: maximum } }
    if (isHttp && message.op !== 'http_wire' && maximum * copies > available)
      throw new KimiError('kimi_http_buffer_limit')
    const release = reserveAll(
      isHttp
        ? ([
            [this.hostBudget, 'hostHttp'],
            ...(message.op === 'http_wire'
              ? []
              : [
                  [
                    this.hostBudget,
                    'hostHttpBufferBytes',
                    maximum * copies + bodyBytes * 3,
                  ] as const,
                ]),
          ] as const)
        : [],
    )
    let releaseTimer: () => void
    try {
      releaseTimer = physicalOnly
        ? () => {}
        : this.hostBudget.reserve('hostTimers')
    } catch (error) {
      release()
      throw error
    }
    const id = `ipc-${++this.ordinal}`
    let released = Promise.resolve()
    if (isHttp) {
      this.httpReleases.set(id, release)
      if (waitForRelease)
        released = new Promise<void>((resolve, reject) =>
          this.httpReleaseWaiters.set(id, { resolve, reject }),
        )
    }
    let written: Promise<void> = Promise.resolve()
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, {
        resolve,
        reject,
        release: isHttp ? () => {} : release,
      })
      written = this.ipc.send(
        { ...message, id },
        physicalOnly ? undefined : { deadline: performance.now() + ms },
      )
      void written.catch(() => {
        this.fail(
          new KimiError(
            'kimi_guardian_write_unknown',
            'Kimi guardian write is unknown',
            true,
          ),
        )
      })
    })
    const physical = physicalOnly
      ? Promise.allSettled([response, written]).then(([reply, write]) => {
          if (reply.status === 'rejected') throw reply.reason
          if (write.status === 'rejected') throw write.reason
          return reply.value
        })
      : response
    const complete = waitForRelease
      ? Promise.all([physical, released]).then(([value]) => value)
      : physical
    return (physicalOnly ? complete : deadline(complete, ms))
      .finally(releaseTimer)
      .finally(() => {
        if (waitForRelease) this.httpReleaseWaiters.delete(id)
      })
  }
  async http(
    lane: string,
    path: string,
    options: HttpOptions = {},
    ownership?: {
      release(): void
      abandonedResult?(value: unknown): Promise<void>
    },
  ): Promise<unknown> {
    let releaseTimer = () => {},
      transferred = false
    try {
      options.signal?.throwIfAborted()
      const cancellation = options.binary ? new AbortController() : undefined
      const timed = !!options.signal || !!cancellation
      if (timed) releaseTimer = this.hostBudget.reserve('hostTimers')
      const native = this.httpPhysical(
        lane,
        path,
        cancellation
          ? {
              ...options,
              signal: options.signal
                ? AbortSignal.any([options.signal, cancellation.signal])
                : cancellation.signal,
            }
          : options,
      )
      let resolveDelivery!: (delivered: boolean) => void
      const delivery = new Promise<boolean>((resolve) => {
        resolveDelivery = resolve
      })
      const physical = native
        .then(async (value) => {
          if (!(await delivery)) await ownership?.abandonedResult?.(value)
          return value
        })
        .finally(() => ownership?.release())
      transferred = true
      this.transfers.add(physical)
      void physical
        .finally(() => this.transfers.delete(physical))
        .catch(() => {})
      let delivered = false
      try {
        const value = timed
          ? await deadline(
              native,
              this.hostBudget.limits.httpMs +
                this.hostBudget.limits.guardianControlMs,
              options.signal,
            )
          : await native
        delivered = true
        return value
      } finally {
        if (!delivered) cancellation?.abort()
        resolveDelivery(delivered)
      }
    } finally {
      releaseTimer()
      if (!transferred) ownership?.release()
    }
  }
  private async httpPhysical(
    lane: string,
    path: string,
    options: HttpOptions,
  ): Promise<unknown> {
    const { signal, ...wire } = options
    signal?.throwIfAborted()
    const maximum = options.maxBytes ?? this.hostBudget.limits.httpControlBytes
    if (
      !Number.isSafeInteger(maximum) ||
      maximum < 1 ||
      maximum >
        (options.raw
          ? this.hostBudget.limits.attachmentBytes
          : this.hostBudget.limits.httpJsonBytes)
    )
      throw new KimiError('kimi_response_limit')
    if (options.binary) {
      const blobId = randomUUID(),
        bytes = options.binary
      const releaseBlob = this.reserveBlob(bytes.length)
      try {
        await this.rpc(
          {
            op: 'blob_begin',
            lane,
            blobId,
            sizeBytes: bytes.length,
          },
          undefined,
          true,
        )
        try {
          for (
            let offset = 0;
            offset < bytes.length;
            offset += this.hostBudget.limits.ipcMediaChunkBytes
          ) {
            signal?.throwIfAborted()
            const releaseChunk = this.hostBudget.reserve(
              'hostIpcBytes',
              Math.ceil(
                Math.min(
                  bytes.length - offset,
                  this.hostBudget.limits.ipcMediaChunkBytes,
                ) / 3,
              ) * 8,
            )
            try {
              await this.rpc(
                {
                  op: 'blob_chunk',
                  lane,
                  blobId,
                  offset,
                  data: Buffer.from(
                    bytes.buffer,
                    bytes.byteOffset + offset,
                    Math.min(
                      bytes.length - offset,
                      this.hostBudget.limits.ipcMediaChunkBytes,
                    ),
                  ).toString('base64'),
                },
                undefined,
                true,
              )
            } finally {
              releaseChunk()
            }
          }
          signal?.throwIfAborted()
          const result = await this.rpc(
            {
              op: 'blob_http',
              lane,
              blobId,
              path,
              options: { ...wire, binary: undefined },
            },
            this.hostBudget.limits.httpMs +
              this.hostBudget.limits.guardianControlMs,
            true,
          )
          releaseBlob()
          return result
        } catch (error) {
          await this.rpc({ op: 'blob_release', lane, blobId }, undefined, true)
            .then(releaseBlob)
            .catch(() => {})
          throw error
        }
      } catch (error) {
        if (this.stopped || error instanceof KimiGuardianError) releaseBlob()
        throw error
      }
    }
    const isJson = !wire.raw
    let jsonMaximum =
      options.maxBytes ?? this.hostBudget.limits.httpControlBytes
    let releaseJson = () => {}
    if (isJson) {
      const bodyBytes =
        options.body === undefined
          ? 0
          : jsonBytes(
              options.body,
              this.hostBudget.limits,
              this.hostBudget.limits.httpControlBytes,
            )
      const available =
        this.hostBudget.limits.hostHttpBufferBytes -
        this.hostBudget.count('hostHttpBufferBytes')
      if (jsonMaximum < 1 || jsonMaximum * 3 + bodyBytes * 3 > available)
        throw new KimiError('kimi_http_buffer_limit')
      releaseJson = this.reserveOwned(
        'hostHttpBufferBytes',
        3 * jsonMaximum + 3 * bodyBytes,
      )
    }
    const releaseRemote = wire.raw
      ? this.reserveBlob(
          options.maxBytes ?? this.hostBudget.limits.attachmentBytes,
        )
      : () => {}
    let physical: Promise<unknown>
    try {
      physical = this.rpc(
        {
          op: isJson ? 'http_wire' : 'http',
          lane,
          path,
          options: isJson ? { ...wire, maxBytes: jsonMaximum } : wire,
        },
        this.hostBudget.limits.httpMs +
          this.hostBudget.limits.guardianControlMs,
      )
    } catch (error) {
      // Synchronous RPC admission refusal proves no IPC frame was queued.
      releaseRemote()
      releaseJson()
      throw error
    }
    let result: unknown
    try {
      result = await physical
    } catch (error) {
      if (this.stopped || error instanceof KimiGuardianError) {
        releaseRemote()
        releaseJson()
      }
      throw error
    }
    const response = object(result),
      blobId = boundedString(
        response.blobId,
        this.hostBudget.limits.forgeIdBytes,
      )
    let release = () => {},
      transferred = false,
      remoteReleased = false
    const releaseBlob = async () => {
      await this.rpc({ op: 'blob_release', lane, blobId })
      remoteReleased = true
      releaseRemote()
    }
    try {
      const expectedHash = boundedString(response.sha256, 64)
      if (!/^[a-f0-9]{64}$/.test(expectedHash))
        throw new KimiError('kimi_blob_digest')
      if (
        typeof response.sizeBytes !== 'number' ||
        !Number.isSafeInteger(response.sizeBytes) ||
        response.sizeBytes < 0 ||
        response.sizeBytes >
          (isJson
            ? jsonMaximum
            : (options.maxBytes ?? this.hostBudget.limits.attachmentBytes))
      )
        throw new KimiError('kimi_blob_limit')
      release = isJson
        ? () => {}
        : this.hostBudget.reserve('hostAttachmentBytes', response.sizeBytes)
      signal?.throwIfAborted()
      const bytes = Buffer.alloc(response.sizeBytes),
        hash = createHash('sha256')
      for (let offset = 0; offset < bytes.length;) {
        signal?.throwIfAborted()
        const part = object(
          await this.rpc({ op: 'blob_read', lane, blobId, offset }),
        )
        const encoded = boundedString(
          part.data,
          Math.ceil(this.hostBudget.limits.ipcMediaChunkBytes / 3) * 4,
        )
        const freeChunk = this.hostBudget.reserve(
          'hostIpcBytes',
          Math.ceil(encoded.length / 4) * 3 + encoded.length * 2,
        )
        try {
          const chunk = Buffer.from(encoded, 'base64')
          if (
            !chunk.length ||
            chunk.length > this.hostBudget.limits.ipcMediaChunkBytes ||
            offset + chunk.length > bytes.length ||
            chunk.toString('base64') !== encoded
          )
            throw new KimiError('kimi_blob_chunk')
          chunk.copy(bytes, offset)
          hash.update(chunk)
          offset += chunk.length
        } finally {
          freeChunk()
        }
      }
      if (hash.digest('hex') !== expectedHash)
        throw new KimiError('kimi_blob_digest')
      if (isJson) {
        // Only the parent parses JSON. Release the guardian buffer before decoding.
        await releaseBlob()
        const freeParsed = this.hostBudget.reserve(
          'hostRetainedBytes',
          bytes.length * 2,
        )
        try {
          return parseHttpEnvelope(
            bytes,
            response.status as number,
            boundedString(
              response.requestId,
              this.hostBudget.limits.controlIdBytes,
            ),
            path,
            { ...wire, maxBytes: jsonMaximum },
            this.hostBudget,
          )
        } catch (error) {
          if (
            options.method &&
            options.method !== 'GET' &&
            !(
              error instanceof KimiError &&
              error.code.startsWith('kimi_native_')
            )
          )
            throw new KimiError(
              'kimi_delivery_unknown',
              'Kimi mutation delivery is unknown',
              true,
            )
          throw error
        } finally {
          freeParsed()
        }
      }
      transferred = true
      return { bytes, release } satisfies KimiOwnedBytes
    } finally {
      if (!transferred) release()
      if (!remoteReleased) await releaseBlob().catch(() => {})
      if (remoteReleased || this.stopped) releaseJson()
    }
  }
  private reserveBlob(bytes: number) {
    return this.reserveOwned('hostAttachmentBytes', bytes)
  }
  private reserveOwned(
    key: 'hostAttachmentBytes' | 'hostHttpBufferBytes',
    bytes: number,
  ) {
    const free = this.hostBudget.reserve(key, bytes)
    const release = () => {
      free()
      this.blobReleases.delete(release)
    }
    this.blobReleases.add(release)
    return release
  }
  async openSocket(
    lane: string,
    id: string,
    frame: (frame: unknown) => void,
    failure: (error: Error) => void,
  ) {
    if (this.sockets.has(id)) throw new KimiError('kimi_socket_exists')
    const release = this.hostBudget.reserve('hostSockets')
    this.socketReleases.set(id, release)
    this.sockets.set(id, { frame, failure })
    try {
      await this.rpc({ op: 'socket_open', lane, socketId: id })
    } catch (error) {
      await this.closeSocket(id).catch(() => {})
      this.sockets.delete(id)
      throw error
    }
  }
  control(id: string, control: string, payload: unknown) {
    return this.rpc({ op: 'control', socketId: id, control, payload })
  }
  async closeSocket(id: string) {
    await this.rpc({ op: 'socket_close', socketId: id })
    this.sockets.delete(id)
    this.socketReleases.get(id)?.()
    this.socketReleases.delete(id)
  }
  async closeLane(lane: string) {
    await this.rpc({ op: 'lane_close', lane })
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closing = (async () => {
      if (this.stopped) {
        if (!this.cleanupProved)
          throw new KimiError(
            'kimi_home_cleanup_unproved',
            'Kimi home cleanup remains unproved',
            true,
          )
        return
      }
      // Request an explicit cleanup proof before channel closure. Parent death still uses EOF.
      void this.rpc(
        { op: 'close' },
        this.hostBudget.limits.shutdownMs * 3,
      ).catch(() => this.child.stdin.end())
      await deadline(
        this.done,
        this.hostBudget.limits.shutdownMs * 3,
        undefined,
        undefined,
        this.hostBudget,
      )
      await Promise.allSettled(this.transfers)
      this.ipc.close(new KimiError('kimi_server_closed'))
      if (!this.cleanupProved) throw new KimiError('kimi_home_cleanup_unproved')
    })()
    return this.closing
  }
}
