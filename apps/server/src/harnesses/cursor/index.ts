import { closeNativeDiscovery } from '../native-cleanup.js'
import { randomUUID, createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { mkdir, lstat, open, unlink } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import {
  harnessEventSchema,
  type TerminalOutcome,
} from '@forge/protocol/harness'
import type { ModelListItem, ModelSelection, RunResult } from '@cursor/sdk'
import {
  createCompletionHandle,
  type HarnessAdapter,
  type HarnessHandle,
  type HarnessReceipt,
  type HarnessSession,
  type HarnessEvent,
  type CompletionResult,
} from '../types.js'
import { captureLaunch, captureSession, type CursorLaunch } from './launch.js'
import {
  CursorContainer,
  retireRecordedContainer,
  type ContainerIdentity,
} from './container.js'
import {
  cursorLimits,
  CursorError,
  invariant,
  plainCopy,
  boundedId,
  createCursorResources,
} from './limits.js'
import {
  captureInput,
  cursorMessage,
  inputDigest,
  validateModel,
  validateCatalog,
  modelConfig,
  cursorPolicy,
} from './input.js'
import { reservationDirectory, inspectRawStore, boundedRead } from './store.js'
import { scanNativeData } from './scan.js'
import { inventoryTransaction, writeInventoryMarker } from './inventory.js'
import type {
  CursorAdapterOptions,
  CursorOwner,
  CursorReservation,
  CursorNativeRecord,
  CursorNativeEnvelope,
  CursorReadiness,
  CursorCatalogState,
} from './contracts.js'
import type { CursorFrame } from './wire.js'
export { createCursorResources }
export type * from './contracts.js'
export { CursorError } from './limits.js'
export const cursorDescriptor = Object.freeze({
  providerKey: 'cursor',
  selection: 'pending-cutover',
  sdkVersion: '1.0.28',
  platform: 'linux-x64',
  nodeMajor: 24,
  limits: [
    'No permission or question replies',
    'No live steering',
    'No deeper child stream, standalone await, child usage, or all child shell events',
    'Root tool exclusions do not prove child behavior',
    'Native disk scans are observed thresholds',
  ],
})
const capabilities = Object.freeze({
  loadSession: true,
  queue: true,
  cancel: true,
  models: true,
  steer: false,
  permissions: false,
  questions: false,
})
type Work = {
  owner: CursorOwner
  input?: ReturnType<typeof captureInput>
  receipt: HarnessReceipt
  settle: (result: CompletionResult) => void
  abort: AbortController
  deadline: number
  preparationDeadline?: number
  phase: 'queued' | 'preparing' | 'running' | 'persisting' | 'committed'
  release: () => void
  result?: RunResult
  resolveResult?: (result: RunResult) => void
  rejectResult?: (error: Error) => void
  nativeResult?: Promise<RunResult>
  physical?: Promise<void>
  finished: boolean
  lastNativePosition: number
}
type OwnerEvidence = Pick<Work, 'owner' | 'finished' | 'lastNativePosition'>
const neverAborted = () => new AbortController().signal
async function readReservation(
  options: CursorAdapterOptions,
  sessionId: string,
) {
  const limits = cursorLimits(options.limits)
  const release = options.resources.charge('callbacks', 1, limits.callbacks)
  try {
    return plainCopy(
      await options.sink.readSession(sessionId, neverAborted()),
      limits.markerBytes,
    )
  } finally {
    release()
  }
}
export function discoverCursor(
  options: Omit<CursorAdapterOptions, 'sink' | 'loadAttachment'>,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ readiness: CursorReadiness; catalog: CursorCatalogState }> {
  signal?.throwIfAborted()
  const limits = cursorLimits(options.limits),
    launch = captureLaunch(options.selected, options.stateRoot, limits)
  invariant(cwd === realpathSync(cwd), 'cursor_session_authority')
  const storeId = randomUUID(),
    generation = randomUUID(),
    owner: CursorOwner = {
      forgeSessionId: `cursor-helper:${storeId}`,
      provider: launch.selected.provider,
      accountId: launch.selected.account.id,
      cwd,
      storeId,
      generation,
      attemptId: randomUUID(),
      runId: randomUUID(),
      turnId: randomUUID(),
    }
  const directory = join(launch.stateRoot, 'helpers', storeId),
    sdk = join(directory, 'sdk')
  return (async () => {
    await inventoryTransaction(
      options.resources,
      launch.stateRoot,
      limits,
      async (inventory) => {
        await mkdir(join(launch.stateRoot, 'helpers'), {
          recursive: true,
          mode: 0o700,
        })
        await mkdir(directory, { mode: 0o700 })
        await mkdir(sdk, { mode: 0o700 })
        await mkdir(join(directory, 'native-data'), { mode: 0o700 })
        await writeInventoryMarker(
          join(directory, 'manifest.json'),
          { version: 1, kind: 'discovery', owner },
          inventory,
          limits,
          true,
        )
      },
    )
    const container = new CursorContainer(
      launch,
      owner,
      sdk,
      options.resources,
      limits,
      () => {
        throw new CursorError('cursor_discovery_unexpected_event')
      },
      undefined,
      true,
    )
    let readiness: CursorReadiness = {
      sdk: 'ready',
      auth:
        launch.selected.credential.type === 'api-key'
          ? 'configured-unverified'
          : 'stored-unverified',
      store: 'new',
      processContainer: 'not-started',
      localRuntime: 'not-started',
      sandbox: 'not-checked',
    }
    let catalog: CursorCatalogState = { status: 'unloaded', items: [] }
    const abort = () => {
      void container.close().catch(() => {})
    }
    try {
      const ready = await container.start()
      signal?.throwIfAborted()
      signal?.addEventListener('abort', abort, { once: true })
      readiness = ready.readiness as CursorReadiness
      try {
        const response = await container.wire!.request('models')
        catalog = {
          status: 'ready',
          items: validateCatalog(response.items as ModelListItem[], limits),
        }
      } catch {
        catalog = {
          status: 'failed',
          items: [],
          error: {
            code: 'cursor_catalog_failed',
            message: 'Cursor model discovery failed',
          },
        }
      }
      signal?.throwIfAborted()
      return { readiness, catalog }
    } finally {
      signal?.removeEventListener('abort', abort)
      await closeNativeDiscovery(async () => {
        await container.close()
        await rm(directory, { recursive: true, force: true })
      })
    }
  })()
}

export async function inspectCursorReservation(
  options: CursorAdapterOptions,
  sessionId: string,
) {
  const limits = cursorLimits(options.limits),
    launch = captureLaunch(options.selected, options.stateRoot, limits)
  const reservation = await readReservation(options, sessionId)
  if (!reservation)
    return {
      reservation: null,
      available: false,
      code: 'cursor_reservation_missing',
    }
  invariant(
    reservation.creationOwner.forgeSessionId === sessionId &&
      reservation.creationOwner.provider === launch.selected.provider &&
      reservation.creationOwner.accountId === launch.selected.account.id,
    'cursor_reservation_authority',
  )
  const directory = await reservationDirectory(
    launch.stateRoot,
    reservation,
    limits,
  )
  const inventory = await options.resources.scan(
    dirname(directory),
    limits,
    () => inspectRawStore(directory, reservation.creationOwner.cwd, limits),
  )
  const dirty = await lstat(join(dirname(directory), 'writer-fence.json')).then(
    () => true,
    (error) => {
      if (error.code === 'ENOENT') return false
      throw error
    },
  )
  return {
    reservation,
    rows: Object.fromEntries(
      Object.entries(inventory.rows).map(([name, rows]) => [name, rows.length]),
    ),
    available: reservation.state === 'native-confirmed' && !dirty,
    ambiguous: reservation.state !== 'native-confirmed' || dirty,
    dirty,
  }
}
export async function recoverCursorReservation(
  options: CursorAdapterOptions,
  sessionId: string,
) {
  const limits = cursorLimits(options.limits),
    launch = captureLaunch(options.selected, options.stateRoot, limits)
  const reservation = await readReservation(options, sessionId)
  invariant(
    reservation &&
      reservation.creationOwner.forgeSessionId === sessionId &&
      reservation.creationOwner.provider === launch.selected.provider &&
      reservation.creationOwner.accountId === launch.selected.account.id,
    'cursor_recovery_reservation',
  )
  const directory = await reservationDirectory(
      launch.stateRoot,
      reservation,
      limits,
    ),
    fence = join(dirname(directory), 'writer-fence.json')
  return inventoryTransaction(
    options.resources,
    launch.stateRoot,
    limits,
    async (inventory) => {
      const row = JSON.parse(
        (await boundedRead(fence, limits.markerBytes, true)).toString('utf8'),
      )
      invariant(
        row.state === 'dirty' &&
          row.owner.storeId === reservation.creationOwner.storeId &&
          row.owner.forgeSessionId === sessionId &&
          row.owner.provider === reservation.creationOwner.provider &&
          row.owner.accountId === reservation.creationOwner.accountId &&
          row.owner.cwd === reservation.creationOwner.cwd,
        'cursor_recovery_fence',
      )
      const identity = plainCopy(
        row.identity,
        limits.markerBytes,
      ) as ContainerIdentity
      invariant(
        identity.generation === row.owner.generation,
        'cursor_recovery_fence',
      )
      const proof = await retireRecordedContainer(identity, limits)
      await writeInventoryMarker(
        `${fence}.retired`,
        { identity, proof, pipesClosed: true, recovery: true },
        inventory,
        limits,
      )
      await unlink(fence)
      const folder = await open(dirname(fence), 'r')
      try {
        await folder.sync()
      } finally {
        await folder.close()
      }
      options.resources.releaseContainer(fence)
      // Recovery retires the writer. It grants neither first-send privilege nor a fresh create.
      const raw = await options.resources.scan(dirname(directory), limits, () =>
        inspectRawStore(directory, reservation.creationOwner.cwd, limits, true),
      )
      return {
        retired: true,
        proof,
        agentId: raw.rows.agents[0]?.agentId ?? null,
        activeRunAmbiguous: raw.rows.runs.some((run) =>
          ['queued', 'running'].includes(String(run.status)),
        ),
      }
    },
  )
}
export function createCursorAdapter(
  options: CursorAdapterOptions,
): HarnessAdapter {
  // This capture precedes promises, ownership allocation, and process admission.
  const limits = cursorLimits(options.limits)
  const launch = captureLaunch(options.selected, options.stateRoot, limits)
  const { resources, sink, loadAttachment } = options
  invariant(resources && sink && loadAttachment, 'cursor_dependencies_missing')
  for (const method of [
    'reserve',
    'readSession',
    'confirm',
    'markDirty',
    'appendNative',
    'seal',
    'flush',
  ] as const)
    invariant(typeof sink[method] === 'function', 'cursor_sink_missing')
  const captured: CursorAdapterOptions = Object.freeze({
    selected: launch.selected,
    stateRoot: launch.stateRoot,
    limits,
    resources,
    loadAttachment,
    sink: Object.freeze({
      reserve: sink.reserve.bind(sink),
      readSession: sink.readSession.bind(sink),
      confirm: sink.confirm.bind(sink),
      markDirty: sink.markDirty.bind(sink),
      appendNative: sink.appendNative.bind(sink),
      seal: sink.seal.bind(sink),
      flush: sink.flush.bind(sink),
    }),
  })
  const make = (
    session: HarnessSession,
    emit: (event: HarnessEvent) => void,
    reservation?: CursorReservation,
  ) => new CursorHandle(session, emit, launch, captured, reservation)
  return {
    kind: 'native',
    capabilities,
    spawn(session, emit) {
      return make(captureSession(session, launch), emit)
    },
    async load(sessionIn, emit) {
      const session = captureSession(sessionIn, launch)
      const reservation = await readReservation(captured, session.id)
      invariant(
        reservation?.state === 'native-confirmed' && reservation.record,
        'cursor_resume_unavailable',
      )
      const record = reservation.record
      invariant(
        record.version === 1 &&
          record.sdkVersion === '1.0.28' &&
          record.forgeSessionId === session.id &&
          record.reservationId === reservation.reservationId &&
          record.storeId === reservation.creationOwner.storeId &&
          record.storeRelativePath === reservation.storeRelativePath,
        'cursor_resume_record',
      )
      invariant(
        session.binding &&
          session.binding.provider === record.binding.provider &&
          session.binding.accountId === record.binding.accountId &&
          session.binding.cwd === record.binding.cwd &&
          session.binding.providerSessionId ===
            record.binding.providerSessionId &&
          record.binding.provider === session.provider &&
          record.binding.accountId === session.accountId &&
          record.binding.cwd === session.cwd,
        'cursor_resume_binding',
      )
      const directory = await reservationDirectory(
        launch.stateRoot,
        reservation,
        limits,
      )
      const fence = await lstat(
        join(dirname(directory), 'writer-fence.json'),
      ).then(
        () => true,
        (error) => {
          if (error.code === 'ENOENT') return false
          throw error
        },
      )
      invariant(!fence, 'cursor_resume_dirty')
      const rows = await resources.scan(
        dirname(directory),
        limits,
        async () => {
          const rows = await inspectRawStore(
            directory,
            session.cwd,
            limits,
            true,
          )
          await scanNativeData(join(dirname(directory), 'native-data'), limits)
          return rows
        },
      )
      invariant(
        rows.rows.agents.length === 1 &&
          rows.rows.agents[0].agentId === record.binding.providerSessionId,
        'cursor_resume_agent',
      )
      const key = createHash('sha256')
        .update(
          JSON.stringify([
            record.binding.provider,
            record.binding.accountId,
            record.binding.providerSessionId,
          ]),
        )
        .digest('hex')
      const index = JSON.parse(
        (
          await boundedRead(
            join(launch.stateRoot, 'by-agent', `${key}.json`),
            limits.markerBytes,
            true,
          )
        ).toString('utf8'),
      )
      invariant(
        JSON.stringify(index) === JSON.stringify(record),
        'cursor_resume_index',
      )
      return make(session, emit, reservation)
    },
  }
}
class CursorHandle implements HarnessHandle {
  private confirmed: CursorNativeRecord | null
  private readonly limits
  private generation = randomUUID()
  private storeId: string
  private queue: Work[] = []
  private active?: Work
  private draining = false
  private killed = false
  private container?: CursorContainer
  private directory?: string
  private nativeChain: Promise<unknown> = Promise.resolve()
  private nativeError?: Error
  private model?: ModelSelection
  private catalog: ModelListItem[] = []
  private policy?: string
  private pendingNative = 0
  private nativeBytes = 0
  private totalEvents = 0
  private totalEventBytes = 0
  private tombstones = new Map<string, OwnerEvidence>()
  private physicalWork = new Set<Work>()
  private callbackChain: Promise<unknown> = Promise.resolve()
  private ownerReleases: Array<() => void> = []
  readiness: CursorReadiness = {
    sdk: 'ready',
    auth: 'missing',
    store: 'new',
    processContainer: 'not-started',
    localRuntime: 'not-started',
    sandbox: 'not-checked',
  }
  constructor(
    private readonly session: HarnessSession,
    private readonly emit: (event: HarnessEvent) => void,
    private readonly launch: CursorLaunch,
    private readonly options: CursorAdapterOptions,
    private reservation?: CursorReservation,
  ) {
    this.limits = cursorLimits(options.limits)
    this.storeId = reservation?.creationOwner.storeId ?? randomUUID()
    this.confirmed = reservation?.record ?? null
    if (this.confirmed) this.readiness.store = 'validated'
  }
  get binding() {
    return this.confirmed?.binding ?? null
  }
  get availableModels() {
    return this.catalog.map((item) => ({
      id: item.id,
      displayName: item.displayName,
    }))
  }
  prompt: HarnessHandle['prompt'] = (input, options, identity) => {
    invariant(
      !this.killed && this.queue.length < this.limits.waiting,
      'cursor_queue_unavailable',
    )
    const captured = captureInput(input, options, this.limits)
    this.options.resources.requireCapacity(
      'callbacks',
      1,
      this.limits.callbacks,
    )
    if (this.model && !captured.options.model)
      captured.options = plainCopy(
        {
          ...captured.options,
          model: this.model.id,
          nativeModelParams: this.model.params,
        },
        this.limits.controlBytes,
      )
    const ids = plainCopy(
      identity === undefined
        ? { runId: randomUUID(), turnId: randomUUID() }
        : identity,
      4 * this.limits.idBytes + 64,
    )
    invariant(
      ids &&
        Object.keys(ids).length === 2 &&
        Object.keys(ids).every((key) => key === 'runId' || key === 'turnId'),
      'cursor_prompt_identity',
    )
    boundedId(ids.runId, this.limits.idBytes)
    boundedId(ids.turnId, this.limits.idBytes)
    invariant(!this.tombstones.has(ids.runId), 'cursor_duplicate_run')
    const owner: CursorOwner = Object.freeze({
      forgeSessionId: this.session.id,
      provider: this.session.provider,
      accountId: this.session.accountId!,
      cwd: this.session.cwd,
      storeId: this.storeId,
      generation: this.generation,
      attemptId: randomUUID(),
      runId: ids.runId,
      turnId: ids.turnId,
    })
    invariant(this.tombstones.size < this.limits.owners, 'cursor_owner_limit')
    const releaseText = this.options.resources.charge(
      `queue:${this.session.id}`,
      captured.textBytes,
      this.limits.queuedPromptBytes,
    )
    let releaseImages: () => void
    try {
      releaseImages = this.options.resources.charge(
        `images:${this.session.id}`,
        captured.imageReservation,
        this.limits.queuedWireBytes,
      )
    } catch (error) {
      releaseText()
      throw error
    }
    const completion = createCompletionHandle({
      completionId: randomUUID(),
      ...ids,
    })
    const receipt = {
      receiptId: randomUUID(),
      ...ids,
      completion: completion.handle,
    }
    let resolveResult!: (result: RunResult) => void,
      rejectResult!: (error: Error) => void
    const nativeResult = new Promise<RunResult>((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })
    void nativeResult.catch(() => {})
    let releaseOwner: () => void
    try {
      releaseOwner = this.options.resources.charge(
        `owners:${this.session.id}`,
        Buffer.byteLength(JSON.stringify(owner)),
        this.limits.ownerBytes,
      )
    } catch (error) {
      releaseText()
      releaseImages()
      throw error
    }
    const work: Work = {
      owner,
      input: captured,
      receipt,
      settle: completion.settle,
      abort: new AbortController(),
      deadline: performance.now() + this.limits.turnMs,
      phase: 'queued',
      release: () => {
        // Release payload references before releasing their byte reservations.
        // Cleanup can remain held while the active work stays reachable.
        work.input = undefined
        work.nativeResult = undefined
        work.resolveResult = undefined
        work.rejectResult = undefined
        releaseText()
        releaseImages()
        this.physicalWork.delete(work)
        // Late records need only their original owner and sink position.
        // Never retain the prompt or the settled native-result Promise here.
        this.tombstones.set(work.owner.runId, {
          owner: work.owner,
          finished: work.finished,
          lastNativePosition: work.lastNativePosition,
        })
      },
      resolveResult,
      rejectResult,
      nativeResult,
      finished: false,
      lastNativePosition: -1,
    }
    this.ownerReleases.push(releaseOwner)
    this.tombstones.set(ids.runId, work)
    this.queue.push(work)
    try {
      this.emit({
        type: 'prompt_accepted',
        ...ids,
        receiptId: receipt.receiptId,
        runtimeGeneration: this.generation,
        deliveryId: `${owner.attemptId}:accepted`,
      })
    } catch (error) {
      this.queue.pop()
      this.finish(work, {
        status: 'failed',
        code: 'cursor_ingestion_failed',
        message: 'Prompt ingestion failed',
      })
      throw error
    }
    void this.drain()
    return receipt
  }
  async setModel(modelId: string) {
    this.model = validateModel({ id: modelId }, this.catalog)
  }
  configOptions() {
    return modelConfig(this.model, this.catalog)
  }
  async setConfigOption(id: string, value: string | boolean) {
    invariant(this.model && typeof value === 'string', 'cursor_model_option')
    this.model = validateModel(
      {
        id: this.model.id,
        params: [
          ...(this.model.params ?? []).filter(
            (parameter) => parameter.id !== id,
          ),
          { id, value },
        ],
      },
      this.catalog,
    )
  }
  async replyPermission() {
    throw new CursorError('cursor_permissions_unsupported')
  }
  async replyQuestion() {
    throw new CursorError('cursor_questions_unsupported')
  }
  private current(work: Work) {
    invariant(
      !work.abort.signal.aborted &&
        !this.killed &&
        this.active === work &&
        performance.now() < work.deadline &&
        (work.phase !== 'preparing' ||
          performance.now() < work.preparationDeadline!),
      'cursor_attempt_obsolete',
    )
  }
  private async callback<T>(work: Work, operation: () => Promise<T>) {
    this.current(work)
    const result = await this.physicalCallback(async () => {
      this.current(work)
      return operation()
    })
    this.current(work)
    return result
  }
  private physicalCallback<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.callbackChain.then(async () => {
      const release = this.options.resources.charge(
        'callbacks',
        1,
        this.limits.callbacks,
      )
      try {
        return await operation()
      } finally {
        release()
      }
    })
    this.callbackChain = work.catch(() => {})
    return work
  }
  private async drain() {
    if (this.draining) return
    this.draining = true
    try {
      while (this.queue.length && !this.killed) {
        const work = this.queue.shift()!
        this.active = work
        work.phase = 'preparing'
        work.preparationDeadline = performance.now() + this.limits.preparationMs
        let timer: ReturnType<typeof setTimeout> | undefined
        let preparationTimer: ReturnType<typeof setTimeout> | undefined
        try {
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => {
                work.abort.abort()
                reject(new CursorError('cursor_turn_timeout'))
              },
              Math.max(1, work.deadline - performance.now()),
            )
            preparationTimer = setTimeout(
              () => {
                if (work.phase !== 'preparing') return
                work.abort.abort()
                reject(new CursorError('cursor_preparation_timeout'))
              },
              Math.max(1, work.preparationDeadline! - performance.now()),
            )
          })
          this.physicalWork.add(work)
          work.physical = this.run(work).finally(work.release)
          await Promise.race([work.physical, timeout])
        } catch (error) {
          let code =
            error instanceof CursorError
              ? error.code
              : work.abort.signal.aborted
                ? 'cursor_interrupted'
                : 'cursor_failed'
          if (this.persistenceUnproved(work))
            code = 'cursor_persistence_unknown'
          try {
            await this.container?.close()
          } catch {
            this.readiness.processContainer = 'dirty'
            if (code !== 'cursor_persistence_unknown')
              code = 'cursor_cleanup_failed'
          }
          if (this.reservation)
            void this.physicalCallback(() =>
              this.options.sink.markDirty(
                { owner: work.owner, code },
                neverAborted(),
              ),
            ).catch(() => {})
          this.finish(
            work,
            work.abort.signal.aborted &&
              ![
                'cursor_cleanup_failed',
                'cursor_persistence_unknown',
                'cursor_preparation_timeout',
              ].includes(code)
              ? { status: 'interrupted', reason: code }
              : {
                  status: 'failed',
                  code,
                  message: 'Cursor turn did not complete',
                },
          )
          this.killed = true
        } finally {
          if (timer) clearTimeout(timer)
          if (preparationTimer) clearTimeout(preparationTimer)
          this.active = undefined
        }
      }
    } finally {
      this.draining = false
      if (this.killed)
        for (const work of this.queue.splice(0))
          this.finish(work, {
            status: 'interrupted',
            reason: 'Cursor session stopped',
          })
    }
  }
  private persistenceUnproved(work: Work) {
    return work.phase === 'persisting' || this.pendingNative > 0
  }
  private async run(work: Work) {
    if (work.owner.generation !== this.generation)
      work.owner = Object.freeze({ ...work.owner, generation: this.generation })
    const message = await this.callback(work, () =>
      cursorMessage(
        this.session.id,
        work.input!.parts,
        this.options.loadAttachment,
        work.abort.signal,
        this.limits,
      ),
    )
    if (!this.reservation) {
      const existing = await this.callback(work, () =>
        this.options.sink.readSession(this.session.id, work.abort.signal),
      )
      invariant(existing === null, 'cursor_existing_reservation_ambiguous')
      const candidate: CursorReservation = {
        version: 1,
        reservationId: randomUUID(),
        creationOwner: work.owner,
        sdkVersion: '1.0.28',
        storeRelativePath: `sessions/${this.storeId}/sdk`,
        state: 'reserved',
      }
      await inventoryTransaction(
        this.options.resources,
        this.launch.stateRoot,
        this.limits,
        async (inventory) => {
          invariant(
            inventory.reservations < this.limits.reservations &&
              inventory.bytes + this.limits.markerBytes <=
                this.limits.inventoryBytes,
            'cursor_reservation_limit',
          )
          this.current(work)
          const reservation = plainCopy(
            await this.callback(work, () =>
              this.options.sink.reserve(candidate, work.abort.signal),
            ),
            this.limits.markerBytes,
          )
          invariant(
            JSON.stringify(reservation) === JSON.stringify(candidate),
            'cursor_existing_reservation_ambiguous',
          )
          this.reservation = reservation
          this.directory = await reservationDirectory(
            this.launch.stateRoot,
            reservation,
            this.limits,
            true,
          )
          this.current(work)
          this.reservation = plainCopy(
            await this.callback(work, () =>
              this.options.sink.reserve(
                { ...reservation, state: 'creation-started' },
                work.abort.signal,
              ),
            ),
            this.limits.markerBytes,
          )
          invariant(
            this.reservation.state === 'creation-started',
            'cursor_reservation_state',
          )
          await writeInventoryMarker(
            join(dirname(this.directory!), 'manifest.json'),
            this.reservation,
            inventory,
            this.limits,
          )
        },
      )
    } else if (!this.directory)
      this.directory = await reservationDirectory(
        this.launch.stateRoot,
        this.reservation,
        this.limits,
      )
    this.current(work)
    invariant(this.reservation, 'cursor_reservation_missing')
    const policy = JSON.stringify(cursorPolicy(work.input!.options))
    if (this.container && this.policy !== policy) {
      invariant(this.confirmed, 'cursor_policy_initial_ambiguous')
      await this.container.close()
      this.current(work)
      this.container = undefined
      this.generation = randomUUID()
      work.owner = Object.freeze({ ...work.owner, generation: this.generation })
    }
    this.policy = policy
    if (!this.container) {
      this.container = new CursorContainer(
        this.launch,
        work.owner,
        this.directory!,
        this.options.resources,
        this.limits,
        (frame) => this.frame(frame),
        this.reservation,
        false,
        (error) => this.active?.rejectResult?.(error),
      )
      const ready = await this.container.start()
      this.current(work)
      this.readiness = ready.readiness as CursorReadiness
      const models = await this.container.wire!.request(
        'models',
        {},
        Math.max(
          1,
          Math.min(
            this.limits.controlMs,
            work.preparationDeadline! - performance.now(),
          ),
        ),
      )
      this.current(work)
      this.catalog = validateCatalog(
        models.items as ModelListItem[],
        this.limits,
      )
    }
    const model = validateModel(
      {
        id:
          work.input!.options.model ??
          this.model?.id ??
          this.catalog[0]?.id ??
          '',
        ...(work.input!.options.nativeModelParams
          ? { params: work.input!.options.nativeModelParams }
          : {}),
      },
      this.catalog,
    )
    const prepared = await this.container.wire!.request(
      'prepare',
      {
        owner: work.owner,
        reservationId: this.reservation.reservationId,
        digest: inputDigest(message),
        preparationMs: Math.max(
          1,
          work.preparationDeadline! - performance.now(),
        ),
        model,
        options: work.input!.options,
        ...(this.confirmed
          ? { agentId: this.confirmed.binding.providerSessionId }
          : {}),
      },
      Math.max(1, work.preparationDeadline! - performance.now()),
    )
    this.current(work)
    invariant(
      prepared.storeId === this.storeId &&
        typeof prepared.agentId === 'string' &&
        prepared.reservationId === this.reservation.reservationId &&
        JSON.stringify(prepared.owner) === JSON.stringify(work.owner),
      'cursor_prepared_identity',
    )
    if (!this.confirmed) {
      const record: CursorNativeRecord = {
        version: 1,
        forgeSessionId: this.session.id,
        binding: {
          provider: this.session.provider,
          accountId: this.session.accountId!,
          cwd: this.session.cwd,
          providerSessionId: prepared.agentId,
        },
        sdkVersion: '1.0.28',
        storeId: this.storeId,
        storeRelativePath: this.reservation.storeRelativePath,
        reservationId: this.reservation.reservationId,
      }
      await this.callback(work, () =>
        this.options.sink.confirm(
          {
            owner: work.owner,
            record,
            initialQueuedRunId: prepared.initialQueuedRunId as
              string | undefined,
          },
          work.abort.signal,
        ),
      )
      const confirmed: CursorReservation = {
        ...this.reservation,
        state: 'native-confirmed',
        record,
      }
      const indexes = join(this.launch.stateRoot, 'by-agent')
      await mkdir(indexes, { recursive: true, mode: 0o700 })
      const key = createHash('sha256')
        .update(
          JSON.stringify([
            record.binding.provider,
            record.binding.accountId,
            record.binding.providerSessionId,
          ]),
        )
        .digest('hex')
      await inventoryTransaction(
        this.options.resources,
        this.launch.stateRoot,
        this.limits,
        async (inventory) => {
          invariant(
            inventory.indexes < this.limits.indexes,
            'cursor_index_limit',
          )
          await writeInventoryMarker(
            join(indexes, `${key}.json`),
            record,
            inventory,
            this.limits,
            true,
          )
          await writeInventoryMarker(
            join(dirname(this.directory!), 'manifest.json'),
            confirmed,
            inventory,
            this.limits,
          )
        },
      )
      this.current(work)
      this.confirmed = record
      this.reservation = confirmed
    }
    this.current(work)
    work.phase = 'running'
    try {
      const submitted = await this.container.wire!.request('submit', {
        owner: work.owner,
        reservationId: this.reservation.reservationId,
        message,
      })
      invariant(
        submitted.agentId === this.confirmed!.binding.providerSessionId &&
          typeof submitted.nativeRunId === 'string' &&
          JSON.stringify(submitted.owner) === JSON.stringify(work.owner),
        'submission_unknown',
      )
    } catch {
      throw new CursorError('submission_unknown')
    }
    const result = await work.nativeResult!
    this.current(work)
    work.phase = 'persisting'
    await this.nativeChain
    if (this.nativeError) throw this.nativeError
    const seal = plainCopy(
      await this.callback(work, () =>
        this.options.sink.seal(work.owner, work.abort.signal),
      ).catch(() => {
        throw new CursorError('cursor_persistence_unknown')
      }),
      this.limits.controlBytes,
    )
    invariant(
      Number.isSafeInteger(seal.through) &&
        seal.through >= Math.max(0, work.lastNativePosition),
      'cursor_persistence_unknown',
    )
    const flushed = plainCopy(
      await this.callback(work, () =>
        this.options.sink.flush(
          { owner: work.owner, through: seal.through },
          work.abort.signal,
        ),
      ).catch(() => {
        throw new CursorError('cursor_persistence_unknown')
      }),
      this.limits.controlBytes,
    )
    invariant(
      Number.isSafeInteger(flushed.committedThrough) &&
        flushed.committedThrough >= seal.through,
      'cursor_persistence_unknown',
    )
    work.phase = 'committed'
    if (result.error)
      invariant(
        (result.error.code === undefined ||
          (typeof result.error.code === 'string' &&
            Buffer.byteLength(result.error.code) <=
              this.limits.messageBytes)) &&
          (result.error.message === undefined ||
            (typeof result.error.message === 'string' &&
              Buffer.byteLength(result.error.message) <=
                this.limits.messageBytes)),
        'cursor_public_error_limit',
      )
    const outcome =
      result.status === 'finished'
        ? { status: 'completed' as const }
        : result.status === 'cancelled'
          ? { status: 'interrupted' as const }
          : {
              status: 'failed' as const,
              code: result.error?.code ?? 'cursor_native_error',
              message: result.error?.message ?? 'Cursor native run failed',
            }
    this.finish(work, outcome)
  }
  private frame(frame: CursorFrame) {
    const owner = frame.owner as CursorOwner | undefined
    invariant(
      owner && owner.generation === this.generation,
      'cursor_event_generation',
    )
    const work = this.tombstones.get(owner.runId)
    invariant(
      work && JSON.stringify(work.owner) === JSON.stringify(owner),
      'cursor_event_owner',
    )
    const size = Buffer.byteLength(JSON.stringify(frame))
    invariant(
      ++this.totalEvents <= this.limits.generationEvents &&
        (this.totalEventBytes += size) <= this.limits.generationEventBytes,
      'cursor_generation_output_limit',
    )
    if (frame.type === 'event') {
      invariant(!work.finished, 'cursor_late_event')
      const event = harnessEventSchema.parse(frame.event)
      invariant(
        event.runId === owner.runId &&
          (!('turnId' in event) || event.turnId === owner.turnId) &&
          event.runtimeGeneration === owner.generation,
        'cursor_event_owner',
      )
      this.emit(event)
    } else if (frame.type === 'native_record') {
      const record = plainCopy(
        frame.record,
        this.limits.frameBytes,
      ) as CursorNativeEnvelope
      invariant(
        this.pendingNative < this.limits.queuedFrames &&
          this.nativeBytes + size <= this.limits.queuedWireBytes,
        'cursor_native_sink_limit',
      )
      this.pendingNative++
      this.nativeBytes += size
      this.nativeChain = this.nativeChain
        .then(async () => {
          if (this.nativeError) throw this.nativeError
          invariant(
            JSON.stringify(record.owner) === JSON.stringify(owner),
            'cursor_native_record_owner',
          )
          const appended = plainCopy(
            await this.physicalCallback(() =>
              this.options.sink.appendNative(record, neverAborted()),
            ),
            this.limits.controlBytes,
          )
          // Physical late writes can outlive the Work payload. Update the
          // current original-owner evidence after the write actually settles.
          const evidence = this.tombstones.get(owner.runId)
          invariant(
            evidence &&
              JSON.stringify(evidence.owner) === JSON.stringify(owner),
            'cursor_native_record_owner',
          )
          invariant(
            Number.isSafeInteger(appended.position) &&
              appended.position > evidence.lastNativePosition,
            'cursor_persistence_unknown',
          )
          evidence.lastNativePosition = appended.position
        })
        .catch((error) => {
          this.nativeError ??= new CursorError('cursor_persistence_unknown')
          if (
            this.active?.owner.runId === owner.runId &&
            this.active.owner.attemptId === owner.attemptId &&
            this.active.owner.generation === owner.generation
          )
            this.active.rejectResult?.(this.nativeError)
          void error
        })
        .finally(() => {
          this.pendingNative--
          this.nativeBytes -= size
        })
    } else if (frame.type === 'result' && this.active?.owner === work.owner)
      this.active.resolveResult?.(frame.result as RunResult)
    else if (frame.type === 'failure' && this.active?.owner === work.owner)
      this.active.rejectResult?.(
        new CursorError(String(frame.code ?? 'cursor_native_error')),
      )
  }
  private finish(work: Work, outcome: TerminalOutcome) {
    if (work.finished) return
    work.finished = true
    const evidence = this.tombstones.get(work.owner.runId)
    if (evidence) evidence.finished = true
    const result = {
      ...outcome,
      runId: work.owner.runId,
      turnId: work.owner.turnId,
    } as CompletionResult
    try {
      this.emit({
        type: 'turn_completed',
        runId: work.owner.runId,
        turnId: work.owner.turnId,
        runtimeGeneration: work.owner.generation,
        deliveryId: `${work.owner.attemptId}:completed`,
        outcome,
      })
    } finally {
      work.settle(result)
      if (!work.physical) work.release()
    }
  }
  async cancel() {
    for (const work of this.queue.splice(0)) {
      work.abort.abort()
      this.finish(work, {
        status: 'interrupted',
        reason: 'Cancelled before preparation',
      })
    }
    if (this.active) {
      this.active.abort.abort()
      this.active.rejectResult?.(new CursorError('cursor_interrupted'))
      await this.container?.wire?.request('cancel').catch(() => {})
      await this.container?.close()
    }
  }
  async kill() {
    this.killed = true
    await this.cancel()
    await this.container?.close()
    await this.nativeChain
    await this.callbackChain
    for (const work of this.physicalWork) await work.physical?.catch(() => {})
    for (const release of this.ownerReleases) release()
    this.ownerReleases = []
    this.tombstones.clear()
  }
}
