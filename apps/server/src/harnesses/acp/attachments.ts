import { NativeCleanupError } from '../native-cleanup.js'
import { createHash } from 'node:crypto'
import type { ContentBlock, PromptCapabilities } from '@agentclientprotocol/sdk'
import { promptInputSchema, type PromptInput } from '@forge/protocol/harness'
import { immutableData } from './data.js'
import type { AcpResourceHost } from './limits.js'

const MiB = 1024 * 1024
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
const defaults = Object.freeze({
  parts: 128,
  textBytes: MiB,
  fileBytes: 8 * MiB,
  decodedBytes: 10 * MiB,
  frameBytes: 16 * MiB,
  deadlineMs: 15_000,
  perSession: 2,
})
type Limits = { [Key in keyof typeof defaults]: number }
const sessionCounts = new WeakMap<AcpResourceHost, Map<string, number>>()
export type AcpAttachmentReader = {
  read(
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<{ bytes: Uint8Array; eof: boolean }>
  close(): Promise<void>
}
export type AuthorizedAcpAttachment = {
  sessionId: string
  attachmentId: string
  status: 'ready'
  mime: string
  size: number
  sha256: string
  uri: string
  reader: AcpAttachmentReader
}
export type AcpAttachmentResolver = (
  sessionId: string,
  attachmentId: string,
  options: { signal: AbortSignal; maxBytes: number },
) => Promise<AuthorizedAcpAttachment>
type ReaderOwner = {
  reader: AcpAttachmentReader
  pending?: Promise<void>
  closed: boolean
}
type Operation = {
  controller: AbortController
  readers: Set<ReaderOwner>
  work: Promise<void>
  workSettled: boolean
  releaseRequested: boolean
  released: boolean
  releases: (() => void)[]
  cleanup?: Promise<void>
  unknownReader: boolean
  resolverCleanup?: NativeCleanupError
  rejectLogical(error: unknown): void
}
function bounded(value: string, maximum: number) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > maximum)
    throw Error('Invalid ACP attachment metadata')
  return value
}

/** The resolver proves upload and storage authorization for the exact Forge session. */
export function createAcpAttachments(options: {
  host: AcpResourceHost
  instanceId: string
  authorizedAttachment: AcpAttachmentResolver
  limits?: Partial<Limits>
}) {
  const { host, instanceId, authorizedAttachment } = options
  const limits = { ...defaults, ...options.limits }
  for (const key of Object.keys(defaults) as (keyof Limits)[])
    if (
      !Number.isSafeInteger(limits[key]) ||
      limits[key] < 1 ||
      limits[key] > defaults[key]
    )
      throw Error('Invalid ACP attachment limit')
  const operations = new Set<Operation>()
  let sessions = sessionCounts.get(host)
  if (!sessions) {
    sessions = new Map()
    sessionCounts.set(host, sessions)
  }
  const sessionOwners = sessions
  let closed = false
  let closing: Promise<void> | undefined
  async function closeReader(owner: ReaderOwner) {
    if (owner.closed) return
    if (owner.pending) return owner.pending
    // Publish the pending close before invoking the external reader.
    const result = deferred<void>()
    owner.pending = result.promise
    void Promise.resolve()
      .then(() => owner.reader.close())
      .then(() => {
        owner.closed = true
        result.resolve()
      }, result.reject)
      .finally(() => {
        owner.pending = undefined
      })
    return result.promise
  }
  function releaseIfDone(operation: Operation) {
    if (
      !operation.workSettled ||
      !operation.releaseRequested ||
      operation.released ||
      operation.unknownReader ||
      operation.resolverCleanup ||
      [...operation.readers].some((reader) => !reader.closed)
    )
      return
    operation.released = true
    for (const release of operation.releases.splice(0)) release()
    operations.delete(operation)
  }
  function cleanup(operation: Operation): Promise<void> {
    operation.releaseRequested = true
    const reason = Error('ACP attachment released')
    operation.controller.abort(reason)
    operation.rejectLogical(reason)
    if (operation.cleanup) return operation.cleanup
    const result = deferred<void>()
    operation.cleanup = result.promise
    const timer = setTimeout(
      () => result.reject(Error('ACP attachment cleanup pending')),
      limits.deadlineMs,
    )
    void operation.work
      .then(async () => {
        const results = await Promise.allSettled([
          ...[...operation.readers].map(closeReader),
          ...(operation.resolverCleanup
            ? [
                operation.resolverCleanup.retryCleanup().then(() => {
                  operation.resolverCleanup = undefined
                }),
              ]
            : []),
        ])
        releaseIfDone(operation)
        const failed = results.find((value) => value.status === 'rejected')
        if (failed?.status === 'rejected') throw failed.reason
        if (operation.unknownReader)
          throw Error('ACP attachment reader identity unavailable')
      })
      .then(result.resolve, result.reject)
      .finally(() => {
        clearTimeout(timer)
        operation.cleanup = undefined
      })
    return result.promise
  }
  function prepare(
    sessionId: string,
    input: PromptInput[] | string,
    promptCapabilities: PromptCapabilities,
    signal: AbortSignal,
  ): Promise<{ blocks: ContentBlock[]; release(): Promise<void> }> {
    if (closed) return Promise.reject(Error('ACP attachments closed'))
    signal.throwIfAborted()
    bounded(sessionId, 512)
    const sessionKey = JSON.stringify([instanceId, sessionId])
    if (Array.isArray(input) && input.length > limits.parts)
      throw Error('ACP input part limit')
    const releaseMetadata = host.reserve(instanceId, 'retained', 4 * MiB)
    let admitted = false
    try {
      // Metadata itself is bounded before any external resolver can run.
      const captured = immutableData(
        typeof input === 'string' ? [{ type: 'text', text: input }] : input,
        2 * MiB,
      )
      const parts = captured.map((part) => promptInputSchema.parse(part))
      const capabilities = immutableData(promptCapabilities, 65536)
      let textBytes = 0
      for (const part of parts) {
        if (part.type === 'text') textBytes += Buffer.byteLength(part.text)
        if (part.type === 'attachment') {
          bounded(part.attachmentId, 512)
          bounded(part.mime, 256)
          if (
            (part.mime.startsWith('image/') && !capabilities.image) ||
            (part.mime.startsWith('audio/') && !capabilities.audio) ||
            (!part.mime.startsWith('image/') &&
              !part.mime.startsWith('audio/') &&
              !capabilities.embeddedContext)
          )
            throw Error('ACP attachment capability unavailable')
        }
        if (part.type === 'review_reference') {
          bounded(part.url, 4096)
          if (part.title !== undefined) bounded(part.title, 65536)
        }
      }
      if (parts.length > limits.parts || textBytes > limits.textBytes)
        throw Error('ACP input limit')
      if ((sessionOwners.get(sessionKey) ?? 0) >= limits.perSession)
        throw Error('ACP session attachment limit')
      const releaseSlot = host.reserve(instanceId, 'attachments')
      const physical = deferred<void>()
      const logical = deferred<{
        blocks: ContentBlock[]
        release(): Promise<void>
      }>()
      const operation: Operation = {
        controller: new AbortController(),
        readers: new Set(),
        work: physical.promise,
        workSettled: false,
        releaseRequested: false,
        released: false,
        unknownReader: false,
        rejectLogical: logical.reject,
        releases: [
          releaseSlot,
          releaseMetadata,
          () => {
            const count = (sessionOwners.get(sessionKey) ?? 1) - 1
            if (count) sessionOwners.set(sessionKey, count)
            else sessionOwners.delete(sessionKey)
          },
        ],
      }
      sessionOwners.set(sessionKey, (sessionOwners.get(sessionKey) ?? 0) + 1)
      operations.add(operation)
      admitted = true
      const abort = () => {
        const error = signal.reason ?? Error('ACP attachment cancelled')
        operation.controller.abort(error)
        operation.releaseRequested = true
        logical.reject(error)
        releaseIfDone(operation)
      }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      const timer = setTimeout(() => {
        const error = Error('ACP attachment deadline')
        operation.controller.abort(error)
        operation.releaseRequested = true
        logical.reject(error)
        releaseIfDone(operation)
      }, limits.deadlineMs)
      const charge = (bytes: number) =>
        operation.releases.push(host.reserve(instanceId, 'retained', bytes))
      const check = () => operation.controller.signal.throwIfAborted()
      void Promise.resolve()
        .then(async () => {
          const blocks: ContentBlock[] = []
          let decoded = 0
          // Reserve wrapper room for maximum native session and RPC IDs.
          let frameBytes = 8192
          for (const part of parts) {
            check()
            let block: ContentBlock
            if (part.type === 'text') block = { type: 'text', text: part.text }
            else if (part.type === 'review_reference')
              block = {
                type: 'resource_link',
                uri: part.url,
                name: part.title ?? part.url,
              }
            else {
              const resolved = await Promise.resolve()
                .then(() =>
                  authorizedAttachment(sessionId, part.attachmentId, {
                    signal: operation.controller.signal,
                    maxBytes: limits.fileBytes,
                  }),
                )
                .catch((error) => {
                  if (error instanceof NativeCleanupError)
                    operation.resolverCleanup = error
                  throw error
                })
              operation.unknownReader = true
              const readerProperty = Object.getOwnPropertyDescriptor(
                resolved,
                'reader',
              )
              if (!readerProperty || !('value' in readerProperty))
                throw Error('Invalid ACP attachment reader accessor')
              const original = readerProperty.value
              if (!original || typeof original !== 'object')
                throw Error('Invalid ACP attachment reader')
              const close = Object.getOwnPropertyDescriptor(original, 'close')
              if (
                !close ||
                !('value' in close) ||
                typeof close.value !== 'function'
              )
                throw Error('Invalid ACP attachment reader close')
              const read = Object.getOwnPropertyDescriptor(original, 'read')
              const owner: ReaderOwner = {
                reader: {
                  close: () => close.value.call(original),
                  read: (maxBytes, signal) =>
                    read!.value.call(original, maxBytes, signal),
                },
                closed: false,
              }
              operation.readers.add(owner)
              operation.unknownReader = false
              try {
                check()
                if (
                  !read ||
                  !('value' in read) ||
                  typeof read.value !== 'function'
                )
                  throw Error('Invalid ACP attachment reader accessor')
                const descriptors = Object.getOwnPropertyDescriptors(resolved)
                Reflect.deleteProperty(descriptors, 'reader')
                const fields = Object.defineProperties(
                  Object.create(Object.getPrototypeOf(resolved)),
                  descriptors,
                )
                const meta = immutableData(fields, 65536)
                if (
                  meta.sessionId !== sessionId ||
                  meta.attachmentId !== part.attachmentId ||
                  meta.status !== 'ready' ||
                  meta.mime !== part.mime ||
                  !Number.isSafeInteger(meta.size) ||
                  meta.size < 0 ||
                  meta.size > limits.fileBytes ||
                  !/^[a-f0-9]{64}$/.test(meta.sha256)
                )
                  throw Error('ACP attachment authorization mismatch')
                bounded(meta.uri, 4096)
                new URL(meta.uri)
                decoded += meta.size
                if (decoded > limits.decodedBytes)
                  throw Error('ACP decoded input limit')
                const encoded = 4 * Math.ceil(meta.size / 3)
                if (
                  frameBytes +
                    encoded +
                    Buffer.byteLength(JSON.stringify(meta.uri)) +
                    1024 >
                  limits.frameBytes
                )
                  throw Error('ACP prompt frame limit')
                charge(meta.size * 2 + encoded * 2)
                const result = await owner.reader.read(
                  meta.size + 1,
                  operation.controller.signal,
                )
                check()
                if (
                  !(result.bytes instanceof Uint8Array) ||
                  !result.eof ||
                  result.bytes.byteLength !== meta.size ||
                  result.bytes.byteLength > limits.fileBytes
                )
                  throw Error('ACP attachment size or EOF mismatch')
                if (result.bytes.buffer.byteLength > meta.size)
                  charge(result.bytes.buffer.byteLength - meta.size)
                const bytes = Buffer.from(result.bytes)
                if (
                  createHash('sha256').update(bytes).digest('hex') !==
                  meta.sha256
                )
                  throw Error('ACP attachment digest mismatch')
                const data = bytes.toString('base64')
                if (meta.mime.startsWith('image/'))
                  block = { type: 'image', mimeType: meta.mime, data }
                else if (meta.mime.startsWith('audio/'))
                  block = { type: 'audio', mimeType: meta.mime, data }
                else
                  block = {
                    type: 'resource',
                    resource: {
                      uri: meta.uri,
                      mimeType: meta.mime,
                      blob: data,
                    },
                  }
              } finally {
                await closeReader(owner)
              }
            }
            check()
            // JSON escaping can expand text sixfold. Charge the temporary string too.
            const serialization = host.reserve(
              instanceId,
              'retained',
              limits.frameBytes * 2,
            )
            try {
              frameBytes += Buffer.byteLength(JSON.stringify(block)) + 1
            } finally {
              serialization()
            }
            if (frameBytes > limits.frameBytes)
              throw Error('ACP prompt frame limit')
            blocks.push(Object.freeze(block))
          }
          check()
          logical.resolve({
            blocks: Object.freeze(blocks) as ContentBlock[],
            release: () => cleanup(operation),
          })
        })
        .catch((error) => {
          operation.releaseRequested = true
          logical.reject(error)
        })
        .finally(() => {
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
          operation.workSettled = true
          physical.resolve()
          releaseIfDone(operation)
        })
      return logical.promise
    } catch (error) {
      if (!admitted) releaseMetadata()
      throw error
    }
  }
  function close(): Promise<void> {
    closed = true
    if (closing) return closing
    const result = deferred<void>()
    closing = result.promise
    void Promise.allSettled([...operations].map(cleanup))
      .then((results) => {
        const failed = results.find((value) => value.status === 'rejected')
        if (failed?.status === 'rejected') result.reject(failed.reason)
        else result.resolve()
      })
      .finally(() => {
        closing = undefined
      })
    return result.promise
  }
  return { prepare, close }
}
