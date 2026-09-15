import { randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import {
  zCreateTerminalRequest,
  zTerminalOutputRequest,
  zWaitForTerminalExitRequest,
  zKillTerminalCommandRequest,
  zReleaseTerminalRequest,
} from '@agentclientprotocol/sdk/dist/schema/zod.gen.js'
import type { ConfirmedNativeBinding, HarnessSession } from '../types.js'
import type { JsonlRpcTransport, JsonRpcRequest } from '../jsonrpc.js'
import { startNativeProcess, type NativeProcess } from '../process.js'
import { byteTail } from '../diagnostics.js'
import {
  WorkspacePath,
  descriptorPath,
  identity,
  relativePath,
  type PathHooks,
} from '../../workspace/paths.js'
import { canonical, immutableData } from './data.js'
import type { AcpLiveOwner, AccountScope } from './ingestion.js'
import type { AcpResourceHost } from './limits.js'

const MiB = 1024 * 1024
const runtimeOwners = new WeakMap<AcpResourceHost, Set<string>>()
const methods = new Set([
  'terminal/create',
  'terminal/output',
  'terminal/wait_for_exit',
  'terminal/kill',
  'terminal/release',
])
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
type RecordOwner = {
  id: string
  owner: AcpLiveOwner
  scope: string
  process?: NativeProcess
  chain?: WorkspacePath
  chunks: string[]
  outputBytes: number
  readBytes: number
  truncated: boolean
  limit: number
  live: boolean
  released: boolean
  waiters: number
  failure?: Error
  exitStatus?: { exitCode: number | null; signal: string | null }
  exited: ReturnType<typeof deferred<void>>
  cleanup?: Promise<void>
  commandTimer?: ReturnType<typeof setTimeout>
  expiry?: ReturnType<typeof setTimeout>
  releaseProcess: () => void
  releaseOutput: () => void
}
type Operation = {
  controller: AbortController
  done: Promise<void>
  record?: RecordOwner
  replying: boolean
  releases: (() => void)[]
}

/** ACP tool processes are separate from Forge's interactive terminal sessions. */
export async function createAcpTerminals(options: {
  session: HarnessSession
  runtimeGeneration: string
  binding(): ConfirmedNativeBinding | null
  rpc: JsonlRpcTransport
  host: AcpResourceHost
  instanceId: string
  account: AccountScope
  approvedEnv: Readonly<Record<string, string | undefined>>
  hooks?: PathHooks
  requestDeadlineMs?: number
  commandDeadlineMs?: number
  expiryMs?: number
}) {
  const { rpc, host, instanceId, runtimeGeneration } = options
  const session = immutableData(options.session)
  const account = immutableData(options.account)
  const capturedBinding = options.binding
  const hooks = { ...options.hooks }
  const approvedEnv = immutableData(options.approvedEnv)
  const requestDeadline = options.requestDeadlineMs ?? 60_000
  const commandDeadline = options.commandDeadlineMs ?? 600_000
  const expiryMs = options.expiryMs ?? 60_000
  for (const [value, max] of [
    [requestDeadline, 60_000],
    [commandDeadline, 600_000],
    [expiryMs, 60_000],
  ])
    if (!Number.isSafeInteger(value) || value! < 1 || value! > max!)
      throw Error('Invalid ACP terminal deadline')
  if (!runtimeGeneration || session.provider !== instanceId)
    throw Error('Invalid ACP terminal authority')
  const owners = runtimeOwners.get(host) ?? new Set<string>()
  runtimeOwners.set(host, owners)
  const runtimeKey = canonical([instanceId, session.id, runtimeGeneration])
  if (owners.has(runtimeKey))
    throw Error('ACP terminal runtime is already owned')
  if (
    session.accountId
      ? account.kind !== 'selected-account' ||
        account.accountId !== session.accountId
      : account.kind !== 'native-default'
  )
    throw Error('Invalid ACP terminal account')
  const releaseRegistry = host.reserve(instanceId, 'retained', 4 * MiB)
  owners.add(runtimeKey)
  let ownsRuntime = true
  const releaseRuntime = () => {
    if (!ownsRuntime) return
    ownsRuntime = false
    owners.delete(runtimeKey)
    releaseRegistry()
  }
  let releaseSetup: () => void
  try {
    releaseSetup = host.reserve(instanceId, 'handlers')
  } catch (error) {
    releaseRuntime()
    throw error
  }
  let startupFailed = false
  const initialized = deferred<{ root: string; expected: string }>()
  const timer = setTimeout(() => {
    startupFailed = true
    initialized.reject(Error('ACP terminal startup deadline'))
  }, requestDeadline)
  void Promise.resolve()
    .then(async () => {
      const root = await realpath(session.cwd)
      if (root !== session.cwd)
        throw Error('ACP terminal requires canonical workspace')
      const info = await lstat(root, { bigint: true })
      if (!info.isDirectory())
        throw Error('ACP terminal requires workspace directory')
      initialized.resolve({ root, expected: identity(info) })
    })
    .catch((error) => {
      startupFailed = true
      initialized.reject(error)
    })
    .finally(() => {
      clearTimeout(timer)
      releaseSetup()
      if (startupFailed) releaseRuntime()
    })
  const { root, expected } = await initialized.promise
  const records = new Map<string, RecordOwner>()
  const retired = new Map<string, string>()
  const operations = new Set<Operation>()
  let metadataBytes = 0
  let live = 0,
    retained = 0,
    waiters = 0,
    closed = false
  let closing: Promise<void> | undefined

  function scope(owner: AcpLiveOwner) {
    return canonical({
      sessionId: owner.sessionId,
      providerInstanceId: owner.providerInstanceId,
      account: owner.account,
      runtimeGeneration: owner.runtimeGeneration,
      binding: owner.binding,
    })
  }
  function retire(record: RecordOwner) {
    if (record.released) return
    record.released = true
    clearTimeout(record.expiry)
    clearTimeout(record.commandTimer)
    record.chunks = []
    record.outputBytes = 0
    record.releaseOutput()
    retained -= record.limit
    records.delete(record.id)
    retired.set(record.id, record.scope)
  }
  function cleanup(record: RecordOwner): Promise<void> {
    if (record.cleanup) return record.cleanup
    record.cleanup = Promise.resolve()
      .then(async () => {
        clearTimeout(record.commandTimer)
        await record.process?.close(Error('ACP tool terminal stopped'))
        await record.chain?.close()
        record.chain = undefined
        if (record.live) {
          record.live = false
          live--
          record.releaseProcess()
        }
        record.exited.resolve()
      })
      .finally(() => {
        record.cleanup = undefined
      })
    return record.cleanup
  }
  async function release(record: RecordOwner) {
    await cleanup(record)
    retire(record)
  }
  function captureOutput(record: RecordOwner, runtime: NativeProcess) {
    const stdout = new StringDecoder('utf8'),
      stderr = new StringDecoder('utf8')
    const done = deferred<Error>()
    let finished = false
    const append = (text: string) => {
      if (!text) return
      const last = record.chunks.length - 1
      if (
        last >= 0 &&
        Buffer.byteLength(record.chunks[last]!) + Buffer.byteLength(text) <=
          4096
      )
        record.chunks[last] += text
      else record.chunks.push(text)
      record.outputBytes += Buffer.byteLength(text)
      if (record.outputBytes > record.limit) record.truncated = true
      while (record.outputBytes > record.limit) {
        const first = record.chunks[0]!
        const bytes = Buffer.byteLength(first)
        const excess = record.outputBytes - record.limit
        if (bytes <= excess) {
          record.chunks.shift()
          record.outputBytes -= bytes
        } else {
          const tail = byteTail(first, bytes - excess)
          record.chunks[0] = tail
          record.outputBytes -= bytes - Buffer.byteLength(tail)
        }
      }
    }
    const consume = (decoder: StringDecoder, chunk: Buffer) => {
      if (finished) return
      record.readBytes += chunk.length
      if (record.readBytes > 32 * MiB) {
        record.truncated = true
        record.failure = Error('ACP terminal read limit')
        finish(record.failure)
        void cleanup(record).catch(() => {})
        return
      }
      for (let offset = 0; offset < chunk.length; offset += 4096)
        append(decoder.write(chunk.subarray(offset, offset + 4096)))
    }
    const out = (chunk: Buffer) => consume(stdout, chunk)
    const err = (chunk: Buffer) => consume(stderr, chunk)
    const finish = (reason: Error) => {
      if (finished) return
      finished = true
      append(stdout.end())
      append(stderr.end())
      runtime.child.stdout.off('data', out)
      runtime.child.stderr.off('data', err)
      done.resolve(reason)
    }
    runtime.child.stdout.on('data', out)
    runtime.child.stderr.on('data', err)
    runtime.child.once('exit', (exitCode, signal) => {
      record.exitStatus = { exitCode, signal }
    })
    runtime.ownTransport({ done: done.promise, close: finish })
    void runtime.done
      .then(async () => {
        await cleanup(record)
        if (!record.released) {
          record.expiry = setTimeout(() => {
            void release(record).catch(() => {})
          }, expiryMs)
        }
      })
      .catch(() => {})
  }
  async function create(
    operation: Operation,
    owner: AcpLiveOwner,
    params: unknown,
  ) {
    const input = zCreateTerminalRequest.parse(params)
    if (input.sessionId !== owner.binding.providerSessionId)
      throw Error('ACP native session mismatch')
    if (
      !input.command ||
      input.command.includes('\0') ||
      input.args?.some((arg) => arg.includes('\0'))
    )
      throw Error('Invalid ACP terminal command')
    if (input._meta && Object.keys(input._meta).length)
      throw Error('ACP terminal restrictions are unsupported')
    const requested = input.outputByteLimit ?? MiB
    if (!Number.isSafeInteger(requested) || requested < 0)
      throw Error('Invalid ACP terminal output limit')
    const limit = Math.min(requested, MiB)
    if (
      live >= 4 ||
      records.size >= 32 ||
      retired.size + records.size >= 4096 ||
      retained + limit > 4 * MiB
    )
      throw Error('ACP terminal capacity')
    const metadataCharge = 4 * Buffer.byteLength(canonical(owner)) + 1024
    if (metadataBytes + metadataCharge > 4 * MiB)
      throw Error('ACP terminal metadata capacity')
    const releases: (() => void)[] = []
    let releaseOutput: () => void
    try {
      releases.push(host.reserve(instanceId, 'terminals'))
      releases.push(host.reserve(instanceId, 'processes'))
      releases.push(host.reserve(instanceId, 'descriptors', 33))
      releaseOutput = host.reserve(instanceId, 'retained', 6 * limit + 65536)
    } catch (error) {
      releases.forEach((end) => end())
      throw error
    }
    const record: RecordOwner = {
      id: randomUUID(),
      owner,
      scope: scope(owner),
      chunks: [],
      outputBytes: 0,
      readBytes: 0,
      truncated: false,
      limit,
      live: true,
      released: false,
      waiters: 0,
      exited: deferred<void>(),
      releaseProcess: () => releases.forEach((end) => end()),
      releaseOutput,
    }
    metadataBytes += metadataCharge
    live++
    retained += limit
    records.set(record.id, record)
    operation.record = record
    const cwd = input.cwd ?? root
    const rel = isAbsolute(cwd) ? relative(root, cwd) : cwd
    if (Buffer.byteLength(rel) > 4096 || rel.split('/').length > 32)
      throw Error('ACP terminal cwd limit')
    relativePath(rel, true)
    const env = { ...approvedEnv }
    for (const entry of input.env ?? []) {
      if (
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.name) ||
        entry.value.includes('\0')
      )
        throw Error('Invalid ACP terminal environment')
      env[entry.name] = entry.value
    }
    await WorkspacePath.open(
      root,
      expected,
      rel,
      true,
      operation.controller.signal,
      {
        ...hooks,
        onCreated(chain) {
          record.chain = chain
          hooks.onCreated?.(chain)
        },
      },
    )
    operation.controller.signal.throwIfAborted()
    await record.chain!.verify()
    operation.controller.signal.throwIfAborted()
    await startNativeProcess(
      {
        command: input.command,
        args: input.args ?? [],
        cwd: descriptorPath(record.chain!.parent),
        env,
        inheritEnv: false,
        signal: operation.controller.signal,
        stderrLimit: 1024,
        onCreated(runtime) {
          record.process = runtime
          captureOutput(record, runtime)
        },
      },
      async () => {},
    )
    operation.controller.signal.throwIfAborted()
    if (record.live)
      record.commandTimer = setTimeout(() => {
        void cleanup(record).catch(() => {})
      }, commandDeadline)
    return { terminalId: record.id }
  }
  async function execute(
    operation: Operation,
    owner: AcpLiveOwner,
    method: string,
    params: unknown,
  ) {
    if (method === 'terminal/create') return create(operation, owner, params)
    const input = (
      method === 'terminal/output'
        ? zTerminalOutputRequest
        : method === 'terminal/wait_for_exit'
          ? zWaitForTerminalExitRequest
          : method === 'terminal/kill'
            ? zKillTerminalCommandRequest
            : zReleaseTerminalRequest
    ).parse(params)
    if (input.sessionId !== owner.binding.providerSessionId)
      throw Error('ACP native session mismatch')
    const record = records.get(input.terminalId)
    if (!record) {
      if (
        (method === 'terminal/kill' || method === 'terminal/release') &&
        retired.get(input.terminalId) === scope(owner)
      )
        return {}
      throw Error('ACP terminal ID is stale')
    }
    if (record.scope !== scope(owner))
      throw Error('ACP terminal owner mismatch')
    if (method === 'terminal/output') {
      if (record.failure) throw record.failure
      operation.releases.push(
        host.reserve(instanceId, 'retained', 20 * record.outputBytes),
      )
      return {
        output: record.chunks.join(''),
        truncated: record.truncated,
        ...(record.exitStatus ? { exitStatus: record.exitStatus } : {}),
      }
    }
    if (method === 'terminal/kill') {
      await cleanup(record)
      return {}
    }
    if (method === 'terminal/release') {
      await release(record)
      return {}
    }
    if (record.waiters >= 4 || waiters >= 16)
      throw Error('ACP terminal waiter limit')
    record.waiters++
    waiters++
    try {
      const cancelled = deferred<never>()
      const abort = () => cancelled.reject(Error('ACP terminal wait cancelled'))
      operation.controller.signal.addEventListener('abort', abort, {
        once: true,
      })
      try {
        operation.controller.signal.throwIfAborted()
        await Promise.race([record.exited.promise, cancelled.promise])
        if (record.failure) throw record.failure
        return record.exitStatus ?? { exitCode: null, signal: null }
      } finally {
        operation.controller.signal.removeEventListener('abort', abort)
      }
    } finally {
      record.waiters--
      waiters--
    }
  }
  async function receive(
    original: JsonRpcRequest,
    inputOwner: AcpLiveOwner,
  ): Promise<boolean> {
    if (!methods.has(original.method)) return false
    let operation: Operation | undefined
    let releaseHandler: (() => void) | undefined
    let releaseReply: (() => void) | undefined
    try {
      if (closed || !rpc.isLiveRequest(original) || operations.size >= 16)
        throw Error('ACP terminal request is retired or full')
      releaseReply = host.reserve(instanceId, 'retained', 4 * MiB)
      const owner = immutableData(inputOwner, 16384),
        binding = immutableData(capturedBinding())
      if (
        !binding ||
        owner.phase !== 'live' ||
        canonical(owner.account) !== canonical(account) ||
        original.runtimeGeneration !== runtimeGeneration ||
        owner.runtimeGeneration !== runtimeGeneration ||
        owner.sessionId !== session.id ||
        owner.providerInstanceId !== instanceId ||
        canonical(owner.binding) !== canonical(binding) ||
        binding.provider !== instanceId ||
        binding.accountId !== (session.accountId ?? null) ||
        binding.cwd !== root
      )
        throw Error('ACP terminal owner mismatch')
      const params = immutableData(original.params, 65536)
      releaseHandler = host.reserve(instanceId, 'handlers')
      const settled = deferred<void>(),
        logical = deferred<unknown>()
      operation = {
        controller: new AbortController(),
        done: settled.promise,
        replying: false,
        releases: [],
      }
      const current = operation
      operations.add(current)
      const abort = () => {
        if (!current.replying) current.controller.abort()
      }
      const stop = () => logical.reject(Error('ACP terminal request cancelled'))
      original.signal.addEventListener('abort', abort, { once: true })
      current.controller.signal.addEventListener('abort', stop, { once: true })
      const timer = setTimeout(
        () => current.controller.abort(),
        requestDeadline,
      )
      const work = Promise.resolve().then(() => {
        current.controller.signal.throwIfAborted()
        return execute(current, owner, original.method, params)
      })
      void work.then(logical.resolve, logical.reject)
      if (original.signal.aborted) abort()
      let successful = false
      try {
        let result: unknown, failure: unknown
        try {
          result = await logical.promise
        } catch (error) {
          failure = error
        }
        current.replying = true
        clearTimeout(timer)
        const submission = failure
          ? rpc.respondErrorWithSubmission(
              original,
              -32603,
              failure instanceof Error &&
                failure.message === 'ACP terminal read limit'
                ? failure.message
                : 'ACP terminal operation failed',
            )
          : rpc.respondWithSubmission(original, result)
        const [logicalResult, physical] = await Promise.allSettled([
          submission.logical,
          submission.submission,
        ])
        successful =
          !failure &&
          logicalResult.status === 'fulfilled' &&
          physical.status === 'fulfilled' &&
          physical.value.status === 'written'
        if (logicalResult.status === 'rejected') throw logicalResult.reason
        if (physical.status === 'rejected') throw physical.reason
      } finally {
        clearTimeout(timer)
        original.signal.removeEventListener('abort', abort)
        current.controller.signal.removeEventListener('abort', stop)
        try {
          await work.catch(() => {})
          if (current.record && !successful) await release(current.record)
        } finally {
          settled.resolve()
        }
      }
      return true
    } catch (error) {
      if (operation) throw error
      const response = rpc.respondErrorWithSubmission(
        original,
        -32603,
        'ACP terminal request rejected',
      )
      await Promise.all([response.logical, response.submission])
      return true
    } finally {
      if (operation) {
        operations.delete(operation)
        operation.releases.forEach((end) => end())
      }
      releaseHandler?.()
      releaseReply?.()
    }
  }
  function close(): Promise<void> {
    closed = true
    if (closing) return closing
    closing = Promise.resolve()
      .then(async () => {
        for (const operation of operations) operation.controller.abort()
        await Promise.all([...operations].map((operation) => operation.done))
        const results = await Promise.allSettled(
          [...records.values()].map(release),
        )
        const failed = results.find((result) => result.status === 'rejected')
        if (failed?.status === 'rejected') throw failed.reason
        retired.clear()
        releaseRuntime()
      })
      .finally(() => {
        closing = undefined
      })
    return closing
  }
  return { receive, close }
}
