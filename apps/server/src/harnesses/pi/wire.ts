import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { JsonlTransport } from '../jsonl.js'

export const MiB = 1024 * 1024
export class PiError extends Error {
  constructor(
    readonly code: string,
    message: string = code,
  ) {
    super(message)
    this.name = 'PiError'
  }
}
export function fail(code: string, message?: string): never {
  throw new PiError(code, message)
}
export function check(signal: AbortSignal) {
  if (signal.aborted) fail('PI_CANCELLED')
}
export function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value))
}
export function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
  return value
}
/** Copy plain values once. Undefined own properties retain removal semantics. */
export function snapshot<T>(value: T, limit = 2 * MiB): T {
  let total = 0
  let keys = 0
  const seen = new Set<object>()
  const copy = (item: unknown, depth: number): unknown => {
    if (depth > 24 || ++keys > 200_000) fail('PI_VALUE_LIMIT')
    if (typeof item === 'string') {
      total += Buffer.byteLength(item)
      if (total > limit) fail('PI_VALUE_LIMIT')
      return item
    }
    if (item == null || typeof item === 'boolean') return item
    if (typeof item === 'number' && Number.isFinite(item)) return item
    if (typeof item !== 'object') fail('PI_INVALID_VALUE')
    if (seen.has(item)) fail('PI_INVALID_VALUE')
    seen.add(item)
    let result: unknown
    if (Array.isArray(item))
      result = item.map((entry) => copy(entry, depth + 1))
    else {
      const proto = Object.getPrototypeOf(item)
      if (proto !== Object.prototype && proto !== null) fail('PI_INVALID_VALUE')
      const record: Record<string, unknown> = Object.create(null)
      for (const key of Object.keys(item)) {
        total += Buffer.byteLength(key)
        if (total > limit) fail('PI_VALUE_LIMIT')
        record[key] = copy((item as Record<string, unknown>)[key], depth + 1)
      }
      result = record
    }
    seen.delete(item)
    return result
  }
  return freeze(copy(value, 0)) as T
}
export const text = (max = 64 * 1024) =>
  z.string().refine((v) => Buffer.byteLength(v) <= max)
export const id = text(256).min(1)
export const count = z.number().int().nonnegative()
export const inert = z.unknown().transform((v) => snapshot(v, MiB))
export const mode = z.enum(['all', 'one-at-a-time'])
export const modelSchema = z.object({
  id: text(1024).min(1),
  provider: text(1024).min(1),
  name: text().optional(),
  reasoning: z.boolean().optional(),
  input: z
    .array(z.enum(['text', 'image']))
    .max(2)
    .optional(),
  contextWindow: count.optional(),
  maxTokens: count.optional(),
  cost: z
    .object({
      input: z.number().nonnegative(),
      output: z.number().nonnegative(),
      cacheRead: z.number().nonnegative(),
      cacheWrite: z.number().nonnegative(),
    })
    .optional(),
})
export const stateSchema = z.object({
  sessionId: id,
  sessionFile: text(16 * 1024).min(1),
  model: modelSchema.optional(),
  thinkingLevel: text(128),
  isStreaming: z.boolean(),
  isCompacting: z.boolean(),
  steeringMode: mode,
  followUpMode: mode,
  sessionName: text().optional(),
  autoCompactionEnabled: z.boolean(),
  messageCount: count,
  pendingMessageCount: count.max(128),
})
export const commandSchema = z.object({
  name: text().min(1),
  description: text().optional(),
  source: z.enum(['extension', 'prompt', 'skill']),
  sourceInfo: z
    .object({
      source: text().optional(),
      scope: text().optional(),
      origin: text().optional(),
      path: text().optional(),
    })
    .optional(),
})
export const responseSchema = z.strictObject({
  type: z.literal('response'),
  id: id.optional(),
  command: text(256),
  success: z.boolean(),
  data: z.unknown().optional(),
  error: text().optional(),
})
export type PiResponse = z.infer<typeof responseSchema>
export type PiCommand =
  | 'prompt'
  | 'steer'
  | 'follow_up'
  | 'abort'
  | 'get_state'
  | 'get_available_models'
  | 'get_available_thinking_levels'
  | 'get_commands'
  | 'set_model'
  | 'set_thinking_level'
  | 'set_steering_mode'
  | 'set_follow_up_mode'
const responseData = {
  get_state: stateSchema,
  get_available_models: z.strictObject({
    models: z.array(modelSchema).max(4096),
  }),
  get_available_thinking_levels: z.strictObject({
    levels: z.array(text(128)).max(32),
  }),
  get_commands: z.strictObject({ commands: z.array(commandSchema).max(1024) }),
  set_model: modelSchema,
}
export function decodeResponse(value: unknown): PiResponse {
  const r = responseSchema.parse(value)
  if (!r.success) {
    if (!r.error || r.data !== undefined) fail('PI_MALFORMED_RESPONSE')
  } else {
    if (r.error !== undefined) fail('PI_MALFORMED_RESPONSE')
    if (Object.hasOwn(responseData, r.command))
      r.data = responseData[r.command as keyof typeof responseData].parse(
        r.data,
      )
    else if (r.data !== undefined) fail('PI_MALFORMED_RESPONSE')
  }
  return freeze(r)
}

export type PiLimits = {
  startupMs: number
  commandMs: number
  operationMs: number
  sinkMs: number
  fileMs: number
  maxCommands: number
  maxPendingCommands: number
  maxUnknownIds: number
  maxUnknownTypes: number
  maxReceipts: number
  maxQuestions: number
  maxRequestIds: number
  maxRecordQueue: number
  maxRecordBytes: number
  maxLineBytes: number
  maxOutboundBytes: number
  maxOutboundFrames: number
  maxItems: number
  maxTools: number
  maxContentBytes: number
  maxBlockBytes: number
  operationPublications: number
  operationPublicationBytes: number
  idlePublications: number
  idlePublicationBytes: number
  generationPublications: number
  generationPublicationBytes: number
  importPublications: number
  importPublicationBytes: number
  importMs: number
}
export const defaultLimits: Readonly<PiLimits> = freeze({
  startupMs: 15_000,
  commandMs: 30_000,
  operationMs: 7_200_000,
  sinkMs: 10_000,
  fileMs: 5_000,
  maxCommands: 4096,
  maxPendingCommands: 16,
  maxUnknownIds: 32,
  maxUnknownTypes: 64,
  maxReceipts: 1024,
  maxQuestions: 16,
  maxRequestIds: 1024,
  maxRecordQueue: 32,
  maxRecordBytes: 8 * MiB,
  maxLineBytes: 40 * MiB,
  maxOutboundBytes: 48 * MiB,
  maxOutboundFrames: 64,
  maxItems: 4096,
  maxTools: 1024,
  maxContentBytes: 16 * MiB,
  maxBlockBytes: 4 * MiB,
  operationPublications: 16_384,
  operationPublicationBytes: 128 * MiB,
  idlePublications: 4096,
  idlePublicationBytes: 32 * MiB,
  generationPublications: 131_072,
  generationPublicationBytes: 512 * MiB,
  importPublications: 100_000,
  importPublicationBytes: 256 * MiB,
  importMs: 1_800_000,
})
export function limits(input: Partial<PiLimits> = {}): Readonly<PiLimits> {
  const result = { ...defaultLimits, ...snapshot(input) }
  for (const [key, value] of Object.entries(result))
    if (
      !Number.isSafeInteger(value) ||
      value <= 0 ||
      value > defaultLimits[key as keyof PiLimits]
    )
      fail('PI_INVALID_LIMIT')
  return freeze(result)
}
export class PublicationBudget {
  private count = 0
  private bytes = 0
  constructor(
    readonly countLimit: number,
    readonly byteLimit: number,
  ) {}
  static charge(size: number, ...budgets: PublicationBudget[]) {
    for (const budget of budgets)
      if (
        budget.count + 1 > budget.countLimit ||
        budget.bytes + size > budget.byteLimit
      )
        fail('PI_PUBLICATION_LIMIT')
    for (const budget of budgets) {
      budget.count++
      budget.bytes += size
    }
  }
}
type WorkClass = 'attachment' | 'image' | 'sink' | 'history' | 'resume' | 'file'
const classLimits: Record<WorkClass, { count: number; bytes: number }> = {
  attachment: { count: 2, bytes: 64 * MiB },
  image: { count: 2, bytes: 65 * MiB },
  sink: { count: 2, bytes: 8 * MiB },
  history: { count: 1, bytes: 48 * MiB },
  resume: { count: 1, bytes: 33 * MiB },
  file: { count: 3, bytes: 128 * MiB },
}
// This object belongs to the module, never to a factory or runtime generation.
const physical = {
  count: 0,
  bytes: 0,
  countLimit: 8,
  byteLimit: 256 * MiB,
  classes: { attachment: 0, image: 0, sink: 0, history: 0, resume: 0, file: 0 },
}
export function physicalState() {
  return { ...physical, classes: { ...physical.classes } }
}
export function physicalTestLimits(countLimit = 8, byteLimit = 256 * MiB) {
  if (physical.count) fail('PI_PHYSICAL_WORK_ACTIVE')
  if (
    countLimit <= 0 ||
    countLimit > 8 ||
    byteLimit <= 0 ||
    byteLimit > 256 * MiB
  )
    fail('PI_INVALID_LIMIT')
  physical.countLimit = countLimit
  physical.byteLimit = byteLimit
}
export function reservePhysical(
  kind: WorkClass,
  size = classLimits[kind].bytes,
): () => void {
  if (
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > classLimits[kind].bytes ||
    physical.classes[kind] >= classLimits[kind].count ||
    physical.count >= physical.countLimit ||
    physical.bytes + size > physical.byteLimit
  )
    fail('PI_PHYSICAL_WORK_CAPACITY')
  physical.count++
  physical.classes[kind]++
  physical.bytes += size
  let released = false
  return () => {
    if (released) return
    released = true
    physical.count--
    physical.classes[kind]--
    physical.bytes -= size
  }
}
/** Logical abort never releases a physical token. The real operation owns release. */
export function physicalWork<T>(
  kind: WorkClass,
  signal: AbortSignal,
  ms: number,
  callback: () => Promise<T>,
  size?: number,
): Promise<T> {
  check(signal)
  const release = reservePhysical(kind, size)
  let actual: Promise<T>
  try {
    actual = Promise.resolve(callback())
  } catch (error) {
    release()
    return Promise.reject(error)
  }
  const held = actual.finally(release)
  return waitOwned(held, signal, ms)
}
export function waitOwned<T>(
  actual: Promise<T>,
  signal: AbortSignal,
  ms: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let ended = false
    const finish = (error?: unknown, value?: T) => {
      if (ended) return
      ended = true
      clearTimeout(timer)
      signal.removeEventListener('abort', aborted)
      if (error) reject(error)
      else resolve(value as T)
    }
    const aborted = () => finish(new PiError('PI_CANCELLED'))
    const timer = setTimeout(() => finish(new PiError('PI_DEADLINE')), ms)
    signal.addEventListener('abort', aborted, { once: true })
    actual.then(
      (value) => finish(undefined, value),
      (error) => finish(error),
    )
    if (signal.aborted) aborted()
  })
}
export function deferred<T>() {
  let resolve!: (value: T) => void
  let resolved = false
  const promise = new Promise<T>((done) => {
    resolve = (value) => {
      if (!resolved) {
        resolved = true
        done(value)
      }
    }
  })
  return {
    promise,
    resolve,
    get resolved() {
      return resolved
    },
  }
}
type Pending = {
  command: PiCommand
  resolve: (r: PiResponse) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
  expire: () => void
  started: number
  remaining: number
  pausedAt?: number
  humanMs: number
}
export class PiRouter {
  private readonly commandPrefix: string
  private serial = 0
  private unknown = 0
  private reason?: Error
  private pending = new Map<string, Pending>()
  private retired = new Map<string, { command: string; digest?: string }>()
  constructor(
    generation: string,
    private readonly transport: JsonlTransport,
    private readonly config: Readonly<PiLimits>,
    private readonly fatal: (error: Error) => void,
  ) {
    this.commandPrefix = createHash('sha256')
      .update(id.parse(generation))
      .digest('hex')
  }
  request(
    command: PiCommand,
    data: Record<string, unknown> = {},
    urgent = false,
    onSend?: () => void,
    onWritten?: () => void,
  ): Promise<PiResponse> {
    if (this.reason) return Promise.reject(this.reason)
    if (
      this.serial >= this.config.maxCommands ||
      this.pending.size >= this.config.maxPendingCommands + (urgent ? 4 : 0)
    )
      return Promise.reject(new PiError('PI_CONTROL_CAPACITY'))
    const commandId = id.parse(`pi:${this.commandPrefix}:${this.serial + 1}`)
    this.serial++
    return new Promise((resolve, reject) => {
      const expire = () => {
        const error = new PiError('PI_COMMAND_DELIVERY_UNKNOWN')
        this.close(error)
        this.fatal(error)
      }
      const timer = setTimeout(expire, this.config.commandMs)
      this.pending.set(commandId, {
        command,
        resolve,
        reject,
        timer,
        expire,
        started: performance.now(),
        remaining: this.config.commandMs,
        humanMs: 0,
      })
      let frame: Record<string, unknown>
      let size: number
      try {
        frame = { id: commandId, type: command, ...data }
        size = bytes(frame)
      } catch (error) {
        this.pending.delete(commandId)
        clearTimeout(timer)
        reject(error)
        return
      }
      if (
        size > this.config.maxLineBytes ||
        this.transport.state.queuedFrames >= this.config.maxOutboundFrames ||
        this.transport.state.queuedBytes + size + 1 >
          this.config.maxOutboundBytes
      ) {
        this.pending.delete(commandId)
        clearTimeout(timer)
        reject(new PiError('PI_COMMAND_NOT_SENT'))
        return
      }
      if (this.reason) {
        this.pending.delete(commandId)
        clearTimeout(timer)
        reject(this.reason)
        return
      }
      onSend?.()
      void this.transport
        .send(frame)
        .then(() => onWritten?.())
        .catch(() => {
          const error = new PiError('PI_COMMAND_DELIVERY_UNKNOWN')
          this.close(error)
          this.fatal(error)
        })
    })
  }
  humanWait(waiting: boolean) {
    const now = performance.now()
    for (const p of this.pending.values()) {
      if (p.command !== 'prompt') continue
      if (waiting && p.pausedAt === undefined) {
        p.remaining = Math.max(1, p.remaining - (now - p.started))
        p.pausedAt = now
        clearTimeout(p.timer)
        p.timer = setTimeout(p.expire, Math.max(1, 900_000 - p.humanMs))
      } else if (!waiting && p.pausedAt !== undefined) {
        p.humanMs += now - p.pausedAt
        p.pausedAt = undefined
        p.started = now
        clearTimeout(p.timer)
        p.timer = setTimeout(p.expire, p.remaining)
      }
    }
  }
  receive(value: unknown) {
    if (this.reason) return
    const response = decodeResponse(value)
    if (!response.id) fail('PI_UNCORRELATED_RESPONSE')
    const p = this.pending.get(response.id)
    const digest = createHash('sha256')
      .update(JSON.stringify(response))
      .digest('hex')
    if (!p) {
      const retired = this.retired.get(response.id)
      if (retired) {
        if (
          retired.command !== response.command ||
          (retired.digest && retired.digest !== digest)
        )
          fail('PI_CONTRADICTORY_RESPONSE')
      } else if (++this.unknown > this.config.maxUnknownIds)
        fail('PI_UNKNOWN_RESPONSE_LIMIT')
      return
    }
    if (p.command !== response.command) fail('PI_RESPONSE_COMMAND_MISMATCH')
    this.pending.delete(response.id)
    clearTimeout(p.timer)
    this.retired.set(response.id, { command: response.command, digest })
    p.resolve(response)
  }
  close(error: Error) {
    if (this.reason) return
    this.reason = error
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(error)
    }
    this.pending.clear()
    this.retired.clear()
  }
}
