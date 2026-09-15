/* eslint-disable no-control-regex -- Reject control bytes in protocol identifiers. */
import { types } from 'node:util'
export class CursorError extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message)
  }
}
export function invariant(value: unknown, code: string): asserts value {
  if (!value) throw new CursorError(code)
}
const KiB = 1024
const MiB = KiB * KiB
export const CURSOR_LIMITS = Object.freeze({
  containers: 8,
  callbacks: 8,
  args: 32,
  argBytes: 16 * KiB,
  argValueBytes: 4096,
  envEntries: 256,
  envBytes: 64 * KiB,
  envValueBytes: 8192,
  credentialBytes: 64 * KiB,
  credentialKeyBytes: 8192,
  credentialDepth: 16,
  waiting: 8,
  parts: 32,
  promptBytes: 512 * KiB,
  queuedPromptBytes: 4 * MiB,
  images: 4,
  imageBytes: 2 * MiB,
  imageTotalBytes: 8 * MiB,
  frameBytes: 16 * MiB,
  queuedFrames: 256,
  queuedWireBytes: 32 * MiB,
  controls: 8,
  controlBytes: MiB,
  requestIdBytes: 128,
  idBytes: 256,
  owners: 4096,
  ownerBytes: 2 * MiB,
  itemBytes: 2 * MiB,
  contentBytes: 8 * MiB,
  toolBytes: MiB,
  jsonDepth: 32,
  jsonElements: 16384,
  children: 64,
  liveChildren: 32,
  childBytes: 8 * MiB,
  models: 512,
  parameters: 32,
  parameterValues: 128,
  variants: 64,
  catalogBytes: 2 * MiB,
  stderrBytes: 64 * KiB,
  messageBytes: 4096,
  detailBytes: 16 * KiB,
  diagnostics: 64,
  diagnosticBytes: 256 * KiB,
  rootEvents: 20000,
  rootEventBytes: 64 * MiB,
  rootInputBytes: 32 * MiB,
  generationEvents: 100000,
  generationEventBytes: 128 * MiB,
  storeOperations: 32,
  storeInputBytes: 16 * MiB,
  globalStoreOperations: 128,
  globalStoreInputBytes: 64 * MiB,
  agents: 1,
  runs: 256,
  runEvents: 20000,
  checkpoints: 4096,
  checkpointBytes: 8 * MiB,
  fileBytes: 64 * MiB,
  committedBytes: 128 * MiB,
  physicalStoreBytes: 256 * MiB,
  markerBytes: 32 * KiB,
  markerTemporaryBytes: 64 * KiB,
  reservations: 10000,
  indexes: 10000,
  inventoryBytes: 32 * MiB,
  scans: 8,
  scanEntries: 4096,
  scanDepth: 32,
  scanPending: 256,
  scanPathBytes: MiB,
  nativeBytes: 128 * MiB,
  startupMs: 15000,
  controlMs: 15000,
  preparationMs: 30000,
  cancellationMs: 2000,
  turnMs: 1800000,
  runtimeMs: 7200000,
  tasks: 256,
  helperMs: 5000,
  helperBytes: 64 * KiB,
  helperErrorBytes: 4096,
  cgroupDirectories: 128,
  cgroupDepth: 32,
  cgroupTasks: 256,
  cgroupBytes: MiB,
})
export type CursorLimits = {
  -readonly [K in keyof typeof CURSOR_LIMITS]: number
}
export type CursorServiceGrant = Readonly<{
  storeOperations: number
  storeInputBytes: number
  scans: number
}>
export function serviceGrant(limits: CursorLimits): CursorServiceGrant {
  return Object.freeze({
    storeOperations: limits.storeOperations,
    storeInputBytes: limits.storeInputBytes,
    scans: 1,
  })
}
export function validateServiceGrant(value: unknown): CursorServiceGrant {
  const grant = plainCopy(value, 1024) as CursorServiceGrant
  invariant(
    grant &&
      Object.keys(grant).length === 3 &&
      Object.entries(grant).every(
        ([key, value]) =>
          ['storeOperations', 'storeInputBytes', 'scans'].includes(key) &&
          Number.isSafeInteger(value) &&
          value > 0 &&
          value <=
            (key === 'scans'
              ? 1
              : CURSOR_LIMITS[key as 'storeOperations' | 'storeInputBytes']),
      ),
    'cursor_lease_grant_invalid',
  )
  return grant
}
export function cursorLimits(
  overrides: Partial<CursorLimits> = {},
): CursorLimits {
  const copy = plainCopy(overrides, 16384) as Partial<CursorLimits>
  const result: CursorLimits = { ...CURSOR_LIMITS }
  for (const [key, value] of Object.entries(copy)) {
    const name = key as keyof CursorLimits
    invariant(
      name in result &&
        Number.isSafeInteger(value) &&
        value! > 0 &&
        value! <= CURSOR_LIMITS[name],
      'cursor_invalid_limit',
    )
    result[name] = value!
  }
  invariant(
    result.imageBytes <= result.imageTotalBytes &&
      result.images * Math.ceil(result.imageBytes / 3) * 4 +
        6 * result.promptBytes +
        result.controlBytes <=
        result.frameBytes,
    'cursor_inconsistent_limits',
  )
  invariant(
    result.frameBytes <= result.queuedWireBytes &&
      result.fileBytes <= result.committedBytes &&
      result.committedBytes <= result.physicalStoreBytes,
    'cursor_inconsistent_limits',
  )
  return Object.freeze(result)
}
export type BoundedJson =
  | null
  | boolean
  | number
  | string
  | BoundedJson[]
  | { [key: string]: BoundedJson }
export function jsonStringBytes(value: string) {
  let bytes = Buffer.byteLength(value) + 2
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code === 34 || code === 92) bytes++
    else if (code < 32) bytes += [8, 9, 10, 12, 13].includes(code) ? 1 : 5
    else if (code >= 0xd800 && code <= 0xdfff) {
      if (
        code <= 0xdbff &&
        index + 1 < value.length &&
        value.charCodeAt(index + 1) >= 0xdc00 &&
        value.charCodeAt(index + 1) <= 0xdfff
      )
        index++
      else bytes += 3
    }
  }
  return bytes
}
/** Inspect descriptors before copying. No getters, toJSON, or caller arrays run. */
export function plainCopy<T>(
  value: T,
  maxBytes: number,
  depth = 32,
  elements = 16384,
): T {
  let bytes = 0,
    count = 0
  const seen = new Set<object>()
  const charge = (size: number) => {
    bytes += size
    invariant(bytes <= maxBytes, 'cursor_value_bytes')
  }
  const walk = (input: unknown, level: number): unknown => {
    invariant(++count <= elements && level <= depth, 'cursor_value_shape')
    if (input === undefined || input === null || typeof input === 'boolean') {
      charge(5)
      return input
    }
    if (typeof input === 'string') {
      invariant(input.length <= maxBytes, 'cursor_value_bytes')
      charge(jsonStringBytes(input))
      return input
    }
    if (typeof input === 'number') {
      invariant(Number.isFinite(input), 'cursor_value_number')
      charge(24)
      return input
    }
    invariant(
      typeof input === 'object' && !types.isProxy(input) && !seen.has(input),
      'cursor_value_shape',
    )
    const prototype = Object.getPrototypeOf(input)
    invariant(
      prototype === Object.prototype ||
        prototype === null ||
        (Array.isArray(input) && prototype === Array.prototype),
      'cursor_value_shape',
    )
    seen.add(input)
    const output: Record<string, unknown> | unknown[] = Array.isArray(input)
      ? []
      : {}
    const keys = Reflect.ownKeys(input)
    invariant(keys.length <= elements - count + 1, 'cursor_value_shape')
    for (const key of keys) {
      if (Array.isArray(input) && key === 'length') continue
      invariant(
        typeof key === 'string' &&
          key !== '__proto__' &&
          key !== 'constructor' &&
          key !== 'prototype',
        'cursor_value_shape',
      )
      const descriptor = Object.getOwnPropertyDescriptor(input, key)!
      invariant(
        'value' in descriptor && descriptor.enumerable,
        'cursor_value_accessor',
      )
      charge(jsonStringBytes(key) + 2)
      Object.defineProperty(output, key, {
        value: walk(descriptor.value, level + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    seen.delete(input)
    return Object.freeze(output)
  }
  return walk(value, 0) as T
}
export function boundedId(
  value: unknown,
  limit = 256,
): asserts value is string {
  invariant(
    typeof value === 'string' &&
      value.length > 0 &&
      Buffer.byteLength(value) <= limit &&
      !/[\x00-\x1f\x7f]/.test(value),
    'cursor_invalid_id',
  )
}
export class CursorResources {
  private readonly used = new Map<string, number>()
  private readonly containers = new Map<
    string,
    { grant: CursorServiceGrant; release: () => void }
  >()
  private readonly scans = new Map<
    string,
    { pending: number; chain: Promise<unknown> }
  >()
  scan<T>(
    key: string,
    limits: CursorLimits,
    operation: () => Promise<T>,
  ): Promise<T> {
    let state = this.scans.get(key)
    if (!state) {
      state = { pending: 0, chain: Promise.resolve() }
      this.scans.set(key, state)
    }
    invariant(state.pending < limits.storeOperations, 'cursor_scan_queue_limit')
    state.pending++
    const work = state.chain.then(async () => {
      const release = this.charge('scans', 1, limits.scans)
      try {
        return await operation()
      } finally {
        release()
      }
    })
    state.chain = work.catch(() => {})
    return work.finally(() => {
      if (--state!.pending === 0) this.scans.delete(key)
    })
  }
  requireCapacity(key: string, amount: number, maximum: number) {
    invariant(
      (this.used.get(key) ?? 0) + amount <= maximum,
      'cursor_resource_limit',
    )
  }
  charge(key: string, amount: number, maximum: number) {
    invariant(
      Number.isSafeInteger(amount) &&
        amount >= 0 &&
        (this.used.get(key) ?? 0) + amount <= maximum,
      'cursor_resource_limit',
    )
    this.used.set(key, (this.used.get(key) ?? 0) + amount)
    let released = false
    return () => {
      if (!released) {
        released = true
        this.used.set(key, this.used.get(key)! - amount)
      }
    }
  }
  snapshot() {
    return Object.fromEntries(this.used)
  }
  reconcileDirty(paths: ReadonlyMap<string, CursorServiceGrant>) {
    for (const [path, grant] of paths) {
      const prior = this.containers.get(path)
      if (prior) {
        invariant(
          Object.entries(grant).every(
            ([key, value]) =>
              prior.grant[key as keyof CursorServiceGrant] === value,
          ),
          'cursor_lease_grant_changed',
        )
      } else {
        // Restored ownership can already exceed a newly reduced ceiling.
        // Record every original charge; new admission uses current ceilings.
        const releases = Object.entries({ containers: 1, ...grant }).map(
          ([key, amount]) => this.charge(key, amount, Number.MAX_SAFE_INTEGER),
        )
        this.containers.set(path, {
          grant,
          release: () => releases.forEach((release) => release()),
        })
      }
    }
  }
  reserveContainer(path: string, limits: CursorLimits) {
    invariant(!this.containers.has(path), 'cursor_writer_lease_busy')
    const grant = serviceGrant(limits)
    const releases: Array<() => void> = []
    try {
      releases.push(this.charge('containers', 1, limits.containers))
      releases.push(
        this.charge(
          'storeOperations',
          grant.storeOperations,
          limits.globalStoreOperations,
        ),
      )
      releases.push(
        this.charge(
          'storeInputBytes',
          grant.storeInputBytes,
          limits.globalStoreInputBytes,
        ),
      )
      releases.push(this.charge('scans', grant.scans, limits.scans))
    } catch (error) {
      releases.forEach((release) => release())
      throw error
    }
    this.containers.set(path, {
      grant,
      release: () => releases.forEach((release) => release()),
    })
    return () => this.releaseContainer(path)
  }
  releaseContainer(path: string) {
    const lease = this.containers.get(path)
    if (lease) {
      lease.release()
      this.containers.delete(path)
    }
  }
}
export function createCursorResources() {
  return new CursorResources()
}
