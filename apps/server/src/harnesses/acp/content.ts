import { createHash } from 'node:crypto'
import { sourceReferenceSchema } from '@forge/protocol/harness'
import { z } from 'zod'
import type { HarnessEvent } from '../types.js'
import { digest, immutableData } from './data.js'
import type {
  AcpContentOwner,
  AcpContentStore,
  AcpSourceRef,
} from './ingestion.js'
import type { AcpResourceHost } from './limits.js'

type Block = Extract<HarnessEvent, { type: 'content_block' }>['block']
const MiB = 1024 * 1024
const artifactReferenceSchema = sourceReferenceSchema.extend({
  bytes: z
    .number()
    .int()
    .nonnegative()
    .max(10 * MiB),
})
const hash = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex')
function string(value: unknown, maximum: number, empty = false): string {
  if (
    typeof value !== 'string' ||
    (!empty && !value) ||
    Buffer.byteLength(value) > maximum
  )
    throw Error('Invalid ACP content string')
  return value
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Invalid ACP content object')
  return value as Record<string, unknown>
}
// Inspect descriptors before copying caller data or allocating decoded buffers.
function allocation(value: unknown): number {
  let nodes = 0,
    bytes = 0
  const parents = new Set<object>()
  const visit = (value: unknown, depth: number) => {
    if (++nodes > 16384 || depth > 32)
      throw Error('ACP content structure limit')
    bytes += 32
    if (typeof value === 'string') bytes += value.length * 2
    else if (value !== null && typeof value === 'object') {
      const proto = Object.getPrototypeOf(value)
      if (
        parents.has(value) ||
        (!Array.isArray(value) && proto !== Object.prototype && proto !== null)
      )
        throw Error('Invalid ACP content data')
      parents.add(value)
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string') throw Error('Invalid ACP content key')
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!
        if (!('value' in descriptor))
          throw Error('Invalid ACP content accessor')
        bytes += key.length * 2
        visit(descriptor.value, depth + 1)
      }
      parents.delete(value)
    } else if (
      value !== undefined &&
      value !== null &&
      !['number', 'boolean'].includes(typeof value)
    )
      throw Error('Invalid ACP content value')
    if (bytes > 40 * MiB) throw Error('ACP content byte limit')
  }
  visit(value, 0)
  return bytes
}
function ownerSnapshot(input: AcpContentOwner, instanceId: string) {
  const subject = immutableData(input, 65536)
  const { owner } = subject
  string(subject.itemId, 512)
  for (const value of [subject.responseId, subject.childId, subject.intervalId])
    if (value !== undefined) string(value, 512)
  if (Boolean(subject.childId) !== Boolean(subject.intervalId))
    throw Error('ACP content child interval mismatch')
  if (owner.providerInstanceId !== instanceId)
    throw Error('Foreign ACP content instance')
  for (const value of [
    owner.sessionId,
    owner.runtimeGeneration,
    owner.binding.provider,
    owner.binding.providerSessionId,
    owner.binding.cwd,
  ])
    string(value, 4096)
  if (owner.account.kind === 'selected-account') {
    string(owner.account.accountId, 512)
    if (owner.binding.accountId !== owner.account.accountId)
      throw Error('Foreign ACP content account')
  } else if (owner.account.kind === 'native-default') {
    string(owner.account.configurationId, 512)
    if (owner.binding.accountId !== null)
      throw Error('Foreign ACP content account')
  } else throw Error('Invalid ACP content account')
  if (owner.binding.provider !== instanceId)
    throw Error('Foreign ACP content binding')
  if (owner.phase === 'live') {
    string(owner.runId, 512)
    string(owner.turnId, 512)
  } else if (owner.phase === 'load_replay') {
    string(owner.loadId, 512)
    if (owner.requestedNativeSessionId !== owner.binding.providerSessionId)
      throw Error('Foreign ACP replay binding')
  } else throw Error('Invalid ACP content phase')
  return subject
}

function rootKey(owner: AcpContentOwner['owner']) {
  return JSON.stringify([
    owner.sessionId,
    owner.runtimeGeneration,
    owner.phase === 'live' ? owner.runId : owner.loadId,
  ])
}
type Totals = { bytes: number; sources: number }
type Cleanup = {
  owner: AcpContentOwner
  ids: string[]
  release: () => void
  pending?: Promise<void>
  unknown?: { mime: string; bytes: number; sha256: string }
}
export function createAcpContent(options: {
  store: AcpContentStore
  host: AcpResourceHost
  instanceId: string
}) {
  const { store, host, instanceId } = options
  const sessions = new Map<string, number>(),
    roots = new Map<
      string,
      Totals & { authority: string; active: boolean; release: () => void }
    >(),
    activeRoots = new Map<string, number>()
  const totals: Totals = { bytes: 0, sources: 0 }
  const cleanup = new Set<Cleanup>(),
    work = new Set<Promise<unknown>>()
  const controllers = new Set<AbortController>()
  let closed = false
  function discard(entry: Cleanup): Promise<void> {
    if (entry.pending) return entry.pending
    const pending = Promise.resolve().then(async () => {
      while (entry.ids.length) {
        await store.discard(entry.ids[0]!, entry.owner)
        entry.ids.shift()
      }
      if (entry.unknown)
        throw Error('ACP artifact cleanup identity unavailable')
      cleanup.delete(entry)
      entry.release()
    })
    entry.pending = pending
    void pending.then(
      () => {
        entry.pending = undefined
      },
      () => {
        entry.pending = undefined
      },
    )
    return pending
  }
  function execute<T>(
    input: AcpContentOwner,
    value: unknown,
    signal: AbortSignal,
    build: (
      snapshot: unknown,
      put: (
        bytes: Uint8Array,
        mime: string,
        source?: boolean,
      ) => Promise<AcpSourceRef>,
      charge: (bytes: number) => void,
    ) => Promise<T>,
  ): Promise<T> {
    const releases: (() => void)[] = []
    let owner: AcpContentOwner
    try {
      if (closed || signal.aborted) throw Error('ACP content cancelled')
      releases.push(host.reserve(instanceId, 'retained', allocation(input)))
      owner = ownerSnapshot(input, instanceId)
      const session = owner.owner.sessionId
      if ((sessions.get(session) ?? 0) >= 2)
        throw Error('ACP session artifact limit')
      const root = rootKey(owner.owner)
      releases.push(host.reserve(instanceId, 'artifacts'))
      activeRoots.set(root, (activeRoots.get(root) ?? 0) + 1)
      releases.push(() => {
        const remaining = activeRoots.get(root)! - 1
        if (remaining) activeRoots.set(root, remaining)
        else activeRoots.delete(root)
      })
      sessions.set(session, (sessions.get(session) ?? 0) + 1)
      releases.push(() => {
        const remaining = sessions.get(session)! - 1
        if (remaining) sessions.set(session, remaining)
        else sessions.delete(session)
      })
      releases.push(host.reserve(instanceId, 'retained', allocation(value)))
    } catch (error) {
      releases.reverse().forEach((release) => release())
      return Promise.reject(error)
    }
    let released = false
    const release = () => {
      if (released) return
      released = true
      releases.reverse().forEach((release) => release())
    }
    const controller = new AbortController()
    controllers.add(controller)
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, 15000)
    const entry: Cleanup = { owner, ids: [], release }
    let resolvePhysical!: (value: T | PromiseLike<T>) => void
    let rejectPhysical!: (error: unknown) => void
    const physical = new Promise<T>((resolve, reject) => {
      resolvePhysical = resolve
      rejectPhysical = reject
    })
    work.add(physical)
    void (async () => {
      try {
        const snapshot = immutableData(value, 16 * MiB)
        const charge = (bytes: number) =>
          releases.push(host.reserve(instanceId, 'retained', bytes))
        const put = async (bytes: Uint8Array, mime: string, source = false) => {
          if (controller.signal.aborted) throw Error('ACP content cancelled')
          const key = rootKey(owner.owner)
          const authority = digest(owner.owner)
          const prior = roots.get(key)
          if (prior && prior.authority !== authority)
            throw Error('Foreign ACP content root')
          const root = prior ?? { bytes: 0, sources: 0 }
          if (
            (!prior?.active &&
              [...roots.values()].filter((root) => root.active).length >=
                128) ||
            (!prior && roots.size >= 512) ||
            bytes.byteLength > (source ? MiB : 10 * MiB) ||
            root.bytes + bytes.byteLength > 32 * MiB ||
            totals.bytes + bytes.byteLength > 128 * MiB ||
            (source &&
              (root.sources + bytes.byteLength > 8 * MiB ||
                totals.sources + bytes.byteLength > 32 * MiB))
          )
            throw Error('ACP artifact byte limit')
          if (!roots.has(key)) {
            const release = host.reserve(
              instanceId,
              'retained',
              key.length * 2 + 128,
            )
            roots.set(key, { ...root, authority, active: true, release })
          }
          const chargedRoot = roots.get(key)!
          chargedRoot.active = true
          chargedRoot.bytes += bytes.byteLength
          totals.bytes += bytes.byteLength
          if (source) {
            chargedRoot.sources += bytes.byteLength
            totals.sources += bytes.byteLength
          }
          const sha256 = hash(bytes)
          const result = await store.put(
            {
              owner,
              purpose: source
                ? 'source_metadata'
                : owner.owner.phase === 'load_replay'
                  ? 'replay'
                  : 'content',
              mime,
              bytes,
              sha256,
            },
            controller.signal,
          )
          // A malformed acknowledgement can still name an artifact requiring owned cleanup.
          entry.unknown = { mime, bytes: bytes.byteLength, sha256 }
          const id = Object.getOwnPropertyDescriptor(
            result,
            'artifactId',
          )?.value
          if (typeof id === 'string' && id && Buffer.byteLength(id) <= 512) {
            entry.ids.push(id)
            entry.unknown = undefined
          }
          const reference = (
            source ? sourceReferenceSchema : artifactReferenceSchema
          ).parse(immutableData(result, 4096))
          if (
            reference.mime !== mime ||
            reference.bytes !== bytes.byteLength ||
            reference.sha256 !== sha256
          )
            throw Error('Invalid ACP artifact acknowledgement')
          if (controller.signal.aborted) throw Error('ACP content cancelled')
          return Object.freeze(reference)
        }
        const result = await build(snapshot, put, charge)
        if (controller.signal.aborted) throw Error('ACP content cancelled')
        release()
        return result
      } catch (error) {
        cleanup.add(entry)
        await discard(entry)
        throw error
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        controllers.delete(controller)
      }
    })().then(resolvePhysical, rejectPhysical)
    void physical.then(
      () => work.delete(physical),
      () => work.delete(physical),
    )
    return new Promise<T>((resolve, reject) => {
      const cancelled = () => reject(Error('ACP content cancelled'))
      controller.signal.addEventListener('abort', cancelled, { once: true })
      void physical
        .then(resolve, reject)
        .finally(() =>
          controller.signal.removeEventListener('abort', cancelled),
        )
      if (controller.signal.aborted) cancelled()
    })
  }
  async function metadata(
    value: unknown,
    put: (
      bytes: Uint8Array,
      mime: string,
      source?: boolean,
    ) => Promise<AcpSourceRef>,
    charge: (bytes: number) => void,
  ) {
    charge(6 * allocation(value))
    const encoded = JSON.stringify(value)
    if (encoded === undefined || Buffer.byteLength(encoded) > MiB)
      throw Error('ACP source metadata limit')
    charge(Buffer.byteLength(encoded))
    const bytes = Buffer.allocUnsafeSlow(Buffer.byteLength(encoded))
    bytes.write(encoded)
    return put(bytes, 'application/json', true)
  }
  return {
    source(owner: AcpContentOwner, value: unknown, signal: AbortSignal) {
      return execute(owner, value, signal, metadata)
    },
    block(owner: AcpContentOwner, value: unknown, signal: AbortSignal) {
      return execute(owner, value, signal, async (snapshot, put, charge) => {
        const content = object(snapshot)
        let block: Block
        const omitted = new Set<string>(['type'])
        const binary = async (data: unknown, mime: unknown) => {
          const encoded = string(data, 4 * Math.ceil((10 * MiB) / 3), true)
          const padding = encoded.endsWith('==')
            ? 2
            : encoded.endsWith('=')
              ? 1
              : 0
          const alphabet =
            'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
          if (encoded.length % 4) throw Error('Invalid ACP base64')
          for (let index = 0; index < encoded.length - padding; index++)
            if (alphabet.indexOf(encoded[index]!) < 0)
              throw Error('Invalid ACP base64')
          if (
            padding &&
            alphabet.indexOf(encoded[encoded.length - padding - 1]!) &
              (padding === 2 ? 15 : 3)
          )
            throw Error('Invalid ACP base64')
          const length = (encoded.length / 4) * 3 - padding
          if (length > 10 * MiB) throw Error('ACP artifact byte limit')
          charge(length)
          const bytes = Buffer.allocUnsafeSlow(length)
          bytes.write(encoded, 'base64')
          return put(bytes, string(mime, 256))
        }
        if (content.type === 'image' || content.type === 'audio') {
          block = {
            kind: content.type,
            ...(await binary(content.data, content.mimeType)),
          }
          omitted.add('data')
          omitted.add('mimeType')
        } else if (content.type === 'resource') {
          const resource = object(content.resource)
          const uri = string(resource.uri, 4096, true)
          if (
            Object.hasOwn(resource, 'text') === Object.hasOwn(resource, 'blob')
          )
            throw Error('Invalid ACP resource body')
          if (Object.hasOwn(resource, 'text')) {
            block = {
              kind: 'text_resource',
              uri,
              text: string(resource.text, MiB, true),
              ...(resource.mimeType !== undefined
                ? { mime: string(resource.mimeType, 256) }
                : {}),
            }
          } else
            block = {
              kind: 'artifact_resource',
              uri,
              ...(await binary(
                resource.blob,
                resource.mimeType ?? 'application/octet-stream',
              )),
            }
          omitted.add('resource')
        } else if (content.type === 'resource_link') {
          block = {
            kind: 'resource_link',
            uri: string(content.uri, 4096, true),
            name: string(content.name, 65536, true),
          }
          for (const key of ['title', 'description'] as const)
            if (content[key] !== undefined)
              block[key] = string(content[key], 65536, true)
          if (content.mimeType !== undefined)
            block.mime = string(content.mimeType, 256)
          if (content.size !== undefined) {
            if (
              !Number.isSafeInteger(content.size) ||
              (content.size as number) < 0
            )
              throw Error('Invalid ACP resource size')
            block.size = content.size as number
          }
          for (const key of [
            'uri',
            'name',
            'title',
            'description',
            'mimeType',
            'size',
          ])
            omitted.add(key)
        } else throw Error('Unsupported ACP content block')
        const extra = Object.fromEntries(
          Object.entries(content).filter(([key]) => !omitted.has(key)),
        )
        if (content.type === 'resource') {
          const resource = Object.fromEntries(
            Object.entries(object(content.resource)).filter(
              ([key]) => !['uri', 'mimeType', 'text', 'blob'].includes(key),
            ),
          )
          if (Object.keys(resource).length) extra.resource = resource
        }
        const sourceRefs = Object.keys(extra).length
          ? [await metadata(extra, put, charge)]
          : []
        return { block: Object.freeze(block), sourceRefs }
      })
    },
    retireRoot(owner: AcpContentOwner['owner']) {
      const snapshot = ownerSnapshot(
        { owner, itemId: 'retirement' },
        instanceId,
      ).owner
      const key = rootKey(snapshot)
      const prior = roots.get(key)
      if (prior && prior.authority !== digest(snapshot))
        throw Error('Foreign ACP content root')
      if (activeRoots.has(key))
        throw Error('ACP content root still owns physical work')
      if (prior) prior.active = false
    },
    async retryCleanup() {
      for (const entry of cleanup) await discard(entry)
    },
    async close() {
      closed = true
      for (const controller of controllers) controller.abort()
      await Promise.allSettled(work)
      for (const entry of cleanup) await discard(entry)
      for (const root of roots.values()) root.release()
      roots.clear()
    },
  }
}
