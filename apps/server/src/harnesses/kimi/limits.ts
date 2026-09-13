/** Kimi 0.34.0 adapter ceilings. Overrides may only reduce these values. */
export const kimiLimitCeilings = Object.freeze({
  hostHomes: 4,
  hostProcesses: 8,
  hostStartups: 2,
  hostHelpers: 4,
  hostGuardians: 4,
  hostSessions: 8,
  hostLockUtilities: 2,
  homeServers: 1,
  homeSessions: 4,
  homeHelpers: 2,
  homeWaiters: 0,
  homeResidentSessions: 64,
  hostResidentSessions: 128,
  lockRegistryEntries: 4096,
  lockRegistryBytes: 2097152,
  lockRecordBytes: 4096,
  guardianControlMs: 5000,
  ipcMessageBytes: 8388608,
  ipcBufferedBytes: 16777216,
  hostIpcBytes: 33554432,
  ipcFrames: 200000,
  ipcTotalBytes: 268435456,
  ipcMediaChunkBytes: 65536,
  startupMs: 20000,
  startupAttempts: 3,
  startupReads: 32,
  startupBytes: 4194304,
  tokenBytes: 128,
  tokenReadAttempts: 2,
  stdoutBytes: 1048576,
  stderrTailBytes: 16384,
  stderrBytes: 1048576,
  hostHttp: 16,
  runtimeHttp: 4,
  httpQueue: 0,
  httpMs: 15000,
  httpHeaderBytes: 16384,
  httpHeaders: 64,
  httpJsonBytes: 8388608,
  httpControlBytes: 1048576,
  httpRequestsPerGeneration: 4096,
  httpResponseBytesPerGeneration: 268435456,
  hostHttpBufferBytes: 33554432,
  jsonDepth: 32,
  schemaJsonDepth: 64,
  jsonNodes: 50000,
  jsonStringBytes: 4194304,
  runtimeSockets: 2,
  hostSockets: 16,
  wsMessageBytes: 1048576,
  wsFragments: 1024,
  wsBufferedChunks: 1024,
  wsOutboundBytes: 262144,
  wsInboundBytes: 268435456,
  wsFrames: 200000,
  pendingControls: 8,
  controlIdBytes: 128,
  controlMs: 5000,
  controlTombstones: 256,
  controlTombstoneBytes: 65536,
  reconnectAttempts: 3,
  reconnectMs: 20000,
  recoveries: 8,
  recoveryReads: 64,
  recoveryBytes: 33554432,
  recoveryMs: 30000,
  replayFrames: 1024,
  replayBytes: 8388608,
  orphanFrames: 128,
  orphanBytes: 1048576,
  transcriptBatchOps: 512,
  transcriptCatchupBatches: 1024,
  pageTurns: 20,
  historyPages: 64,
  historyBytes: 33554432,
  historyMs: 30000,
  pageMessages: 20,
  messagePages: 64,
  messageBytes: 33554432,
  messageMs: 30000,
  cursorBytes: 1024,
  cursorEntries: 128,
  cursorStateBytes: 131072,
  nativeIdBytes: 512,
  forgeIdBytes: 256,
  ownerEntries: 8192,
  ownerBytes: 4194304,
  duplicateEntries: 4096,
  duplicateBytes: 1048576,
  retainedTurns: 128,
  retainedItems: 8192,
  retainedBytes: 16777216,
  hostRetainedBytes: 67108864,
  retainedItemBytes: 4194304,
  toolValueBytes: 262144,
  toolItems: 1024,
  children: 64,
  childDepth: 8,
  childSubscriptions: 65,
  childOwnerTombstones: 256,
  childOwnerBytes: 262144,
  promptReceipts: 33,
  nativeQueuedPrompts: 32,
  promptInputParts: 64,
  promptTextBytes: 1048576,
  queuedTextBytes: 4194304,
  promptTerminalEntries: 256,
  interactions: 64,
  interactionBytes: 1048576,
  replyBytes: 262144,
  questionItems: 4,
  questionOptions: 4,
  questionTextBytes: 65536,
  interactionTombstones: 512,
  interactionTombstoneBytes: 262144,
  models: 512,
  modelCatalogBytes: 1048576,
  modelIdBytes: 512,
  attachmentsPerPrompt: 8,
  attachmentBytes: 16777216,
  promptAttachmentBytes: 33554432,
  hostAttachmentLoads: 4,
  runtimeAttachmentLoads: 1,
  hostAttachmentBytes: 67108864,
  attachmentMs: 15000,
  nativeFileIds: 256,
  nativeFileIdBytes: 262144,
  sinkCalls: 4,
  sinkBatchBytes: 8388608,
  sinkBatchRecords: 512,
  sinkMs: 15000,
  stateReadBytes: 4194304,
  stateReadOwners: 8192,
  stateReadRequests: 64,
  nativeRecords: 100000,
  nativeRecordBytes: 268435456,
  publishedEvents: 50000,
  publishedBytes: 134217728,
  diagnostics: 256,
  diagnosticBytes: 262144,
  diagnosticMessageBytes: 4096,
  diagnosticDetailBytes: 16384,
  timers: 32,
  hostTimers: 128,
  shutdownMs: 5000,
})

export type KimiLimits = { [K in keyof typeof kimiLimitCeilings]: number }
export type LimitKey = keyof KimiLimits

/** Guardians own reserved shares. HTTP operations receive separate host grants. */
export function guardianLimits(limits: Readonly<KimiLimits>) {
  const divisor = 2 * limits.hostGuardians
  return kimiLimits({
    ...limits,
    hostIpcBytes: Math.max(
      1,
      Math.floor(limits.hostIpcBytes / (limits.hostGuardians + 1)),
    ),
    hostTimers: Math.max(1, Math.floor(limits.hostTimers / divisor)),
    hostRetainedBytes: Math.max(
      1,
      Math.floor(limits.hostRetainedBytes / divisor),
    ),
  })
}

export class KimiError extends Error {
  constructor(
    readonly code: string,
    message = code,
    readonly uncertain = false,
  ) {
    super(message)
    this.name = 'KimiError'
  }
}

export function kimiLimits(
  overrides: Partial<KimiLimits> = {},
): Readonly<KimiLimits> {
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(kimiLimitCeilings, key))
      throw new KimiError('kimi_unknown_limit')
    const maximum = kimiLimitCeilings[key as LimitKey]
    if (
      !Number.isSafeInteger(value) ||
      (maximum === 0 ? value !== 0 : value! < 1 || value! > maximum)
    )
      throw new KimiError('kimi_invalid_limit', `Invalid Kimi limit: ${key}`)
  }
  return Object.freeze({ ...kimiLimitCeilings, ...overrides })
}

export function sequence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new KimiError('kimi_invalid_sequence')
  return value
}

export function boundedString(
  value: unknown,
  bytes: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && !value) ||
    value.length > bytes ||
    Buffer.byteLength(value) > bytes
  )
    throw new KimiError('kimi_string_limit')
  return value
}

/** Counts physical occupancy or cumulative work. Only the physical owner releases a charge. */
export class KimiBudget {
  private readonly used = new Map<LimitKey, number>()
  constructor(readonly limits: Readonly<KimiLimits>) {}
  count(key: LimitKey) {
    return this.used.get(key) ?? 0
  }
  add(key: LimitKey, amount = 1) {
    const next = this.count(key) + amount
    if (
      !Number.isSafeInteger(amount) ||
      amount < 0 ||
      !Number.isSafeInteger(next) ||
      next > this.limits[key]
    )
      throw new KimiError('kimi_resource_limit', `Kimi limit reached: ${key}`)
    this.used.set(key, next)
  }
  reserve(key: LimitKey, amount = 1): () => void {
    this.add(key, amount)
    let held = true
    return () => {
      if (held) {
        held = false
        this.used.set(key, this.count(key) - amount)
      }
    }
  }
}

export function reserveAll(
  charges: readonly (readonly [KimiBudget, LimitKey, number?])[],
): () => void {
  const release: (() => void)[] = []
  try {
    for (const [budget, key, amount] of charges)
      release.push(budget.reserve(key, amount))
  } catch (error) {
    release.reverse().forEach((end) => end())
    throw error
  }
  return () =>
    release
      .splice(0)
      .reverse()
      .forEach((end) => end())
}

/** Logical timeout does not settle the callback or release its physical admission. */
export async function boundedCallback<T>(
  budget: KimiBudget,
  key: LimitKey,
  ms: number,
  signal: AbortSignal,
  work: () => Promise<T>,
): Promise<T> {
  signal.throwIfAborted()
  const release = budget.reserve(key)
  const physical = Promise.resolve().then(work).finally(release)
  return deadline(physical, ms, signal)
}

export async function deadline<T>(
  physical: Promise<T>,
  ms: number,
  signal?: AbortSignal,
  runtime?: KimiBudget,
  host?: KimiBudget,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  const release = reserveAll([
    ...(runtime ? [[runtime, 'timers'] as [KimiBudget, LimitKey]] : []),
    ...(host ? [[host, 'hostTimers'] as [KimiBudget, LimitKey]] : []),
  ])
  try {
    signal?.throwIfAborted()
    return await Promise.race([
      physical,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new KimiError('kimi_deadline')), ms)
        abort = () => reject(new KimiError('kimi_cancelled'))
        signal?.addEventListener('abort', abort, { once: true })
      }),
    ])
  } finally {
    clearTimeout(timer)
    if (abort) signal?.removeEventListener('abort', abort)
    release()
  }
}

/** Preflight structured values before cloning, hashing, or serializing them. */
export function jsonBytes(
  value: unknown,
  limits: Readonly<KimiLimits>,
  maximum: number,
): number {
  let bytes = 0,
    nodes = 0
  const ancestors = new Set<object>()
  const visit = (entry: unknown, depth: number) => {
    if (++nodes > limits.jsonNodes || depth > limits.jsonDepth)
      throw new KimiError('kimi_json_limit')
    if (typeof entry === 'string') {
      boundedString(entry, limits.jsonStringBytes, true)
      bytes += 2
      for (const character of entry) {
        const code = character.charCodeAt(0)
        bytes += ['\b', '\f', '\n', '\r', '\t', '"', '\\'].includes(character)
          ? 2
          : code < 32 ||
              (character.length === 1 && code >= 0xd800 && code <= 0xdfff)
            ? 6
            : Buffer.byteLength(character)
      }
    } else if (
      entry === null ||
      typeof entry === 'boolean' ||
      typeof entry === 'number'
    ) {
      if (typeof entry === 'number' && !Number.isFinite(entry))
        throw new KimiError('kimi_json_value')
      bytes += String(entry).length
    } else if (typeof entry === 'object') {
      if (ancestors.has(entry)) throw new KimiError('kimi_json_cycle')
      ancestors.add(entry)
      bytes += 2
      let count = 0
      if (Array.isArray(entry))
        for (const item of entry) {
          if (count++) bytes++
          visit(item, depth + 1)
        }
      else
        for (const [key, item] of Object.entries(entry)) {
          if (item === undefined) continue
          if (count++) bytes++
          visit(key, depth + 1)
          bytes++
          visit(item, depth + 1)
        }
      ancestors.delete(entry)
    } else throw new KimiError('kimi_json_value')
    if (bytes > maximum) throw new KimiError('kimi_json_bytes')
  }
  visit(value, 0)
  return bytes
}
