import { createServer } from 'node:net'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { JsonlTransport } from '../jsonl.js'
import { startNativeProcess, type NativeProcess } from '../process.js'
import { groupHasRunningMember } from '../process-group.js'
import {
  captureAuthority,
  effectiveAuthority,
  assertIdentity,
  type EffectiveAuthority,
} from './authority.js'
import {
  KimiBudget,
  KimiError,
  kimiLimits,
  jsonBytes,
  boundedString,
  type KimiLimits,
} from './limits.js'
import {
  KimiHomeLock,
  ensureToken,
  assertToken,
  type KimiToken,
} from './lock.js'
import { ownedListener } from './listener.js'
import {
  KimiHttpClient,
  KimiSocket,
  object,
  type HttpOptions,
  type KimiOwnedBytes,
} from './transport.js'
import { validateStartup } from './wire.js'
import type { KimiLaunchAuthority } from './types.js'

class GuardianReply {
  constructor(
    readonly value: unknown,
    readonly release: () => void,
  ) {}
}

async function reservePort() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new KimiError('kimi_port_unavailable')
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  return address.port
}

/** The guardian is outside the native group. NativeProcess remains the sole native supervisor. */
export async function runKimiGuardian(
  runtimeParent?: string,
  selectedLimits: Partial<KimiLimits> = {},
) {
  const limits = kimiLimits(selectedLimits),
    budget = new KimiBudget(limits)
  // The shared supervisor uses at most three concurrent timers. Lock/listener work
  // and the cleanup-failure hold each have one fixed timer. These slots remain owned
  // until this guardian ends, including an unproved native cleanup.
  const releaseHelperTimers = budget.reserve('hostTimers', 5)
  let authority: EffectiveAuthority | undefined,
    lock: KimiHomeLock | undefined,
    native: NativeProcess | undefined
  let token: KimiToken | undefined,
    port = 0,
    initialized = false,
    closing: Promise<void> | undefined
  let initialization: Promise<unknown> | undefined
  const stopping = new AbortController()
  let nativeCleanupProved = true
  let phase = 'authority'
  const clients = new Map<string, KimiHttpClient>(),
    sockets = new Map<string, KimiSocket>()
  const generations = new Map<string, KimiBudget>(),
    tasks = new Set<Promise<unknown>>()
  const stateReleases = new Map<string, () => void>()
  const socketBudgets = new Map<string, KimiBudget>()
  const blobs = new Map<
    string,
    {
      lane: string
      bytes: Buffer
      offset: number
      release: () => void
      busy?: Promise<unknown>
    }
  >()
  let ipc: JsonlTransport
  const send = async (value: unknown, owner = budget) => {
    const bytes = jsonBytes(value, limits, limits.ipcMessageBytes)
    owner.add('ipcFrames')
    owner.add('ipcTotalBytes', bytes)
    await ipc.send(value, {
      deadline: performance.now() + limits.guardianControlMs,
    })
  }
  const shutdown = () => {
    if (closing) return closing
    stopping.abort()
    closing = (async () => {
      await initialization?.catch(() => {})
      await Promise.allSettled(
        [...sockets.values()].map((socket) => socket.close()),
      )
      await Promise.allSettled(
        [...clients.values()].map((client) => client.close()),
      )
      for (const blob of blobs.values()) blob.release()
      blobs.clear()
      let proved = !native && nativeCleanupProved
      if (native) {
        try {
          await native.close()
          proved = true
        } catch {
          if (native.child.pid)
            proved = !(await groupHasRunningMember(
              native.child.pid,
              performance.now() + limits.shutdownMs,
            ))
        }
      }
      // A starting marker remains dirty if spawn might have happened without recorded identity.
      if (lock) await lock.release(proved)
      for (const release of stateReleases.values()) release()
      stateReleases.clear()
      await send({ type: 'cleanup_proved' }).catch(() => {})
      ipc.close(new KimiError('kimi_guardian_closed'))
    })()
    return closing
  }
  const fatal = () => {
    void shutdown()
      .then(() => {
        process.exitCode = 0
      })
      .catch(() => {
        // Keep the lock and process alive on unproved cleanup. A successor must not overlap it.
        process.exitCode = 1
        const hold = setInterval(() => {}, 60_000)
        void hold
      })
  }
  const lane = (id: unknown) => {
    const key = boundedString(id, limits.forgeIdBytes)
    let current = generations.get(key)
    if (!current) {
      if (generations.size >= limits.hostSessions)
        throw new KimiError('kimi_session_limit')
      const release = budget.reserve(
        'hostRetainedBytes',
        Buffer.byteLength(key) + 128,
      )
      current = new KimiBudget(limits)
      generations.set(key, current)
      stateReleases.set(`lane:${key}`, release)
    }
    return { key, budget: current }
  }
  const client = (id: unknown) => {
    if (!initialized || !authority || !token || closing)
      throw new KimiError('kimi_guardian_not_ready')
    const owner = lane(id)
    let current = clients.get(owner.key)
    if (!current) {
      current = new KimiHttpClient(
        port,
        token.value,
        budget,
        owner.budget,
        () => assertToken(authority!.home, token!, limits),
      )
      clients.set(owner.key, current)
    }
    return current
  }
  const dispatch = async (message: Record<string, unknown>) => {
    const op = boundedString(message.op, 128)
    if (op === 'initialize') {
      if (Number(process.versions.node.split('.')[0]) !== 24)
        throw new KimiError('kimi_node_version')
      if (authority || closing)
        throw new KimiError('kimi_guardian_already_started')
      const requested = kimiLimits(
        object(message.limits) as Partial<KimiLimits>,
      )
      if (JSON.stringify(requested) !== JSON.stringify(limits))
        throw new KimiError('kimi_guardian_limits_changed')
      const selected = object(
        message.authority,
      ) as unknown as KimiLaunchAuthority
      stateReleases.set(
        'authority',
        budget.reserve(
          'hostRetainedBytes',
          jsonBytes(selected, limits, limits.stateReadBytes) * 4,
        ),
      )
      if (
        !Array.isArray(message.removals) ||
        message.removals.length > limits.jsonNodes
      )
        throw new KimiError('kimi_invalid_environment')
      const environment = { ...selected.environment }
      for (const key of message.removals)
        environment[boundedString(key, limits.nativeIdBytes)] = undefined
      authority = await effectiveAuthority(
        captureAuthority({ ...selected, environment }, limits),
      )
      stopping.signal.throwIfAborted()
      phase = 'lock'
      lock = await KimiHomeLock.acquire(authority.home, limits, runtimeParent)
      stopping.signal.throwIfAborted()
      phase = 'token'
      token = await ensureToken(authority.home, limits)
      stopping.signal.throwIfAborted()
      const startup = new KimiBudget(limits),
        end = performance.now() + limits.startupMs
      let last: unknown
      for (let attempt = 0; attempt < limits.startupAttempts; attempt++) {
        try {
          if (closing || performance.now() >= end)
            throw new KimiError('kimi_startup_timeout')
          port = await reservePort()
          await lock.starting()
          await assertIdentity(authority.executable)
          stopping.signal.throwIfAborted()
          phase = 'spawn'
          nativeCleanupProved = false
          const launched = await startNativeProcess(
            {
              command: authority.executable.path,
              signal: stopping.signal,
              args: [
                'web',
                '--no-open',
                '--host',
                '127.0.0.1',
                '--port',
                String(port),
              ],
              cwd: authority.bootstrapCwd,
              env: { ...authority.environment },
              secrets: [
                token.value,
                ...Object.entries(authority.environment)
                  .filter(([key]) => /KEY|TOKEN|SECRET|PASSWORD/.test(key))
                  .flatMap(([, value]) => (value ? [value] : [])),
              ],
              stderrLimit: limits.stderrTailBytes,
              startupTimeoutMs: Math.max(
                1,
                Math.floor(end - performance.now()),
              ),
              killGraceMs: Math.min(500, limits.shutdownMs),
              cleanupTimeoutMs: limits.shutdownMs,
            },
            async (processOwner) => {
              try {
                native = processOwner
                let stdout = 0,
                  stderr = 0
                processOwner.child.stdout.on('data', (chunk: Buffer) => {
                  stdout += chunk.length
                  if (stdout > limits.stdoutBytes)
                    void processOwner
                      .close(new KimiError('kimi_stdout_limit'))
                      .catch(() => {})
                })
                processOwner.child.stderr.on('data', (chunk: Buffer) => {
                  stderr += chunk.length
                  if (stderr > limits.stderrBytes)
                    void processOwner
                      .close(new KimiError('kimi_stderr_limit'))
                      .catch(() => {})
                })
                await lock!.active(processOwner.child.pid!)
                phase = 'listener'
                while (
                  !(await ownedListener(port, processOwner.child.pid!, end))
                ) {
                  processOwner.signal.throwIfAborted()
                  if (performance.now() >= end)
                    throw new KimiError('kimi_startup_timeout')
                  await delay(
                    Math.min(20, end - performance.now()),
                    undefined,
                    { signal: processOwner.signal },
                  )
                }
                const http = new KimiHttpClient(
                  port,
                  token!.value,
                  budget,
                  startup,
                  () => assertToken(authority!.home, token!, limits),
                )
                const read = async (path: string) => {
                  startup.add('startupReads')
                  const before = startup.count('httpResponseBytesPerGeneration')
                  const remaining = Math.min(
                    limits.httpJsonBytes,
                    limits.startupBytes - startup.count('startupBytes'),
                  )
                  if (remaining < 1) throw new KimiError('kimi_startup_bytes')
                  const result =
                    path === '/openapi.json' || path === '/asyncapi.json'
                      ? await http.startupSchema(
                          path,
                          processOwner.signal,
                          remaining,
                        )
                      : await http.call(path, {
                          maxBytes: remaining,
                          signal: processOwner.signal,
                        })
                  startup.add(
                    'startupBytes',
                    startup.count('httpResponseBytesPerGeneration') - before,
                  )
                  return result
                }
                try {
                  phase = 'health'
                  await read('/healthz')
                  phase = 'schema'
                  const meta = await read('/api/v1/meta'),
                    openapi = await read('/openapi.json'),
                    asyncapi = await read('/asyncapi.json')
                  validateStartup(meta, openapi, asyncapi)
                  await lock!.validate()
                  await assertToken(authority!.home, token!, limits)
                  return meta
                } finally {
                  await http.close()
                }
              } catch (error) {
                last = error
                throw error
              }
            },
          )
          native = launched.process
          native.ownTransport({
            done: ipc.done,
            close: () => {
              void shutdown().catch(() => {})
            },
          })
          initialized = true
          void native.done.then(() => {
            if (closing) return
            void send({
              type: 'server_failed',
              code: 'kimi_native_process_ended',
            }).catch(() => {})
            fatal()
          })
          return { version: '0.34.0' }
        } catch (error) {
          const original = last ?? error
          if (native) {
            await native.close()
            nativeCleanupProved = true
            native = undefined
          }
          // Retry only a proved port collision. Schema/auth/identity failures remain failures.
          if (!(
            original instanceof KimiError &&
            original.code === 'kimi_foreign_listener'
          ))
            throw original
        }
      }
      throw last ?? new KimiError('kimi_startup_failed')
    }
    if (op === 'close') {
      await shutdown()
      return {}
    }
    if (op === 'http' || op === 'http_wire') {
      const http = client(message.lane)
      const options = object(message.options) as HttpOptions
      const path = boundedString(message.path, limits.cursorBytes * 4)
      const result =
        op === 'http_wire'
          ? await http.wire(path, options)
          : await http.call(path, options)
      if (options.raw || op === 'http_wire') {
        const owned = result as KimiOwnedBytes,
          bytes = Buffer.from(
            owned.bytes.buffer,
            owned.bytes.byteOffset,
            owned.bytes.byteLength,
          ),
          id = boundedString(message.id, limits.controlIdBytes)
        let releaseBytes: () => void
        try {
          releaseBytes =
            op === 'http_wire'
              ? () => {}
              : budget.reserve('hostAttachmentBytes', bytes.length)
        } catch (error) {
          owned.release()
          throw error
        }
        const release = () => {
          releaseBytes()
          owned.release()
        }
        blobs.set(id, {
          lane: boundedString(message.lane, limits.forgeIdBytes),
          bytes,
          offset: bytes.length,
          release,
        })
        return {
          blobId: id,
          sizeBytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          ...(op === 'http_wire'
            ? {
                status: (result as { status: number }).status,
                requestId: (result as { requestId: string }).requestId,
              }
            : {}),
        }
      }
      return result
    }
    if (op === 'blob_begin') {
      client(message.lane)
      const id = boundedString(message.blobId, limits.forgeIdBytes),
        size = message.sizeBytes
      if (
        typeof size !== 'number' ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        size > limits.promptAttachmentBytes ||
        blobs.has(id)
      )
        throw new KimiError('kimi_blob_limit')
      const release = budget.reserve('hostAttachmentBytes', size)
      blobs.set(id, {
        lane: boundedString(message.lane, limits.forgeIdBytes),
        bytes: Buffer.alloc(size),
        offset: 0,
        release,
      })
      return {}
    }
    if (op.startsWith('blob_')) {
      const id = boundedString(message.blobId, limits.forgeIdBytes),
        blob = blobs.get(id)
      if (!blob || blob.lane !== message.lane)
        throw new KimiError('kimi_blob_owner')
      if (op === 'blob_chunk') {
        if (blob.busy) throw new KimiError('kimi_blob_busy')
        const encoded = boundedString(
          message.data,
          Math.ceil(limits.ipcMediaChunkBytes / 3) * 4,
          true,
        )
        const releaseChunk = budget.reserve(
          'hostIpcBytes',
          Math.ceil(encoded.length / 4) * 3 + encoded.length * 2,
        )
        try {
          const bytes = Buffer.from(encoded, 'base64')
          if (
            bytes.toString('base64') !== encoded ||
            bytes.length > limits.ipcMediaChunkBytes ||
            message.offset !== blob.offset ||
            blob.offset + bytes.length > blob.bytes.length
          )
            throw new KimiError('kimi_blob_chunk')
          bytes.copy(blob.bytes, blob.offset)
          blob.offset += bytes.length
          return {}
        } finally {
          releaseChunk()
        }
      }
      if (op === 'blob_read') {
        if (
          typeof message.offset !== 'number' ||
          !Number.isSafeInteger(message.offset) ||
          message.offset < 0 ||
          message.offset >= blob.bytes.length
        )
          throw new KimiError('kimi_blob_offset')
        const size = Math.min(
          blob.bytes.length - message.offset,
          limits.ipcMediaChunkBytes,
        )
        const release = budget.reserve('hostIpcBytes', Math.ceil(size / 3) * 8)
        try {
          return new GuardianReply(
            {
              data: blob.bytes
                .subarray(
                  message.offset,
                  message.offset + limits.ipcMediaChunkBytes,
                )
                .toString('base64'),
            },
            release,
          )
        } catch (error) {
          release()
          throw error
        }
      }
      if (op === 'blob_release') {
        if (blob.busy) {
          await blob.busy.catch(() => {})
          return {}
        }
        blob.release()
        blobs.delete(id)
        return {}
      }
      if (op === 'blob_http') {
        if (blob.busy) throw new KimiError('kimi_blob_busy')
        if (blob.offset !== blob.bytes.length)
          throw new KimiError('kimi_blob_incomplete')
        try {
          blob.busy = client(message.lane).call(
            boundedString(message.path, limits.cursorBytes * 4),
            { ...object(message.options), binary: blob.bytes },
          )
          return await blob.busy
        } finally {
          blob.release()
          blobs.delete(id)
        }
      }
    }
    if (op === 'socket_open') {
      client(message.lane)
      const owner = lane(message.lane),
        id = boundedString(message.socketId, limits.forgeIdBytes)
      if (sockets.has(id)) throw new KimiError('kimi_socket_exists')
      const socket = new KimiSocket(
        port,
        token!.value,
        budget,
        owner.budget,
        (frame) => {
          return send(
            { type: 'frame', socketId: id, frame },
            owner.budget,
          ).catch(() => {
            void socket.close()
            void send({
              type: 'socket_failed',
              socketId: id,
              code: 'kimi_ipc_limit',
            }).catch(fatal)
          })
        },
        () => {
          void send({
            type: 'socket_failed',
            socketId: id,
            code: 'kimi_socket_failed',
          }).catch(fatal)
        },
      )
      sockets.set(id, socket)
      socketBudgets.set(id, owner.budget)
      await socket.ready
      await socket.control('client_hello', { client_id: 'forge' })
      return {}
    }
    if (op === 'control') {
      const id = boundedString(message.socketId, limits.forgeIdBytes)
      const socket = sockets.get(id)
      if (!socket) throw new KimiError('kimi_socket_missing')
      return socket.control(
        boundedString(message.control, 128),
        message.payload,
      )
    }
    if (op === 'socket_close') {
      const id = boundedString(message.socketId, limits.forgeIdBytes)
      await sockets.get(id)?.close()
      sockets.delete(id)
      socketBudgets.delete(id)
      return {}
    }
    if (op === 'lane_close') {
      const id = boundedString(message.lane, limits.forgeIdBytes)
      await clients.get(id)?.close()
      clients.delete(id)
      generations.delete(id)
      stateReleases.get(`lane:${id}`)?.()
      stateReleases.delete(`lane:${id}`)
      return {}
    }
    throw new KimiError('kimi_unknown_guardian_command')
  }
  ipc = new JsonlTransport({
    stdin: process.stdout,
    stdout: process.stdin,
    maxLineBytes: limits.ipcMessageBytes,
    maxQueuedBytes: limits.ipcBufferedBytes,
    maxQueuedFrames: limits.replayFrames,
    resources: {
      measureOutgoing: (value) =>
        jsonBytes(value, limits, limits.ipcMessageBytes),
      reserve: (_kind, bytes) => budget.reserve('hostIpcBytes', bytes),
    },
    validateOutgoing: (value) => {
      jsonBytes(value, limits, limits.ipcMessageBytes)
    },
    onValue: (value, bytes, ownership) => {
      let id: string | undefined
      try {
        const message = object(value)
        id = boundedString(message.id, limits.controlIdBytes)
        const owner = [
          'close',
          'socket_close',
          'lane_close',
          'blob_release',
        ].includes(String(message.op))
          ? budget
          : message.lane !== undefined
            ? lane(message.lane).budget
            : typeof message.socketId === 'string'
              ? (socketBudgets.get(message.socketId) ?? budget)
              : budget
        owner.add('ipcFrames')
        owner.add('ipcTotalBytes', bytes)
        if (
          tasks.size >=
          limits.hostHttp + limits.hostSockets + limits.pendingControls
        )
          throw new KimiError('kimi_ipc_capacity')
        const releaseValue = ownership!.retain()
        const work = dispatch(message)
        if (message.op === 'initialize') initialization = work
        const task = work
          .then(
            async (data) => {
              try {
                await send(
                  {
                    type: 'result',
                    id,
                    data: data instanceof GuardianReply ? data.value : data,
                  },
                  owner,
                ).catch(() =>
                  send({
                    type: 'error',
                    id,
                    code: 'kimi_ipc_limit',
                    uncertain: true,
                  }),
                )
              } finally {
                if (data instanceof GuardianReply) data.release()
              }
            },
            async (error) => {
              const systemCode = (error as NodeJS.ErrnoException)?.code
              const safeCode =
                typeof systemCode === 'string' && /^E[A-Z]+$/.test(systemCode)
                  ? systemCode
                  : 'failed'
              await send({
                type: 'error',
                id,
                code:
                  error instanceof KimiError
                    ? error.code
                    : `kimi_guardian_${phase}_${safeCode}`,
                uncertain: error instanceof KimiError && error.uncertain,
              })
              if (!initialized) fatal()
            },
          )
          .then(async () => {
            // The response is physically written before the parent releases its
            // reservation for this guardian's HTTP buffers and parsed result.
            if (
              ['initialize', 'http', 'http_wire', 'blob_http'].includes(
                String(message.op),
              )
            )
              await send({ type: 'http_released', id })
          })
          .catch(fatal)
        tasks.add(task)
        void task.finally(() => {
          tasks.delete(task)
          releaseValue()
        })
      } catch (error) {
        if (initialized && id && error instanceof KimiError)
          void send({
            type: 'error',
            id,
            code: error.code,
            uncertain: false,
          }).catch(fatal)
        else fatal()
      }
    },
  })
  const terminate = () => fatal()
  process.on('SIGTERM', terminate)
  process.on('SIGINT', terminate)
  void ipc.done.then(fatal)
  await ipc.done
  await closing
  releaseHelperTimers()
  process.off('SIGTERM', terminate)
  process.off('SIGINT', terminate)
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void runKimiGuardian(
    undefined,
    process.argv[2] ? JSON.parse(process.argv[2]) : {},
  ).catch(() => {
    process.exitCode = 1
  })
}
