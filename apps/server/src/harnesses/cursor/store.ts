import { constants } from 'node:fs'
import { open, lstat, realpath, rename, mkdir } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { types } from 'node:util'
import { join, relative, resolve, dirname } from 'node:path'
import type { LocalAgentStore, LocalAgentDocument } from '@cursor/sdk'
import {
  CursorError,
  invariant,
  plainCopy,
  boundedId,
  type CursorLimits,
  CursorResources,
} from './limits.js'
import type { CursorReservation } from './contracts.js'
import { boundedEntries } from './scan.js'

const files = {
  agents: 'agents.ndjson',
  runs: 'runs.ndjson',
  runEvents: 'run_events.ndjson',
  checkpoints: 'checkpoints.ndjson',
} as const
type Surface = keyof typeof files
type Row = Record<string, unknown>
type Inventory = {
  rows: Record<Surface, Row[]>
  sizes: Record<Surface, number>
  total: number
}
const terminal = (status: unknown) =>
  ['finished', 'error', 'cancelled', 'expired'].includes(String(status))
const hash = (value: Uint8Array) =>
  createHash('sha256').update(value).digest('hex')
const equal = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right)
export async function boundedRead(
  path: string,
  maximum: number,
  ownerOnly = false,
): Promise<Buffer> {
  const before = await lstat(path)
  invariant(
    before.isFile() && !before.isSymbolicLink() && before.size <= maximum,
    'cursor_file_invalid',
  )
  if (ownerOnly)
    invariant(
      before.uid === process.getuid?.() && (before.mode & 0o077) === 0,
      'cursor_file_permissions',
    )
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const initial = await file.stat()
    invariant(
      initial.dev === before.dev &&
        initial.ino === before.ino &&
        initial.size === before.size &&
        initial.mode === before.mode &&
        initial.uid === before.uid &&
        initial.mtimeMs === before.mtimeMs &&
        initial.ctimeMs === before.ctimeMs,
      'cursor_file_changed',
    )
    const bytes = Buffer.alloc(initial.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      )
      if (!bytesRead) break
      offset += bytesRead
    }
    const after = await file.stat()
    const named = await lstat(path)
    invariant(
      offset === initial.size &&
        after.ino === initial.ino &&
        after.size === initial.size &&
        after.mtimeMs === initial.mtimeMs &&
        after.ctimeMs === initial.ctimeMs &&
        named.ino === initial.ino &&
        named.dev === initial.dev &&
        named.size === initial.size &&
        named.mtimeMs === initial.mtimeMs &&
        named.ctimeMs === initial.ctimeMs &&
        named.mode === initial.mode &&
        named.uid === initial.uid,
      'cursor_file_changed',
    )
    return bytes.subarray(0, offset)
  } finally {
    await file.close()
  }
}
export function parseRawJsonl(bytes: Uint8Array, limits: CursorLimits): Row[] {
  invariant(bytes.byteLength <= limits.fileBytes, 'cursor_store_file_limit')
  let text: string
  try {
    text = new TextDecoder('utf8', { fatal: true }).decode(bytes)
  } catch {
    throw new CursorError('cursor_store_utf8')
  }
  const rows: Row[] = []
  for (let start = 0; start < text.length;) {
    const newline = text.indexOf('\n', start),
      end = newline < 0 ? text.length : newline,
      line = text.slice(start, end)
    start = end + 1
    if (!line.trim()) continue
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      throw new CursorError('cursor_store_corrupt_json')
    }
    invariant(
      row && typeof row === 'object' && !Array.isArray(row),
      'cursor_store_row',
    )
    rows.push(
      plainCopy(
        row,
        limits.fileBytes,
        limits.jsonDepth,
        limits.jsonElements,
      ) as Row,
    )
    invariant(
      rows.length <=
        Math.max(limits.runEvents, limits.checkpoints, limits.runs),
      'cursor_store_row_limit',
    )
  }
  return rows
}
export function validateRows(
  rows: Inventory['rows'],
  cwd: string,
  limits: CursorLimits,
  coherent = false,
  deletingAgent?: string,
) {
  for (const surface of Object.keys(files) as Surface[])
    invariant(rows[surface].length <= limits[surface], 'cursor_store_row_limit')
  const agents = new Map<string, Row>(),
    runs = new Map<string, Row>(),
    checkpoints = new Map<string, Row>()
  const timestamp = (value: unknown) =>
    invariant(
      Number.isSafeInteger(value) && Number(value) >= 0,
      'cursor_store_timestamp',
    )
  for (const row of rows.agents) {
    boundedId(row.agentId)
    invariant(
      !agents.has(row.agentId) &&
        row.cwd === cwd &&
        ['idle', 'running', 'error', 'archived'].includes(String(row.status)),
      'cursor_store_agent',
    )
    timestamp(row.createdAt)
    timestamp(row.updatedAt)
    invariant(
      row.name == null || typeof row.name === 'string',
      'cursor_store_agent',
    )
    if (row.activeRunId != null) boundedId(row.activeRunId)
    invariant(
      row.sdkMetadata == null ||
        (typeof row.sdkMetadata === 'object' &&
          !Array.isArray(row.sdkMetadata)),
      'cursor_store_metadata',
    )
    agents.set(row.agentId, row)
  }
  const turns = new Set<number>()
  for (const row of rows.runs) {
    boundedId(row.runId)
    boundedId(row.agentId)
    invariant(
      agents.has(row.agentId) &&
        !runs.has(row.runId) &&
        Number.isSafeInteger(row.turnNumber) &&
        Number(row.turnNumber) > 0 &&
        !turns.has(Number(row.turnNumber)),
      'cursor_store_run',
    )
    invariant(
      [
        'queued',
        'running',
        'finished',
        'error',
        'cancelled',
        'expired',
      ].includes(String(row.status)),
      'cursor_store_status',
    )
    timestamp(row.createdAt)
    timestamp(row.updatedAt)
    if (row.model != null) {
      invariant(
        typeof row.model === 'object' && !Array.isArray(row.model),
        'cursor_store_model',
      )
      const model = row.model as Row
      boundedId(model.id)
      if (model.params !== undefined) {
        invariant(
          Array.isArray(model.params) &&
            model.params.length <= limits.parameters,
          'cursor_store_model',
        )
        const ids = new Set()
        for (const parameter of model.params) {
          invariant(
            parameter && typeof parameter === 'object',
            'cursor_store_model',
          )
          boundedId(parameter.id, 128)
          invariant(
            typeof parameter.value === 'string' &&
              Buffer.byteLength(parameter.value) <= 256,
            'cursor_store_model',
          )
          invariant(!ids.has(parameter.id), 'cursor_store_model')
          ids.add(parameter.id)
        }
      }
    }
    if (row.usage != null) {
      invariant(
        typeof row.usage === 'object' && !Array.isArray(row.usage),
        'cursor_store_usage',
      )
      const usage = row.usage as Row
      for (const key of [
        'inputTokens',
        'outputTokens',
        'cacheReadTokens',
        'cacheWriteTokens',
        'totalTokens',
      ])
        timestamp(usage[key])
      if (usage.reasoningTokens !== undefined) timestamp(usage.reasoningTokens)
    }
    for (const name of ['startedAt', 'endedAt'])
      if (row[name] != null) timestamp(row[name])
    for (const name of ['requestId', 'usageRef'])
      if (row[name] != null) boundedId(row[name])
    for (const name of ['result', 'error'])
      invariant(
        row[name] == null || typeof row[name] === 'string',
        'cursor_store_run',
      )
    turns.add(Number(row.turnNumber))
    runs.set(row.runId, row)
  }
  for (const row of rows.checkpoints) {
    boundedId(row.agentId)
    invariant(
      agents.has(row.agentId) &&
        typeof row.blobId === 'string' &&
        /^[a-f0-9]{64}$/.test(row.blobId) &&
        typeof row.dataBase64 === 'string',
      'cursor_store_checkpoint',
    )
    const key = `${row.agentId}:${row.blobId}`
    invariant(
      !checkpoints.has(key) &&
        row.dataBase64.length <= Math.ceil(limits.checkpointBytes / 3) * 4,
      'cursor_store_checkpoint',
    )
    const bytes = Buffer.from(row.dataBase64, 'base64')
    invariant(
      bytes.length <= limits.checkpointBytes &&
        bytes.toString('base64') === row.dataBase64 &&
        hash(bytes) === row.blobId,
      'cursor_store_checkpoint_hash',
    )
    checkpoints.set(key, row)
  }
  const reference = (agentId: unknown, value: unknown) => {
    if (value == null) return
    invariant(
      value && typeof value === 'object' && !Array.isArray(value),
      'cursor_store_reference',
    )
    const ref = value as Row
    invariant(
      ref.schemaVersion === 1 &&
        (checkpoints.has(`${agentId}:${ref.rootBlobId}`) ||
          (!coherent && deletingAgent === agentId && rows.runs.length === 0)),
      'cursor_store_reference',
    )
  }
  for (const row of rows.agents) {
    reference(row.agentId, row.latestCheckpoint)
    if (row.activeRunId != null)
      invariant(
        runs.get(String(row.activeRunId))?.agentId === row.agentId,
        'cursor_store_active_run',
      )
  }
  for (const row of rows.runs) {
    reference(row.agentId, row.startCheckpointRef)
    reference(row.agentId, row.latestCheckpointRef)
  }
  const offsets = new Set<string>()
  for (const row of rows.runEvents) {
    boundedId(row.runId)
    boundedId(row.eventType)
    invariant(
      runs.has(row.runId) &&
        Number.isSafeInteger(row.seq) &&
        Number(row.seq) > 0 &&
        row.offset === String(row.seq),
      'cursor_store_event',
    )
    const key = `${row.runId}:${row.seq}`
    invariant(!offsets.has(key), 'cursor_store_event_duplicate')
    offsets.add(key)
    invariant(
      typeof row.createdAt === 'string' &&
        new Date(row.createdAt).toISOString() === row.createdAt,
      'cursor_store_event_timestamp',
    )
    invariant(
      'payload' in row && 'payloadRef' in row && 'idempotencyKey' in row,
      'cursor_store_event',
    )
    for (const name of ['payloadRef', 'idempotencyKey'])
      if (row[name] != null) boundedId(row[name])
  }
  const active = rows.runs.filter((row) => !terminal(row.status))
  invariant(active.length <= 1, 'cursor_store_active_run')
  if (coherent) {
    const agent = rows.agents[0]
    invariant(
      !agent ||
        (active.length === 0
          ? agent.activeRunId == null
          : agent.activeRunId === active[0].runId),
      'cursor_store_incoherent',
    )
    if (agent && rows.runs.length && active.length === 0) {
      const latest = [...rows.runs].sort(
        (a, b) => Number(b.turnNumber) - Number(a.turnNumber),
      )[0]
      invariant(
        equal(
          agent.latestCheckpoint ?? null,
          latest.latestCheckpointRef ?? null,
        ),
        'cursor_store_incoherent',
      )
    }
  }
}
export async function inspectRawStore(
  directory: string,
  cwd: string,
  limits: CursorLimits,
  coherent = false,
  deletingAgent?: string,
): Promise<Inventory> {
  const entries = await boundedEntries(directory, 4)
  invariant(entries.length <= 4, 'cursor_store_unknown_file')
  for (const entry of entries)
    invariant(
      entry.isFile() &&
        Object.values(files).includes(entry.name as (typeof files)[Surface]),
      'cursor_store_unknown_file',
    )
  const rows = {} as Inventory['rows'],
    sizes = {} as Inventory['sizes']
  let total = 0
  for (const surface of Object.keys(files) as Surface[]) {
    const bytes = await boundedRead(
      join(directory, files[surface]),
      limits.fileBytes,
    ).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return Buffer.alloc(0)
      throw error
    })
    total += bytes.length
    invariant(total <= limits.committedBytes, 'cursor_store_total_limit')
    sizes[surface] = bytes.length
    rows[surface] = parseRawJsonl(bytes, limits)
  }
  validateRows(rows, cwd, limits, coherent, deletingAgent)
  return { rows, sizes, total }
}
const REVISION = Symbol('Cursor store revision')
type Revision = {
  leaseId: string
  rowKind: 'agents' | 'runs'
  rowId: string
  revision: number
}
export class CursorStore implements LocalAgentStore {
  readonly agents: LocalAgentStore['agents']
  readonly runs: LocalAgentStore['runs']
  readonly runEvents: LocalAgentStore['runEvents']
  readonly checkpoints: LocalAgentStore['checkpoints']
  private chain: Promise<unknown> = Promise.resolve()
  private admitted = 0
  private retained = 0
  private failure?: Error
  private revisions = new Map<string, number>()
  private revisionBytes = 0
  private initial?: LocalAgentDocument
  private initialRun?: string
  private initialException = false
  private revoked = false
  private deletingAgent?: string
  private attempt?: { id: string; newRun: boolean; runId?: string }
  readonly leaseId = randomUUID()
  constructor(
    readonly directory: string,
    readonly cwd: string,
    private readonly underlying: LocalAgentStore,
    private readonly resources: CursorResources,
    private readonly limits: CursorLimits,
    readonly creating: boolean,
  ) {
    const surface = (name: Surface) =>
      Object.fromEntries(
        (name === 'runEvents'
          ? ['append', 'list', 'delete']
          : ['get', 'create', 'update', 'delete', 'list']
        ).map((operation) => [
          operation,
          (input: unknown) => this.invoke(name, operation, input),
        ]),
      )
    this.agents = surface('agents') as unknown as LocalAgentStore['agents']
    this.runs = surface('runs') as unknown as LocalAgentStore['runs']
    this.runEvents = surface(
      'runEvents',
    ) as unknown as LocalAgentStore['runEvents']
    this.checkpoints = surface(
      'checkpoints',
    ) as unknown as LocalAgentStore['checkpoints']
  }
  get error() {
    return this.failure
  }
  revoke() {
    this.revoked = true
    this.initialException = false
  }
  beginAttempt(id: string) {
    boundedId(id, this.limits.idBytes)
    invariant(!this.attempt && !this.revoked, 'cursor_store_attempt_busy')
    this.attempt = { id, newRun: true }
  }
  endAttempt() {
    this.attempt = undefined
    this.initialException = false
  }
  async drain(coherent = true) {
    return this.invoke(
      'agents',
      coherent ? 'drain-coherent' : 'drain',
      undefined,
    ) as Promise<Inventory>
  }
  private tag<T>(surface: Surface, value: T): T {
    if (value == null || (surface !== 'agents' && surface !== 'runs'))
      return value
    const row = value as Row
    if (Array.isArray(row.items))
      return {
        ...row,
        items: row.items.map((item) => this.tag(surface, item)),
      } as T
    const id = String(surface === 'agents' ? row.agentId : row.runId)
    const key = `${surface}:${id}`
    const revision = this.revisions.get(key) ?? 1
    this.rememberRevision(key, revision)
    return Object.assign({}, row, {
      [REVISION]: Object.freeze({
        leaseId: this.leaseId,
        rowKind: surface,
        rowId: id,
        revision,
      }),
    }) as T
  }
  private rememberRevision(key: string, revision: number) {
    if (!this.revisions.has(key)) {
      const bytes = Buffer.byteLength(key)
      invariant(
        this.revisions.size < this.limits.owners &&
          this.revisionBytes + bytes <= this.limits.ownerBytes,
        'cursor_store_revision_limit',
      )
      this.revisionBytes += bytes
    }
    this.revisions.set(key, revision)
  }
  private invoke(
    surface: Surface,
    operation: string,
    input: unknown,
  ): Promise<unknown> {
    let releases: Array<() => void> = []
    try {
      // Descriptor checks precede all caller property reads, including typed checkpoint data.
      invariant(
        input === undefined ||
          (input !== null &&
            typeof input === 'object' &&
            !types.isProxy(input) &&
            Object.getPrototypeOf(input) === Object.prototype),
        'cursor_store_input',
      )
      const original: Record<string, unknown> | undefined =
        input === undefined ? undefined : {}
      for (const key of Reflect.ownKeys(input ?? {})) {
        invariant(typeof key === 'string', 'cursor_store_input')
        const descriptor = Object.getOwnPropertyDescriptor(input!, key)!
        invariant(
          'value' in descriptor && descriptor.enumerable,
          'cursor_value_accessor',
        )
        Object.defineProperty(original!, key, { ...descriptor })
      }
      const rawRow =
        surface === 'agents'
          ? original?.agent
          : surface === 'runs'
            ? original?.run
            : undefined
      invariant(
        rawRow === undefined ||
          (rawRow !== null &&
            typeof rawRow === 'object' &&
            !types.isProxy(rawRow) &&
            Object.getPrototypeOf(rawRow) === Object.prototype),
        'cursor_store_input',
      )
      const tokenDescriptor =
        rawRow && Object.getOwnPropertyDescriptor(rawRow, REVISION)
      invariant(
        !tokenDescriptor ||
          ('value' in tokenDescriptor && tokenDescriptor.enumerable),
        'cursor_value_accessor',
      )
      const token =
        rawRow && typeof rawRow === 'object'
          ? (Object.getOwnPropertyDescriptor(rawRow, REVISION)?.value as
              Revision | undefined)
          : undefined
      let clean = input
      if (rawRow && typeof rawRow === 'object') {
        const descriptors = Object.getOwnPropertyDescriptors(rawRow)
        delete descriptors[REVISION as unknown as string]
        clean = {
          ...original,
          [surface === 'agents' ? 'agent' : 'run']: Object.defineProperties(
            {},
            descriptors,
          ),
        }
      }
      invariant(!types.isProxy(original?.data), 'cursor_store_input')
      if (surface === 'checkpoints' && original?.data instanceof Uint8Array) {
        invariant(
          original.data.byteLength <= this.limits.checkpointBytes,
          'cursor_checkpoint_input_limit',
        )
        clean = { ...original, data: undefined }
      }
      const captured = plainCopy(clean, this.limits.storeInputBytes) as
        Row | undefined
      const bytes =
        Buffer.byteLength(JSON.stringify(captured) ?? 'null') +
        (original?.data instanceof Uint8Array ? original.data.byteLength : 0)
      invariant(
        this.admitted < this.limits.storeOperations &&
          this.retained + bytes <= this.limits.storeInputBytes,
        'cursor_store_queue_limit',
      )
      releases.push(
        this.resources.charge(
          'storeOperations',
          1,
          this.limits.globalStoreOperations,
        ),
      )
      releases.push(
        this.resources.charge(
          'storeInputBytes',
          bytes,
          this.limits.globalStoreInputBytes,
        ),
      )
      const data =
        original?.data instanceof Uint8Array
          ? Buffer.from(original.data)
          : undefined
      const argument = data ? { ...captured, data } : captured
      this.admitted++
      this.retained += bytes
      const work = this.chain.then(async () => {
        const mutation = !['get', 'list', 'drain', 'drain-coherent'].includes(
          operation,
        )
        try {
          if (operation.startsWith('drain') && this.failure) throw this.failure
          if (operation === 'drain-coherent')
            invariant(!this.deletingAgent, 'cursor_store_deletion_incomplete')
          if (mutation) {
            if (this.failure) throw this.failure
            invariant(!this.revoked, 'cursor_store_revoked')
          }
          const inventory = await this.resources.scan(
            dirname(this.directory),
            this.limits,
            () =>
              inspectRawStore(
                this.directory,
                this.cwd,
                this.limits,
                operation === 'drain-coherent',
                this.deletingAgent,
              ),
          )
          if (operation.startsWith('drain')) return inventory
          if (mutation)
            this.checkMutation(
              surface,
              operation,
              argument ?? {},
              token,
              inventory,
            )
          const affected: Surface[] =
            surface === 'runs' && operation === 'delete'
              ? ['runs', 'runEvents']
              : [surface]
          let projected = 0,
            committed = inventory.total
          if (mutation) {
            const rows = this.project(
              surface,
              operation,
              argument ?? {},
              inventory,
            )
            validateRows(rows, this.cwd, this.limits, false, this.deletingAgent)
            for (const name of affected) {
              const rewritten = rows[name].reduce(
                (sum, row) => sum + Buffer.byteLength(JSON.stringify(row)) + 1,
                0,
              )
              committed += rewritten - inventory.sizes[name]
              // runs.delete rewrites events once per deleted run. Its first rewrite can be larger than the final file.
              const temporary =
                surface === 'runs' &&
                operation === 'delete' &&
                name === 'runEvents'
                  ? Math.max(rewritten, inventory.sizes.runEvents)
                  : rewritten
              invariant(
                temporary <= this.limits.fileBytes,
                'cursor_store_file_limit',
              )
              projected += temporary
            }
            invariant(
              committed <= this.limits.committedBytes,
              'cursor_store_total_limit',
            )
          }
          invariant(
            inventory.total + projected <= this.limits.physicalStoreBytes,
            'cursor_store_temporary_limit',
          )
          const releaseWrite = this.resources.charge(
            `storeTemporary:${this.directory}`,
            projected,
            this.limits.physicalStoreBytes,
          )
          try {
            const api = this.underlying[surface] as unknown as Record<
              string,
              (input: unknown) => Promise<unknown>
            >
            const result = await api[operation](argument)
            if (mutation) {
              const folder = await open(this.directory, 'r')
              try {
                await folder.sync()
              } finally {
                await folder.close()
              }
              if (surface === 'agents' && operation === 'delete')
                this.deletingAgent = undefined
              await this.resources.scan(
                dirname(this.directory),
                this.limits,
                () =>
                  inspectRawStore(
                    this.directory,
                    this.cwd,
                    this.limits,
                    false,
                    this.deletingAgent,
                  ),
              )
              const row = (argument?.agent ?? argument?.run) as Row | undefined
              if (row) {
                const key = `${surface}:${surface === 'agents' ? row.agentId : row.runId}`
                this.rememberRevision(
                  key,
                  operation === 'create'
                    ? 1
                    : (this.revisions.get(key) ?? 1) + 1,
                )
              }
            }
            releaseWrite()
            return this.tag(surface, result)
          } catch (error) {
            // Keep the temporary reservation when the physical write outcome is unknown.
            if (!mutation) releaseWrite()
            throw error
          }
        } catch (error) {
          this.failure ??=
            error instanceof Error
              ? error
              : new CursorError('cursor_store_failed')
          throw this.failure
        }
      })
      this.chain = work.catch(() => {})
      return work.finally(() => {
        this.admitted--
        this.retained -= bytes
        for (const release of releases) release()
      })
    } catch (error) {
      for (const release of releases) release()
      this.failure ??=
        error instanceof Error ? error : new CursorError('cursor_store_failed')
      return Promise.reject(this.failure)
    }
  }
  private project(
    surface: Surface,
    operation: string,
    input: Row,
    inventory: Inventory,
  ): Inventory['rows'] {
    const rows = { ...inventory.rows, [surface]: [...inventory.rows[surface]] }
    const filter = (input.filter ?? {}) as {
      agentIds?: string[]
      runIds?: string[]
      blobIds?: string[]
      cwd?: string
    }
    const matches = (row: Row) =>
      (!filter.agentIds?.length ||
        filter.agentIds.includes(String(row.agentId))) &&
      (!filter.runIds?.length || filter.runIds.includes(String(row.runId))) &&
      (!filter.blobIds?.length ||
        filter.blobIds.includes(String(row.blobId))) &&
      (filter.cwd === undefined || row.cwd === filter.cwd)
    if (operation === 'delete') {
      if (surface === 'runs') {
        const ids = new Set(rows.runs.filter(matches).map((row) => row.runId))
        rows.runEvents = rows.runEvents.filter((row) => !ids.has(row.runId))
      }
      rows[surface] = rows[surface].filter((row) => !matches(row))
      return rows
    }
    if (surface === 'runEvents') {
      if (
        input.idempotencyKey &&
        rows.runEvents.some(
          (row) =>
            row.runId === input.runId &&
            row.idempotencyKey === input.idempotencyKey,
        )
      )
        return rows
      const seq =
        rows.runEvents
          .filter((row) => row.runId === input.runId)
          .reduce((max, row) => Math.max(max, Number(row.seq)), 0) + 1
      rows.runEvents.push({
        runId: input.runId,
        seq,
        offset: String(seq),
        eventType: input.eventType,
        payload: input.payload ?? null,
        payloadRef: input.payloadRef ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        createdAt: new Date().toISOString(),
      })
      return rows
    }
    const row =
      surface === 'checkpoints'
        ? {
            agentId: input.agentId,
            blobId: input.blobId,
            dataBase64: Buffer.from(input.data as Uint8Array).toString(
              'base64',
            ),
          }
        : ((input.agent ?? input.run) as Row)
    const id = (row: Row) =>
      surface === 'agents'
        ? row.agentId
        : surface === 'runs'
          ? row.runId
          : `${row.agentId}:${row.blobId}`
    if (operation === 'create') rows[surface].push(row)
    else {
      const index = rows[surface].findIndex((value) => id(value) === id(row))
      invariant(index >= 0, 'cursor_store_missing_row')
      rows[surface][index] = row
    }
    return rows
  }
  private checkMutation(
    surface: Surface,
    operation: string,
    input: Row,
    token: Revision | undefined,
    inventory: Inventory,
  ) {
    if (this.deletingAgent)
      invariant(operation === 'delete', 'cursor_store_deletion_incomplete')
    if (operation === 'delete') {
      invariant(
        inventory.rows.runs.every((row) => terminal(row.status)),
        'cursor_store_active_delete',
      )
      const filter = input.filter as
        | { agentIds?: string[]; runIds?: string[]; blobIds?: string[] }
        | undefined
      if (
        surface === 'runs' &&
        filter?.agentIds?.length === 1 &&
        !filter.runIds?.length &&
        inventory.rows.agents.some(
          (agent) =>
            agent.agentId === filter.agentIds![0] && agent.activeRunId == null,
        )
      )
        this.deletingAgent = filter.agentIds[0]
      if (this.deletingAgent && surface !== 'runEvents')
        invariant(
          filter?.agentIds?.length === 1 &&
            filter.agentIds[0] === this.deletingAgent &&
            !filter.runIds?.length &&
            !filter.blobIds?.length,
          'cursor_store_deletion_owner',
        )
      if (this.deletingAgent && surface === 'agents')
        invariant(
          !inventory.rows.runs.length &&
            !inventory.rows.runEvents.length &&
            !inventory.rows.checkpoints.length,
          'cursor_store_deletion_order',
        )
      return
    }
    if (surface === 'checkpoints') {
      boundedId(input.agentId)
      invariant(
        inventory.rows.agents.some((row) => row.agentId === input.agentId),
        'cursor_store_foreign_agent',
      )
      invariant(
        input.data instanceof Uint8Array && hash(input.data) === input.blobId,
        'cursor_store_checkpoint_hash',
      )
      const previous = inventory.rows.checkpoints.find(
        (row) => row.agentId === input.agentId && row.blobId === input.blobId,
      )
      if (operation === 'create') invariant(!previous, 'cursor_store_duplicate')
      if (previous)
        invariant(
          previous.dataBase64 === Buffer.from(input.data).toString('base64'),
          'cursor_store_checkpoint_immutable',
        )
      return
    }
    if (surface === 'runEvents') {
      invariant(
        inventory.rows.runs.some((row) => row.runId === input.runId),
        'cursor_store_foreign_run',
      )
      return
    }
    const row = (surface === 'agents' ? input.agent : input.run) as Row
    invariant(row && typeof row === 'object', 'cursor_store_row')
    const id = surface === 'agents' ? row.agentId : row.runId
    boundedId(id)
    const previous = inventory.rows[surface].find(
      (candidate) =>
        (surface === 'agents' ? candidate.agentId : candidate.runId) === id,
    )
    if (operation === 'create') {
      invariant(!previous, 'cursor_store_duplicate')
      this.rememberRevision(`${surface}:${id}`, 1)
      if (surface === 'agents') {
        invariant(
          this.creating &&
            !this.initial &&
            inventory.rows.agents.length === 0 &&
            row.cwd === this.cwd,
          'cursor_store_foreign_agent',
        )
        this.initial = row as unknown as LocalAgentDocument
        this.initialException = true
      } else {
        invariant(
          this.attempt?.newRun &&
            inventory.rows.agents.some(
              (agent) => agent.agentId === row.agentId,
            ) &&
            inventory.rows.runs.every((run) => terminal(run.status)) &&
            row.status === 'queued',
          'cursor_store_foreign_run',
        )
        this.attempt.newRun = false
        this.attempt.runId = id
        if (this.initialException) this.initialRun = id
      }
      return
    }
    invariant(previous, 'cursor_store_missing_row')
    const revision = this.revisions.get(`${surface}:${id}`) ?? 1
    const initialAllowed =
      surface === 'agents' &&
      !token &&
      this.creating &&
      this.initialException &&
      revision === 1 &&
      row.activeRunId === this.initialRun &&
      equal(
        { ...row, activeRunId: null, updatedAt: this.initial?.updatedAt },
        this.initial,
      )
    if (initialAllowed) this.initialException = false
    else
      invariant(
        token?.leaseId === this.leaseId &&
          token.rowKind === surface &&
          token.rowId === id &&
          token.revision === revision,
        'cursor_store_revision_conflict',
      )
    for (const key of surface === 'agents'
      ? ['agentId', 'cwd', 'createdAt', 'sdkMetadata']
      : ['runId', 'agentId', 'createdAt', 'turnNumber', 'startCheckpointRef'])
      invariant(equal(previous[key], row[key]), 'cursor_store_immutable')
    if (surface === 'runs') {
      if (terminal(previous.status)) {
        for (const key of Object.keys({ ...previous, ...row }))
          if (key !== 'usage')
            invariant(
              equal(previous[key], row[key]),
              'cursor_store_terminal_conflict',
            )
        invariant(
          previous.usage == null || equal(previous.usage, row.usage),
          'cursor_store_terminal_conflict',
        )
      } else
        invariant(
          !(previous.status === 'running' && row.status === 'queued'),
          'cursor_store_status_regression',
        )
    } else {
      if (row.activeRunId != null) {
        const run = inventory.rows.runs.find(
          (run) => run.runId === row.activeRunId,
        )
        invariant(
          run && run.agentId === row.agentId && !terminal(run.status),
          'cursor_store_active_run',
        )
      } else if (previous.activeRunId != null)
        invariant(
          terminal(
            inventory.rows.runs.find(
              (run) => run.runId === previous.activeRunId,
            )?.status,
          ),
          'cursor_store_active_run',
        )
    }
  }
}
export async function writeMarker(
  path: string,
  value: unknown,
  limits: CursorLimits,
  exclusive = false,
) {
  const snapshot = plainCopy(value, limits.markerBytes)
  const bytes = Buffer.from(JSON.stringify(snapshot) + '\n')
  invariant(bytes.length <= limits.markerBytes, 'cursor_marker_limit')
  const temporary = exclusive ? path : `${path}.${randomUUID()}.tmp`
  const file = await open(temporary, 'wx', 0o600)
  try {
    await file.writeFile(bytes)
    await file.sync()
  } finally {
    await file.close()
  }
  if (!exclusive) await rename(temporary, path)
  const directory = await open(dirname(path), 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}
export async function reservationDirectory(
  stateRoot: string,
  reservation: CursorReservation,
  limits: CursorLimits,
  create = false,
) {
  invariant(
    reservation.storeRelativePath ===
      `sessions/${reservation.creationOwner.storeId}/sdk` &&
      /^[a-f0-9-]{36}$/.test(reservation.creationOwner.storeId),
    'cursor_store_path',
  )
  const path = resolve(stateRoot, reservation.storeRelativePath)
  invariant(
    relative(stateRoot, path) === reservation.storeRelativePath,
    'cursor_store_path',
  )
  if (create) {
    await mkdir(join(stateRoot, 'sessions'), { recursive: true, mode: 0o700 })
    await mkdir(dirname(path), { mode: 0o700 })
    await mkdir(path, { mode: 0o700 })
    await mkdir(join(dirname(path), 'native-data'), { mode: 0o700 })
    await writeMarker(
      join(dirname(path), 'manifest.json'),
      reservation,
      limits,
      true,
    )
  }
  invariant((await realpath(path)) === path, 'cursor_store_path')
  const manifest = JSON.parse(
    (
      await boundedRead(
        join(dirname(path), 'manifest.json'),
        limits.markerBytes,
        true,
      )
    ).toString('utf8'),
  )
  invariant(
    manifest.reservationId === reservation.reservationId &&
      equal(manifest.creationOwner, reservation.creationOwner),
    'cursor_store_owner',
  )
  return path
}
