import { constants } from 'node:fs'
import {
  lstat,
  open,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isAbsolute, relative } from 'node:path'
import {
  zReadTextFileRequest,
  zWriteTextFileRequest,
} from '@agentclientprotocol/sdk/dist/schema/zod.gen.js'
import type { ConfirmedNativeBinding, HarnessSession } from '../types.js'
import type { JsonlRpcTransport, JsonRpcRequest } from '../jsonrpc.js'
import {
  WorkspacePath,
  descriptorPath,
  fileRevision,
  identity,
  relativePath,
  type PathHooks,
} from '../../workspace/paths.js'
import { readBounded } from '../../workspace/files.js'
import { immutableData, canonical } from './data.js'
import type { AcpLiveOwner } from './ingestion.js'
import type { AcpResourceHost } from './limits.js'

const MiB = 1024 * 1024
type Hooks = PathHooks & {
  beforeRead?: (handle: FileHandle) => Promise<void>
  beforePublish?: () => Promise<void>
  rename?: typeof rename
}
type Temporary = { path: string; handle: FileHandle; expected: Buffer }
type Operation = {
  controller: AbortController
  handles: Set<FileHandle>
  chains: Set<WorkspacePath>
  temporary?: Temporary
  publishing: boolean
  published: boolean
  done: Promise<void>
  workSettled: boolean
  replySettled: boolean
  cleanupProved: boolean
  cleanupAttempted: boolean
  releases: (() => void)[]
  cleanup?: Promise<void>
}
const runtimeCounts = new WeakMap<AcpResourceHost, Map<string, number>>()
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

export async function createAcpFilesystem(options: {
  session: HarnessSession
  runtimeGeneration: string
  transportGeneration: string
  binding(): ConfirmedNativeBinding | null
  rpc: JsonlRpcTransport
  host: AcpResourceHost
  instanceId: string
  deadlineMs?: number
  hooks?: Hooks
}) {
  const {
    rpc,
    host,
    instanceId,
    runtimeGeneration,
    transportGeneration,
    binding,
  } = options
  const session = immutableData(options.session)
  const hooks = { ...options.hooks }
  const deadlineMs = options.deadlineMs ?? 6000
  if (
    !runtimeGeneration ||
    !transportGeneration ||
    session.provider !== instanceId ||
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1 ||
    deadlineMs > 6000
  )
    throw Error('Invalid ACP filesystem authority')
  let shared = runtimeCounts.get(host)
  if (!shared) {
    shared = new Map()
    runtimeCounts.set(host, shared)
  }
  const counts = shared,
    runtimeKey = JSON.stringify([instanceId, session.id, runtimeGeneration])
  const setupLease = host.reserve(instanceId, 'filesystem')
  const startup = new AbortController(),
    initialized = deferred<{ root: string; rootIdentity: string }>()
  const startupTimer = setTimeout(() => {
    startup.abort()
    initialized.reject(Error('ACP filesystem startup deadline'))
  }, deadlineMs)
  void Promise.resolve()
    .then(async () => {
      const root = await realpath(session.cwd)
      startup.signal.throwIfAborted()
      if (root !== session.cwd)
        throw Error('ACP filesystem requires canonical workspace')
      const info = await lstat(root, { bigint: true })
      startup.signal.throwIfAborted()
      if (!info.isDirectory())
        throw Error('ACP filesystem requires workspace directory')
      initialized.resolve({ root, rootIdentity: identity(info) })
    })
    .catch(initialized.reject)
    .finally(() => {
      clearTimeout(startupTimer)
      setupLease()
    })
  const { root, rootIdentity } = await initialized.promise
  const operations = new Set<Operation>()
  let closed = false,
    closing: Promise<void> | undefined

  async function discardTemporary(operation: Operation) {
    const temp = operation.temporary
    if (!temp) return
    const releaseBuffer = host.reserve(
      instanceId,
      'filesystemBytes',
      temp.expected.length + 1,
    )
    try {
      const before = await temp.handle.stat({ bigint: true })
      const bytes = await readBounded(temp.handle, temp.expected.length)
      const after = await temp.handle.stat({ bigint: true })
      const current = await lstat(temp.path, { bigint: true }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null
          throw error
        },
      )
      if (
        current &&
        (!bytes.equals(temp.expected) ||
          fileRevision(before) !== fileRevision(after) ||
          fileRevision(current) !== fileRevision(after))
      )
        throw Error('ACP temporary cleanup ownership changed')
      if (current) await unlink(temp.path)
      operation.temporary = undefined
    } finally {
      releaseBuffer()
    }
  }
  function cleanup(operation: Operation): Promise<void> {
    if (operation.cleanup) return operation.cleanup
    const result = deferred<void>()
    operation.cleanupAttempted = true
    operation.cleanup = result.promise
    void Promise.resolve()
      .then(async () => {
        await discardTemporary(operation)
        const handles = [...operation.handles]
        const handleResults = await Promise.allSettled(
          handles.map(async (handle) => {
            await handle.close()
            operation.handles.delete(handle)
          }),
        )
        const chains = [...operation.chains]
        const chainResults = await Promise.allSettled(
          chains.map(async (chain) => {
            await chain.close()
            operation.chains.delete(chain)
          }),
        )
        const failed = [...handleResults, ...chainResults].find(
          (value) => value.status === 'rejected',
        )
        if (failed?.status === 'rejected') throw failed.reason
        operation.cleanupProved = true
      })
      .then(result.resolve, result.reject)
      .finally(() => {
        operation.cleanup = undefined
      })
    return result.promise
  }
  function release(operation: Operation) {
    if (
      !operation.workSettled ||
      !operation.replySettled ||
      !operation.cleanupProved
    )
      return
    for (const end of operation.releases.splice(0)) end()
    operations.delete(operation)
  }
  function path(input: string) {
    const value = isAbsolute(input) ? relative(root, input) : input
    relativePath(value)
    if (value.split('/').length > 33) throw Error('ACP path depth limit')
    return value
  }
  async function read(
    operation: Operation,
    chain: WorkspacePath,
    line?: number | null,
    limit?: number | null,
  ) {
    operation.controller.signal.throwIfAborted()
    const before = await lstat(chain.leaf, { bigint: true })
    if (!before.isFile())
      throw Error('ACP filesystem accepts regular files only')
    const handle = await open(
      chain.leaf,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    operation.handles.add(handle)
    operation.controller.signal.throwIfAborted()
    const info = await handle.stat({ bigint: true })
    if (!info.isFile() || fileRevision(info) !== fileRevision(before))
      throw Error('ACP file changed during open')
    await hooks.beforeRead?.(handle)
    operation.controller.signal.throwIfAborted()
    if (info.size > BigInt(MiB)) throw Error('ACP file content limit')
    const size = Number(info.size)
    operation.releases.push(
      host.reserve(instanceId, 'filesystemBytes', size + 1),
    )
    const bytes = await readBounded(handle, size, operation.controller.signal)
    operation.controller.signal.throwIfAborted()
    if (bytes.length > MiB) throw Error('ACP file content limit')
    if (
      fileRevision(await handle.stat({ bigint: true })) !==
        fileRevision(info) ||
      fileRevision(await lstat(chain.leaf, { bigint: true })) !==
        fileRevision(info)
    )
      throw Error('ACP file changed during read')
    await chain.verify()
    const content = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes)
    return {
      content:
        line == null && limit == null
          ? content
          : content
              .split('\n')
              .slice(
                (line ?? 1) - 1,
                limit == null ? undefined : (line ?? 1) - 1 + limit,
              )
              .join('\n'),
    }
  }
  async function write(
    operation: Operation,
    chain: WorkspacePath,
    content: string,
  ) {
    const before = await lstat(chain.leaf, { bigint: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      },
    )
    if (before && !before.isFile())
      throw Error('ACP filesystem accepts regular files only')
    operation.controller.signal.throwIfAborted()
    const temporaryPath = descriptorPath(
      chain.parent,
      `.forge-save-${randomUUID()}`,
    )
    const handle = await open(
      temporaryPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_RDWR |
        constants.O_NOFOLLOW,
      before ? Number(before.mode) & 0o777 : 0o600,
    )
    operation.handles.add(handle)
    const temporary: Temporary = {
      path: temporaryPath,
      handle,
      expected: Buffer.alloc(0),
    }
    operation.temporary = temporary
    operation.controller.signal.throwIfAborted()
    operation.releases.push(
      host.reserve(instanceId, 'filesystemBytes', Buffer.byteLength(content)),
    )
    const bytes = Buffer.from(content, 'utf8')
    let written = 0
    while (written < bytes.length) {
      operation.controller.signal.throwIfAborted()
      const result = await handle.write(
        bytes,
        written,
        bytes.length - written,
        written,
      )
      if (!result.bytesWritten) throw Error('ACP file write made no progress')
      written += result.bytesWritten
      temporary.expected = bytes.subarray(0, written)
    }
    await handle.sync()
    operation.controller.signal.throwIfAborted()
    const staged = await handle.stat({ bigint: true })
    operation.releases.push(
      host.reserve(instanceId, 'filesystemBytes', bytes.length + 1),
    )
    const actual = await readBounded(handle, bytes.length)
    if (
      !actual.equals(bytes) ||
      fileRevision(staged) !==
        fileRevision(await handle.stat({ bigint: true })) ||
      fileRevision(await lstat(temporaryPath, { bigint: true })) !==
        fileRevision(staged)
    )
      throw Error('ACP staged file changed')
    await hooks.beforePublish?.()
    operation.controller.signal.throwIfAborted()
    await chain.verify()
    const current = await lstat(chain.leaf, { bigint: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      },
    )
    if (
      before
        ? !current || fileRevision(current) !== fileRevision(before)
        : current !== null
    )
      throw Error('ACP write destination changed')
    if (
      fileRevision(await lstat(temporaryPath, { bigint: true })) !==
      fileRevision(staged)
    )
      throw Error('ACP staged file changed')
    operation.controller.signal.throwIfAborted()
    operation.publishing = true
    await (hooks.rename ?? rename)(temporaryPath, chain.leaf)
    operation.published = true
    operation.temporary = undefined
    await chain.parent.sync()
    operation.controller.signal.throwIfAborted()
    await chain.verify()
    const published = await lstat(chain.leaf, { bigint: true })
    if (identity(published) !== identity(staged))
      throw Error('ACP published file changed')
    return {}
  }
  async function receive(
    original: JsonRpcRequest,
    inputOwner: AcpLiveOwner,
  ): Promise<boolean> {
    if (!['fs/read_text_file', 'fs/write_text_file'].includes(original.method))
      return false
    let operation: Operation | undefined
    try {
      if (closed || !rpc.isLiveRequest(original))
        throw Error('ACP filesystem request is retired')
      const owner = immutableData(inputOwner),
        expected = immutableData(binding())
      if (
        !expected ||
        owner.phase !== 'live' ||
        original.runtimeGeneration !== transportGeneration ||
        owner.runtimeGeneration !== runtimeGeneration ||
        owner.sessionId !== session.id ||
        owner.providerInstanceId !== instanceId ||
        canonical(owner.binding) !== canonical(expected) ||
        expected.provider !== session.provider ||
        expected.accountId !== (session.accountId ?? null) ||
        expected.cwd !== root ||
        (expected.accountId === null
          ? owner.account.kind !== 'native-default'
          : owner.account.kind !== 'selected-account' ||
            owner.account.accountId !== expected.accountId)
      )
        throw Error('ACP filesystem owner mismatch')
      if ((counts.get(runtimeKey) ?? 0) >= 4)
        throw Error('ACP filesystem request limit')
      const releases: (() => void)[] = []
      try {
        releases.push(host.reserve(instanceId, 'filesystem'))
        releases.push(host.reserve(instanceId, 'retained', 8 * MiB))
      } catch (error) {
        for (const end of releases) end()
        throw error
      }
      const done = deferred<void>(),
        replied = deferred<void>()
      operation = {
        controller: new AbortController(),
        handles: new Set(),
        chains: new Set(),
        publishing: false,
        published: false,
        done: Promise.all([done.promise, replied.promise]).then(() => {}),
        workSettled: false,
        replySettled: false,
        cleanupProved: false,
        cleanupAttempted: false,
        releases,
      }
      const current = operation
      counts.set(runtimeKey, (counts.get(runtimeKey) ?? 0) + 1)
      releases.push(() => {
        const count = (counts.get(runtimeKey) ?? 1) - 1
        if (count) counts.set(runtimeKey, count)
        else counts.delete(runtimeKey)
      })
      operations.add(current)
      const logical = deferred<unknown>()
      const stopped = () =>
        logical.reject(
          Error(
            current.publishing
              ? 'ACP publication uncertain'
              : 'ACP filesystem cancelled',
          ),
        )
      current.controller.signal.addEventListener('abort', stopped, {
        once: true,
      })
      const abort = () => current.controller.abort(original.signal.reason)
      original.signal.addEventListener('abort', abort, { once: true })
      if (original.signal.aborted) abort()
      const timer = setTimeout(() => {
        current.controller.abort()
        logical.reject(
          Error(
            current.publishing
              ? 'ACP publication uncertain'
              : 'ACP filesystem deadline',
          ),
        )
      }, deadlineMs)
      let params: unknown, captureError: unknown
      try {
        params = immutableData(original.params, MiB + 65536)
      } catch (error) {
        captureError = error
      }
      void Promise.resolve()
        .then(async () => {
          if (captureError) throw captureError
          const request =
            original.method === 'fs/read_text_file'
              ? zReadTextFileRequest.parse(params)
              : zWriteTextFileRequest.parse(params)
          if (request.sessionId !== expected.providerSessionId)
            throw Error('ACP native session mismatch')
          const relative = path(request.path)
          if ('content' in request && Buffer.byteLength(request.content) > MiB)
            throw Error('ACP file content limit')
          if (
            'line' in request &&
            request.line != null &&
            (!Number.isSafeInteger(request.line) || request.line < 1)
          )
            throw Error('ACP file line range')
          if (
            'limit' in request &&
            request.limit != null &&
            (!Number.isSafeInteger(request.limit) || request.limit < 1)
          )
            throw Error('ACP file line range')
          current.releases.push(
            host.reserve(
              instanceId,
              'descriptors',
              relative.split('/').length + 1,
            ),
          )
          current.controller.signal.throwIfAborted()
          const chain = await WorkspacePath.open(
            root,
            rootIdentity,
            relative,
            false,
            current.controller.signal,
            {
              ...hooks,
              onCreated(value) {
                current.chains.add(value)
                hooks.onCreated?.(value)
              },
            },
          )
          current.controller.signal.throwIfAborted()
          const result =
            'content' in request
              ? await write(current, chain, request.content)
              : await read(current, chain, request.line, request.limit)
          current.controller.signal.throwIfAborted()
          await cleanup(current)
          logical.resolve(result)
        })
        .catch((error) =>
          logical.reject(
            current.publishing ? Error('ACP publication uncertain') : error,
          ),
        )
        .finally(async () => {
          clearTimeout(timer)
          original.signal.removeEventListener('abort', abort)
          try {
            if (!current.cleanupAttempted) await cleanup(current)
          } catch {
            /* The exact failed cleanup remains in operations. */
          }
          current.controller.signal.removeEventListener('abort', stopped)
          current.workSettled = true
          release(current)
          done.resolve()
        })
      try {
        let result: unknown, failure: unknown
        try {
          result = await logical.promise
          current.controller.signal.throwIfAborted()
        } catch (error) {
          failure = error
        }
        if (rpc.isLiveRequest(original)) {
          const reply = failure
            ? rpc.respondErrorWithSubmission(
                original,
                -32000,
                current.publishing
                  ? 'ACP publication uncertain'
                  : 'ACP filesystem request failed',
              )
            : rpc.respondWithSubmission(original, result)
          const outcomes = await Promise.allSettled([
            reply.logical,
            reply.submission,
          ])
          const rejected = outcomes.find((value) => value.status === 'rejected')
          if (rejected?.status === 'rejected') throw rejected.reason
        } else if (current.publishing && failure) throw failure
      } finally {
        current.replySettled = true
        replied.resolve()
        release(current)
      }
      return true
    } catch (error) {
      if (!operation && rpc.isLiveRequest(original)) {
        const reply = rpc.respondErrorWithSubmission(
          original,
          -32602,
          'Invalid ACP filesystem request',
        )
        const outcomes = await Promise.allSettled([
          reply.logical,
          reply.submission,
        ])
        const failed = outcomes.find((value) => value.status === 'rejected')
        if (failed?.status === 'rejected') throw failed.reason
        return true
      }
      throw error
    }
  }
  function close(): Promise<void> {
    closed = true
    if (closing) return closing
    const result = deferred<void>()
    closing = result.promise
    for (const operation of operations)
      operation.controller.abort(Error('ACP filesystem closed'))
    const timer = setTimeout(
      () => result.reject(Error('ACP filesystem cleanup pending')),
      deadlineMs,
    )
    void Promise.allSettled(
      [...operations].map(async (operation) => {
        await operation.done
        await cleanup(operation)
        release(operation)
      }),
    )
      .then((results) => {
        const failed = results.find((value) => value.status === 'rejected')
        if (failed?.status === 'rejected') result.reject(failed.reason)
        else result.resolve()
      })
      .finally(() => {
        clearTimeout(timer)
        closing = undefined
      })
    return result.promise
  }
  return { receive, close }
}
