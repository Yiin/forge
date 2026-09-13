import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { PassThrough, Writable } from 'node:stream'
import { JsonlTransport } from '../jsonl.js'
import {
  mkdtemp,
  chmod,
  rm,
  readFile,
  stat,
  symlink,
  readdir,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect } from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  createKimiAdapter,
  createKimiHost,
  discoverKimi,
  readKimiHistory,
} from './index.js'
import {
  kimiLimits,
  kimiLimitCeilings,
  sequence,
  KimiBudget,
  boundedCallback,
  guardianLimits,
  jsonBytes,
} from './limits.js'
import {
  captureAuthority,
  effectiveAuthority,
  sameAuthority,
  kimiModelOverrides,
} from './authority.js'
import { KimiHomeLock } from './lock.js'
import { KimiReplay } from './transcript.js'
import { KimiRecords, digest, record } from './records.js'
import { KimiInteractions } from './interactions.js'
import { KimiHostOwner } from './host.js'
import type { KimiLease } from './host.js'
import { newKimiRequestId, type KimiOwnedBytes } from './transport.js'
import type {
  KimiAttachmentSink,
  KimiLaunchAuthority,
  KimiRecordSink,
  KimiStateReader,
  KimiCheckpoint,
  KimiHost,
  KimiAdapterOptions,
} from './types.js'
import {
  isCompletionPersistenceFailure,
  type DispatchOptions,
  type HarnessEvent,
} from '../types.js'
import { KimiCompletionPersistenceError } from './persistence.js'
import { foldTimeline } from '@forge/protocol/timeline'
import { questionAnswerSchema } from '@forge/protocol/harness'
import { retryFixtureAdmission } from './__fixtures__/admission.js'
import {
  fixtureEnvironment,
  fixtureEvidence,
  finishFixtureHomes,
} from './__fixtures__/ownership.js'

const root = fileURLToPath(new URL('../../../../../', import.meta.url))
const peer = fileURLToPath(new URL('./__fixtures__/peer.mjs', import.meta.url))
const owned: string[] = [],
  hosts: KimiHost[] = []
const pendingFixtureCallbacks = new Set<() => void>()
beforeAll(async () => {
  await chmod(peer, 0o755)
  await promisify(execFile)('bun', ['run', 'build:kimi-guardian'], {
    cwd: root,
  })
}, 30000)
afterAll(async () => {
  await fixtureEvidence('runner.logical_suite_complete', { homes: owned })
  const closing = Promise.allSettled(hosts.map((host) => host.close()))
  for (const release of pendingFixtureCallbacks) release()
  const closed = await closing
  expect(closed.filter((result) => result.status === 'rejected')).toEqual([])
  await finishFixtureHomes(owned)
  for (const path of owned) await rm(path, { recursive: true, force: true })
})
async function temp() {
  const path = await mkdtemp(
    '/var/tmp/forge-comet-kimi-review-correction-v2-runtime-',
  )
  owned.push(path)
  await chmod(path, 0o700)
  return path
}
async function authority(): Promise<KimiLaunchAuthority> {
  const home = await temp()
  return {
    provider: 'kimi-fixture',
    credentialPolicy: 'configured-native',
    account: {
      id: 'fixture-account',
      harnessKey: 'kimi-fixture',
      label: 'Fixture',
      kind: 'kimi',
      adapterKind: 'native',
      homePath: home,
      orderIndex: 0,
      disabledAt: null,
      createdAt: 0,
      lastUsedAt: null,
    },
    harness: {
      name: 'Fixture',
      command: peer,
      args: [],
      env: {},
      protocol: 'acp',
      adapterKind: 'native',
      enabled: true,
    },
    environment: await fixtureEnvironment(home),
  }
}
function controlled<T>() {
  let resolve!: (value: T) => void
  const release = () => resolve(undefined as T)
  const promise = new Promise<T>((end) => {
    resolve = (value) => {
      pendingFixtureCallbacks.delete(release)
      end(value)
    }
  })
  pendingFixtureCallbacks.add(release)
  return { promise, resolve }
}
function store() {
  const positions = new Map<
      string,
      { ordinal: number; checkpoint: KimiCheckpoint }
    >(),
    batches = new Map<string, { hash: string; ordinal: number }>()
  const events: HarnessEvent[] = [],
    rows: Parameters<KimiRecordSink>[0][] = [],
    images = new Map<string, Uint8Array>()
  const nativeRecords = new Map<
    string,
    Parameters<KimiRecordSink>[0]['records'][number]
  >()
  let projection: {
    visibleItemIds: string[]
    removedItemIds: string[]
    unavailableItemIds: string[]
  } = { visibleItemIds: [], removedItemIds: [], unavailableItemIds: [] }
  let hold: ReturnType<typeof controlled<void>> | undefined
  const read: KimiStateReader = async ({ sessionId }) => ({
    committed: { ordinal: positions.get(sessionId)?.ordinal ?? 0 },
    checkpoint: positions.get(sessionId)?.checkpoint,
    owners: [...nativeRecords.values()]
      .filter((entry) => entry.kind === 'turn.owner' && entry.root)
      .map((entry) => ({
        agentId: entry.agentId ?? 'main',
        root: entry.root!,
        sourceIdentity: entry.sourceIdentity,
        providerTurnId: (entry.payload as { providerTurnId: string })
          .providerTurnId,
        providerPromptId: (entry.payload as { promptId: string }).promptId,
      })),
    pending: [...nativeRecords.values()].filter(
      (entry) =>
        entry.kind === 'request.pending' &&
        ![...nativeRecords.values()].some(
          (outcome) =>
            ['request.expired', 'request.submitted'].includes(outcome.kind) &&
            (outcome.payload as { requestId?: string }).requestId ===
              (entry.payload as { requestId: string }).requestId,
        ),
    ),
  })
  const sink: KimiRecordSink = async (input) => {
    if (hold) await hold.promise
    const hash = input.contentHash,
      old = batches.get(input.batchId)
    if (old) {
      if (old.hash !== hash) throw new Error('Conflicting batch')
      return { ordinal: old.ordinal, disposition: 'replayed' }
    }
    if (input.replayOnly) throw new Error('Missing durable retry')
    const before = positions.get(input.scope.sessionId)
    if (
      (before?.ordinal ?? 0) !== input.expectedOrdinal ||
      (before && digest(before.checkpoint) !== digest(input.expectedCheckpoint))
    )
      throw new Error('Stale transaction')
    const ordinal = input.expectedOrdinal + 1
    const staged = new Map(nativeRecords)
    for (const entry of input.records) {
      const old = staged.get(entry.recordId)
      if (
        old &&
        digest([old.sourceIdentity, old.payload, old.attachmentIds]) !==
          digest([entry.sourceIdentity, entry.payload, entry.attachmentIds])
      )
        throw new Error('Immutable native record conflict')
      for (const attachmentId of entry.attachmentIds ?? [])
        if (!images.has(attachmentId))
          throw new Error('Missing committed attachment')
      staged.set(entry.recordId, structuredClone(entry))
    }
    let nextProjection = projection
    for (const entry of input.records)
      if (
        [
          'projection.snapshot',
          'projection.removal',
          'projection.unavailable',
        ].includes(entry.kind)
      ) {
        nextProjection = structuredClone(entry.payload) as typeof projection
        for (const id of nextProjection.visibleItemIds)
          if (!staged.has(id))
            throw new Error('Projection references a missing record')
      }
    positions.set(input.scope.sessionId, {
      ordinal,
      checkpoint: structuredClone(input.checkpoint),
    })
    batches.set(input.batchId, { hash, ordinal })
    for (const [id, value] of staged) nativeRecords.set(id, value)
    projection = nextProjection
    rows.push(input)
    events.push(...input.events)
    return { ordinal, disposition: 'committed' }
  }
  const attachment: KimiAttachmentSink = async (input) => {
    const chunks: Uint8Array[] = []
    for await (const chunk of input.bytes) chunks.push(chunk)
    const bytes = Buffer.concat(chunks)
    expect(bytes.length).toBe(input.sizeBytes)
    const id = digest([input.scope.binding, input.sourceIdentity, input.sha256])
    if (images.has(id)) expect(bytes).toEqual(images.get(id))
    images.set(id, bytes)
    return { attachmentId: id }
  }
  return {
    read,
    sink,
    attachment,
    events,
    rows,
    images,
    projection: () => ({
      visible: projection.visibleItemIds.map((id) => nativeRecords.get(id)!),
      removedItemIds: projection.removedItemIds,
      unavailableItemIds: projection.unavailableItemIds,
      committed: {
        ordinal: rows.at(-1) ? rows.at(-1)!.expectedOrdinal + 1 : 0,
      },
    }),
    hold() {
      hold = controlled<void>()
      return () => {
        hold!.resolve()
        hold = undefined
      }
    },
  }
}
async function control(
  home: string,
  command: unknown,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect(join(home, 'fixture.sock'))
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('Fixture control timeout'))
    }, 5000)
    let buffer = ''
    socket.once('connect', () => socket.write(JSON.stringify(command) + '\n'))
    socket.on('error', reject)
    socket.on('data', (bytes) => {
      buffer += bytes
    })
    socket.once('end', () => {
      clearTimeout(timer)
      try {
        resolve(JSON.parse(buffer))
      } catch (error) {
        reject(error)
      }
    })
  })
}
async function setup(
  overrides = {},
  options: Partial<
    Pick<
      KimiAdapterOptions,
      'beforeDispatch' | 'loadAttachment' | 'commitRecords'
    >
  > = {},
  scenario?: unknown,
) {
  const selected = await authority(),
    host = createKimiHost({ limits: overrides })
  hosts.push(host)
  if (scenario)
    await writeFile(
      join(selected.account.homePath, 'fixture-scenario.json'),
      JSON.stringify(scenario),
    )
  const storage = store(),
    events: HarnessEvent[] = [],
    cwd = await temp()
  const adapter = createKimiAdapter({
    authority: selected,
    host,
    readState: storage.read,
    commitRecords: storage.sink,
    storeAttachment: storage.attachment,
    ...options,
  })
  const handle = await retryFixtureAdmission(() =>
    adapter.spawn(
      {
        id: 'forge-a',
        cwd,
        provider: selected.provider,
        accountId: selected.account.id,
      },
      (event) => events.push(event),
    ),
  )
  return {
    selected,
    host,
    storage,
    cwd,
    adapter,
    handle,
    events,
    control: (command: unknown) => control(selected.account.homePath, command),
  }
}
async function finish(
  fixture: Awaited<ReturnType<typeof setup>>,
  handle = fixture.handle,
  text = 'Final text',
) {
  await fixture.control({
    op: 'finish',
    sessionId: handle.binding!.providerSessionId,
    content: [{ type: 'text', text }],
  })
}
async function observe(
  fixture: Awaited<ReturnType<typeof setup>>,
  predicate: (inspection: Record<string, unknown>) => boolean,
) {
  const end = performance.now() + 5000
  while (performance.now() < end) {
    const inspection = await fixture.control({ op: 'inspect' })
    if (predicate(inspection)) return inspection
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error('Fixture observation deadline')
}

const coldTurn = (index: number) => ({
  kind: 'turn',
  turnId: `t${index}`,
  ordinal: index + 1,
  state: 'completed',
  origin: { kind: 'user' },
  steps: [
    {
      stepId: `t${index}.1`,
      ordinal: 1,
      state: 'completed',
      frames: [
        {
          kind: 'text',
          frameId: `frame-${index}`,
          role: 'assistant',
          text: `cold-${index}`,
        },
      ],
    },
  ],
})

describe('correction physical resources and source-shaped recovery', () => {
  test.each([
    ['dispatch', 'ack'],
    ['dispatch', 'reject'],
    ['dispatch', 'timeout'],
    ['native', 'ack'],
    ['native', 'reject'],
    ['native', 'timeout'],
    ['finish', 'ack'],
    ['finish', 'reject'],
    ['finish', 'timeout'],
  ] as const)(
    'actual %s failure owns a held terminal through %s',
    async (route, result) => {
      const gate = controlled<void>(),
        entered = controlled<void>(),
        original = new Error('Owned synthetic sink failure')
      let terminalCalls = 0,
        terminalInput: Parameters<KimiRecordSink>[0] | undefined
      const fixture = await setup(
        { sinkMs: result === 'timeout' ? 100 : 5000 },
        {
          ...(route === 'dispatch'
            ? {
                beforeDispatch: async () => {
                  throw new Error('Owned dispatch refusal')
                },
              }
            : {}),
          commitRecords: async (input) => {
            if (
              input.records.some(
                (entry) =>
                  entry.kind === 'turn.terminal' ||
                  entry.kind === 'turn.failure',
              )
            ) {
              terminalCalls++
              terminalInput = input
              entered.resolve()
              await gate.promise
              if (result === 'reject') throw original
            }
            return {
              ordinal: input.expectedOrdinal + 1,
              disposition: 'committed',
            }
          },
        },
      )
      const receipt = fixture.handle.prompt('Owned persistence regression'),
        completionId = receipt.completion.completionId,
        receiptId = receipt.receiptId,
        runId = receipt.runId,
        turnId = receipt.turnId
      let outcome: unknown,
        settled = false
      const observed = receipt.completion.then(
        (value) => {
          settled = true
          outcome = value
        },
        (error) => {
          settled = true
          outcome = error
        },
      )
      try {
        if (route === 'native' || route === 'finish') {
          expect(await receipt.delivery).toMatchObject({ status: 'delivered' })
          await fixture.control({
            op: 'finish',
            sessionId: fixture.handle.binding!.providerSessionId,
            reason: route === 'native' ? 'failed' : 'completed',
            ...(route === 'finish'
              ? { content: [{ type: 'text', text: 'Final owned text' }] }
              : {}),
          })
        }
        await entered.promise
        expect(settled).toBe(false)
        expect(terminalCalls).toBe(1)
        expect(
          (fixture.host as KimiHostOwner).budget.count('sinkCalls'),
        ).toBeGreaterThanOrEqual(1)
        Object.assign(receipt.completion, {
          completionId: 'display-change',
          runId: 'display-change',
          turnId: 'display-change',
        })
        receipt.receiptId = 'display-receipt-change'
        if (result !== 'timeout') gate.resolve()
        await observed
        if (result === 'ack') {
          expect(outcome).toMatchObject({
            status: route === 'finish' ? 'completed' : 'failed',
            runId,
            turnId,
          })
          expect(
            fixture.events.filter((event) => event.type === 'turn_completed'),
          ).toHaveLength(1)
        } else {
          expect(isCompletionPersistenceFailure(outcome)).toBe(true)
          const error = outcome as KimiCompletionPersistenceError
          expect(error).toBeInstanceOf(KimiCompletionPersistenceError)
          expect(error.persistence).toMatchObject({
            sessionId: 'forge-a',
            receiptId,
            completionId,
            runId,
            turnId,
            code: 'persistence_unknown',
            failure: {
              phase: 'entered',
              input: { expectedOrdinal: terminalInput!.expectedOrdinal },
              physical: result === 'timeout' ? 'pending' : 'rejected',
            },
            required: { state: 'unproved' },
          })
          if (result === 'reject') expect(error.underlying).toBe(original)
          expect(
            fixture.events.filter((event) => event.type === 'turn_completed'),
          ).toHaveLength(0)
          await expect(fixture.handle.cancel()).rejects.toBe(error)
          await expect(fixture.handle.kill()).rejects.toBe(error)
          expect(() => fixture.handle.prompt('Must stay fenced')).toThrow(error)
          const snapshot = JSON.stringify(error.persistence)
          gate.resolve()
          await expect
            .poll(() =>
              (fixture.host as KimiHostOwner).budget.count('sinkCalls'),
            )
            .toBe(0)
          expect(JSON.stringify(error.persistence)).toBe(snapshot)
          if (result === 'timeout')
            expect(error.recovery().required.state).toBe('committed')
        }
        expect(terminalCalls).toBe(1)
      } finally {
        gate.resolve()
        await observed
        await fixture.host.close()
      }
    },
    30000,
  )
  test('actual JSON and raw responses reject the first byte above their preserved maximum and release ownership', async () => {
    const fixture = await setup(),
      lease = (fixture.handle as unknown as { lease: KimiLease }).lease,
      budget = (fixture.host as KimiHostOwner).budget
    await fixture.control({
      op: 'scenario',
      value: { messageEnvelopeBytes: 8388609, rawBytes: 16777217 },
    })
    await expect(
      lease.server.http(
        lease.lane,
        `/api/v1/sessions/${fixture.handle.binding!.providerSessionId}/messages`,
        { maxBytes: 8388608 },
      ),
    ).rejects.toBeDefined()
    await observe(fixture, () => budget.count('hostHttpBufferBytes') === 0)
    await expect(
      lease.server.http(lease.lane, '/api/v1/files/oversize', {
        raw: true,
        maxBytes: 16777216,
      }),
    ).rejects.toBeDefined()
    await observe(fixture, () => budget.count('hostHttpBufferBytes') === 0)
    expect(budget.count('hostAttachmentBytes')).toBe(0)
    await fixture.handle.kill()
  }, 30000)
  test('queued steering retains its mutation slot and refuses repeated or independent work while its response is held', async () => {
    const fixture = await setup({ pendingControls: 1 }),
      root = fixture.handle.prompt('Root')
    await root.delivery
    const budget = (fixture.handle as unknown as { budget: KimiBudget }).budget
    await observe(fixture, () => budget.count('pendingControls') === 0)
    const queued = fixture.handle.queue('Queued steering')
    expect(await queued.nativeAcceptance).toMatchObject({
      status: 'accepted',
      nativeStatus: 'queued',
    })
    await observe(fixture, () => budget.count('pendingControls') === 0)
    await fixture.control({ op: 'scenario', value: { holdSteer: true } })
    const steering = fixture.handle.steerQueued([queued.receiptId])
    await observe(fixture, (state) =>
      (state.requests as { path: string }[]).some((row) =>
        row.path.endsWith('prompts:steer'),
      ),
    )
    for (let index = 0; index < 25; index++)
      await expect(
        fixture.handle.steerQueued([queued.receiptId]),
      ).rejects.toMatchObject({ code: 'kimi_steer_busy' })
    await expect(
      fixture.handle.abortPrompt(root.receiptId),
    ).rejects.toMatchObject({ code: 'kimi_resource_limit' })
    const inspection = await fixture.control({ op: 'inspect' })
    expect(
      (inspection.requests as { path: string }[]).filter((row) =>
        row.path.endsWith('prompts:steer'),
      ),
    ).toHaveLength(1)
    expect(
      (inspection.requests as { path: string }[]).filter((row) =>
        row.path.endsWith(':abort'),
      ),
    ).toHaveLength(0)
    await fixture.control({ op: 'releaseSteers' })
    await steering
    expect(await queued.delivery).toMatchObject({
      status: 'delivered',
      mode: 'steer',
    })
    await finish(fixture)
    expect((await root.completion).status).toBe('failed')
    expect((await queued.completion).status).toBe('failed')
    await fixture.handle.kill()
  }, 30000)
  test('an excessive native final page fails before owned content publication', async () => {
    const fixture = await setup({ pageMessages: 1 }),
      receipt = fixture.handle.prompt('Bounded final page')
    await receipt.delivery
    await fixture.control({
      op: 'scenario',
      value: { excessiveMessagePage: true },
    })
    await finish(fixture, fixture.handle, 'Must not publish')
    expect((await receipt.completion).status).toBe('failed')
    expect(
      fixture.events.some(
        (event) =>
          event.type === 'content_snapshot' &&
          event.text === 'Must not publish',
      ),
    ).toBe(false)
    await fixture.handle.kill()
  }, 30000)
  test('holds actual cross-home startup, helper, process, HTTP, IPC, and timer ownership at aggregate admission', async () => {
    const a = await authority(),
      b = await authority(),
      c = await authority(),
      host = createKimiHost({
        limits: {
          hostHomes: 2,
          hostGuardians: 2,
          hostProcesses: 4,
          hostStartups: 1,
          hostHelpers: 2,
          homeHelpers: 1,
        },
      }) as KimiHostOwner
    hosts.push(host)
    await writeFile(
      join(a.account.homePath, 'fixture-scenario.json'),
      JSON.stringify({ holdHealth: true }),
    )
    const effectiveA = await effectiveAuthority(
        captureAuthority(a, host.budget.limits),
      ),
      effectiveB = await effectiveAuthority(
        captureAuthority(b, host.budget.limits),
      )
    const starting = retryFixtureAdmission(() =>
      host.acquire(effectiveA, 'helper'),
    )
    void starting.catch(() => {})
    await expect
      .poll(() =>
        stat(join(a.account.homePath, 'fixture.sock')).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true)
    expect(host.budget.count('hostStartups')).toBe(1)
    await expect(host.acquire(effectiveB, 'helper')).rejects.toMatchObject({
      code: 'kimi_resource_limit',
    })
    expect(host.budget.count('hostHomes')).toBe(1)
    await control(a.account.homePath, { op: 'releaseStartup' })
    const first = await starting,
      second = await retryFixtureAdmission(() =>
        host.acquire(effectiveB, 'helper'),
      )
    try {
      expect(host.budget.count('hostProcesses')).toBe(4)
      expect(host.budget.count('hostGuardians')).toBe(2)
      expect(host.budget.count('hostHelpers')).toBe(2)
      expect(host.budget.count('hostIpcBytes')).toBeGreaterThanOrEqual(
        2 * guardianLimits(host.budget.limits).hostIpcBytes,
      )
      expect(host.budget.count('hostTimers')).toBeGreaterThanOrEqual(
        2 * guardianLimits(host.budget.limits).hostTimers,
      )
      await expect(host.acquire(effectiveA, 'helper')).rejects.toBeDefined()
      await expect(
        host.acquire(
          await effectiveAuthority(captureAuthority(c, host.budget.limits)),
          'helper',
        ),
      ).rejects.toBeDefined()
      const session = (await first.server.http(first.lane, '/api/v1/sessions', {
        method: 'POST',
        body: { metadata: { cwd: await temp() } },
      })) as { id: string }
      await control(a.account.homePath, {
        op: 'scenario',
        value: { holdMessages: true },
      })
      const held = first.server.http(
        first.lane,
        `/api/v1/sessions/${session.id}/messages`,
        { maxBytes: 8388608 },
      )
      void held.catch(() => {})
      await expect
        .poll(() => host.budget.count('hostHttpBufferBytes'))
        .toBe(25165824)
      const before = (
        (await control(b.account.homePath, { op: 'inspect' }))
          .requests as unknown[]
      ).length
      await expect(
        second.server.http(second.lane, '/api/v1/config', {
          maxBytes: 8388608,
        }),
      ).rejects.toMatchObject({ code: 'kimi_http_buffer_limit' })
      expect(
        (
          (await control(b.account.homePath, { op: 'inspect' }))
            .requests as unknown[]
        ).length,
      ).toBe(before)
      await control(a.account.homePath, { op: 'releaseMessages' })
      await held
      await expect(
        second.server.http(second.lane, '/api/v1/config', {
          maxBytes: 8388608,
        }),
      ).resolves.toBeDefined()
    } finally {
      await first.close()
      await second.close()
      await host.close()
    }
    for (const key of [
      'hostHomes',
      'hostProcesses',
      'hostStartups',
      'hostHelpers',
      'hostGuardians',
      'hostHttp',
      'hostHttpBufferBytes',
      'hostIpcBytes',
      'hostTimers',
      'hostRetainedBytes',
    ] as const)
      expect(host.budget.count(key), key).toBe(0)
  }, 30000)
  test('four default guardians coexist with exact parent JSONL receive and held-write saturation', async () => {
    const host = createKimiHost() as KimiHostOwner
    hosts.push(host)
    const leases: KimiLease[] = []
    let releaseValue = () => {},
      releaseWrite = () => {}
    let enteredWrites = 0
    const stdout = new PassThrough(),
      stdin = new Writable({
        write(_chunk, _encoding, done) {
          enteredWrites++
          releaseWrite = done
        },
      })
    const pipe = new JsonlTransport({
      stdin,
      stdout,
      maxLineBytes: host.budget.limits.ipcMessageBytes,
      resources: {
        measureOutgoing: (value) =>
          jsonBytes(
            value,
            host.budget.limits,
            host.budget.limits.ipcMessageBytes,
          ),
        reserve: (_kind, bytes) => host.budget.reserve('hostIpcBytes', bytes),
      },
      onValue: (_value, _bytes, ownership) => {
        releaseValue = ownership!.retain()
      },
    })
    try {
      for (let home = 0; home < 4; home++) {
        const selected = await authority()
        leases.push(
          await retryFixtureAdmission(() =>
            effectiveAuthority(
              captureAuthority(selected, host.budget.limits),
            ).then((value) => host.acquire(value, 'helper')),
          ),
        )
      }
      const baseline = host.budget.count('hostIpcBytes')
      expect(host.budget.count('hostGuardians')).toBe(4)
      expect(baseline).toBe(
        4 * guardianLimits(host.budget.limits).hostIpcBytes + 4 * 4096,
      )
      const written = pipe.send('w'.repeat(4093))
      expect(enteredWrites).toBe(1)
      expect(host.budget.count('hostIpcBytes')).toBe(baseline + 4096)
      const remaining =
        host.budget.limits.hostIpcBytes - host.budget.count('hostIpcBytes')
      expect(remaining % 4).toBe(0)
      const length = remaining / 4
      stdout.write(Buffer.from(JSON.stringify('r'.repeat(length - 2)) + '\n'))
      expect(host.budget.count('hostIpcBytes')).toBe(
        host.budget.limits.hostIpcBytes,
      )
      await expect(pipe.send('refused')).rejects.toThrow(
        'Cannot encode JSONL value',
      )
      expect(enteredWrites).toBe(1)
      expect(host.budget.count('hostIpcBytes')).toBe(
        host.budget.limits.hostIpcBytes,
      )
      releaseValue()
      releaseWrite()
      await written
      await pipe.close()
      expect(host.budget.count('hostIpcBytes')).toBe(baseline)
      for (const lease of leases)
        await expect(
          lease.server.http(lease.lane, '/api/v1/config'),
        ).resolves.toBeDefined()
    } finally {
      releaseValue()
      releaseWrite()
      await pipe.close()
      stdin.destroy()
      stdout.destroy()
      for (const lease of leases) await lease.close()
      await host.close()
    }
    expect(host.budget.count('hostIpcBytes')).toBe(0)
    expect(host.budget.count('hostProcesses')).toBe(0)
  }, 45000)
  test('lowered guardian timer ownership admits its complete startup and refuses the next-lower share with cleanup', async () => {
    for (const timers of [12, 10]) {
      const selected = await authority(),
        host = createKimiHost({
          limits: { hostGuardians: 1, hostTimers: timers },
        }) as KimiHostOwner
      hosts.push(host)
      const starting = retryFixtureAdmission(async () =>
        host.acquire(
          await effectiveAuthority(
            captureAuthority(selected, host.budget.limits),
          ),
          'helper',
        ),
      )
      if (timers === 12) {
        const lease = await starting
        await lease.close()
      } else await expect(starting).rejects.toBeDefined()
      await host.close()
      expect(host.budget.count('hostTimers')).toBe(0)
      expect(host.budget.count('hostProcesses')).toBe(0)
      expect(host.budget.count('hostIpcBytes')).toBe(0)
    }
  }, 30000)
  test('main completion preserves detached child questions and approvals until their original child ends', async () => {
    const fixture = await setup(),
      sessionId = fixture.handle.binding!.providerSessionId,
      send = (type: string, payload: unknown) =>
        fixture.control({ op: 'frame', sessionId, type, payload }),
      receipt = fixture.handle.prompt('Detached requests')
    await receipt.delivery
    await send('tool.call.started', {
      turnId: 0,
      toolCallId: 'spawn',
      name: 'Agent',
      input: {},
    })
    await send('subagent.spawned', {
      subagentId: 'C',
      subagentName: 'Child',
      parentToolCallId: 'spawn',
      runInBackground: true,
    })
    await send('turn.started', {
      agentId: 'C',
      turnId: 0,
      origin: { kind: 'user' },
    })
    await send('event.question.requested', {
      agentId: 'C',
      question_id: 'child-question',
      session_id: sessionId,
      turn_id: 0,
      questions: [
        {
          id: 'item',
          question: 'Continue?',
          options: [{ id: 'yes', label: 'Yes' }],
          multi_select: false,
          allow_other: false,
        },
      ],
    })
    await send('event.approval.requested', {
      agentId: 'C',
      approval_id: 'child-approval',
      session_id: sessionId,
      turn_id: 0,
      action: 'Run fixture command',
      tool_name: 'Shell',
      tool_input: {},
    })
    await observe(
      fixture,
      () =>
        fixture.events.filter(
          (event) =>
            event.type === 'question_requested' ||
            event.type === 'permission_requested',
        ).length === 2,
    )
    await finish(fixture)
    expect((await receipt.completion).status).toBe('completed')
    expect(
      fixture.events.filter((event) => event.type === 'request_cancelled'),
    ).toEqual([])
    expect(
      fixture.events
        .filter(
          (event) =>
            event.type === 'question_requested' ||
            event.type === 'permission_requested',
        )
        .every((event) => !!event.childId),
    ).toBe(true)
    await send('subagent.completed', {
      subagentId: 'C',
      resultSummary: 'Child completed',
    })
    await observe(
      fixture,
      () =>
        fixture.events.filter((event) => event.type === 'request_cancelled')
          .length === 2,
    )
    const question = fixture.events.find(
      (event) => event.type === 'question_requested',
    )!
    await expect(
      fixture.handle.replyQuestion!(question.request.requestId, {
        item: { type: 'selected', optionIds: ['yes'] },
      }),
    ).rejects.toMatchObject({ code: 'kimi_request_unavailable' })
    await fixture.handle.kill()
  }, 30000)
  test.each(['same', 'new', 'regression'])(
    'restores persisted native owners and requests under the %s transcript-store case',
    async (mode) => {
      const selected = await authority(),
        host = createKimiHost(),
        storage = store(),
        cwd = await temp()
      hosts.push(host)
      await writeFile(
        join(selected.account.homePath, 'fixture-scenario.json'),
        JSON.stringify({
          baseline: { seq: mode === 'same' ? 10 : 1, items: [coldTurn(0)] },
        }),
      )
      const owner = host as KimiHostOwner,
        helper = await retryFixtureAdmission(async () =>
          owner.acquire(
            await effectiveAuthority(
              captureAuthority(selected, owner.budget.limits),
            ),
            'helper',
          ),
        )
      const session = (await helper.server.http(
        helper.lane,
        '/api/v1/sessions',
        { method: 'POST', body: { metadata: { cwd } } },
      )) as { id: string }
      const binding = {
          provider: selected.provider,
          accountId: selected.account.id,
          cwd,
          providerSessionId: session.id,
        },
        scope = {
          sessionId: 'persisted-forge',
          binding,
          runtimeGeneration: 'original-generation',
        },
        originalRoot = {
          runId: 'persisted-run',
          turnId: 'persisted-turn',
          operationId: 'persisted-operation',
        }
      const accepted = (await helper.server.http(
        helper.lane,
        `/api/v1/sessions/${session.id}/prompts`,
        {
          method: 'POST',
          body: {
            content: [{ type: 'text', text: 'Already admitted' }],
            permission_mode: 'manual',
          },
        },
      )) as { prompt_id: string }
      const raw = {
        question_id: 'persisted-native-question',
        session_id: session.id,
        turn_id: 0,
        questions: [
          {
            id: 'item',
            question: 'Resume?',
            options: [{ id: 'yes', label: 'Yes' }],
            multi_select: false,
            allow_other: false,
          },
        ],
      }
      await control(selected.account.homePath, {
        op: 'frame',
        sessionId: session.id,
        type: 'event.question.requested',
        payload: raw,
      })
      const snapshot = (await helper.server.http(
        helper.lane,
        `/api/v1/sessions/${session.id}/snapshot`,
      )) as { epoch: string; as_of_seq: number }
      const storeId =
        mode === 'new'
          ? 'original-removed-store'
          : digest([helper.server.transcriptStore, session.id, 0])
      const persisted = new KimiRecords(
        scope,
        new KimiBudget(owner.budget.limits),
        owner,
        storage.sink,
        () => {},
        new AbortController().signal,
      )
      const requests = new KimiInteractions(
        persisted,
        helper,
        (work) => work(),
        async (error) => {
          throw error
        },
      )
      await persisted.commit('persisted-owner', [
        record(
          scope,
          'live-engine',
          ['journal', 0],
          'turn.owner',
          { providerTurnId: '0', promptId: accepted.prompt_id },
          originalRoot,
          'main',
        ),
      ])
      await requests.observe('question', raw, originalRoot, '0', 'main')
      await persisted.commit(
        'persisted-checkpoint',
        [
          record(
            scope,
            'cold-import',
            ['old-baseline'],
            'transcript.store.baseline',
            { store: storeId },
            undefined,
            'main',
          ),
        ],
        [],
        {
          session: { epoch: snapshot.epoch, seq: snapshot.as_of_seq },
          transcripts: { main: 10 },
          transcriptStores: { main: storeId },
        },
      )
      const restored = await storage.read({
        sessionId: scope.sessionId,
        binding,
        signal: new AbortController().signal,
      })
      expect(restored.owners).toHaveLength(1)
      expect(restored.pending).toHaveLength(1)
      requests.close()
      persisted.close()
      const events: HarnessEvent[] = [],
        adapter = createKimiAdapter({
          authority: selected,
          host,
          readState: storage.read,
          commitRecords: storage.sink,
          storeAttachment: storage.attachment,
        })
      try {
        const loading = adapter.load(
          {
            id: scope.sessionId,
            cwd,
            provider: selected.provider,
            accountId: selected.account.id,
            binding,
          },
          (event) => events.push(event),
        )
        if (mode === 'regression') {
          await expect(loading).rejects.toMatchObject({
            code: 'kimi_resume_failed',
          })
          expect(
            (
              await storage.read({
                sessionId: scope.sessionId,
                binding,
                signal: new AbortController().signal,
              })
            ).checkpoint?.transcripts.main,
          ).toBe(10)
        } else {
          const handle = await loading
          try {
            const pending = events.filter(
              (event) => event.type === 'question_requested',
            )
            expect(pending).toHaveLength(mode === 'same' ? 1 : 0)
            expect(
              events.filter((event) => event.type === 'request_cancelled'),
            ).toHaveLength(1)
            if (mode === 'same') {
              expect(pending[0]).toMatchObject({
                runId: originalRoot.runId,
                turnId: originalRoot.turnId,
              })
              await handle.replyQuestion!(pending[0].request.requestId, {
                item: { type: 'selected', optionIds: ['yes'] },
              })
            }
            expect(
              storage.projection().visible.every((entry) => !entry.root),
            ).toBe(true)
            const current = await storage.read({
              sessionId: scope.sessionId,
              binding,
              signal: new AbortController().signal,
            })
            expect(current.checkpoint?.transcripts.main).toBe(
              mode === 'same' ? 10 : 1,
            )
            expect(current.checkpoint?.transcriptStores?.main).toBe(
              digest([helper.server.transcriptStore, session.id, 0]),
            )
          } finally {
            await handle.kill()
          }
        }
      } finally {
        await helper.close()
        await host.close()
      }
    },
    30000,
  )
  test('repeated public aborts share one physical mutation and one queue entry', async () => {
    const fixture = await setup(),
      receipt = fixture.handle.prompt('Abort once'),
      sessionId = fixture.handle.binding!.providerSessionId
    await receipt.delivery
    await fixture.control({
      op: 'scenario',
      value: { holdAbortTerminal: true },
    })
    const calls = Array.from({ length: 100 }, () =>
      fixture.handle.abortPrompt(receipt.receiptId),
    )
    expect(new Set(calls).size).toBe(1)
    await observe(fixture, (state) =>
      (state.requests as { path: string }[]).some((request) =>
        request.path.endsWith(':abort'),
      ),
    )
    const inspection = await fixture.control({ op: 'inspect' })
    expect(
      (inspection.requests as { path: string }[]).filter((request) =>
        request.path.endsWith(':abort'),
      ),
    ).toHaveLength(1)
    await fixture.control({
      op: 'frame',
      sessionId,
      type: 'prompt.aborted',
      payload: {
        promptId:
          (await receipt.nativeAcceptance).status === 'accepted'
            ? ((await receipt.nativeAcceptance) as { promptId: string })
                .promptId
            : '',
      },
    })
    await Promise.all(calls)
    expect((await receipt.completion).status).toBe('interrupted')
    await fixture.handle.kill()
  }, 30000)
  test('aborting an actual held HTTP transfer retains its reservation until the original native response settles', async () => {
    const fixture = await setup(),
      lease = (fixture.handle as unknown as { lease: KimiLease }).lease,
      abort = new AbortController(),
      host = fixture.host as KimiHostOwner
    await fixture.control({ op: 'scenario', value: { holdMessages: true } })
    const before = (
      (await fixture.control({ op: 'inspect' })).requests as unknown[]
    ).length
    const transfer = lease.server.http(
      lease.lane,
      `/api/v1/sessions/${fixture.handle.binding!.providerSessionId}/messages?page_size=20`,
      { maxBytes: 8388608, signal: abort.signal },
    )
    void transfer.catch(() => {})
    await observe(
      fixture,
      (state) => (state.requests as unknown[]).length > before,
    )
    abort.abort()
    await expect(transfer).rejects.toMatchObject({ code: 'kimi_cancelled' })
    expect(host.budget.count('hostHttpBufferBytes')).toBe(25165824)
    await fixture.control({ op: 'releaseMessages' })
    await observe(fixture, () => host.budget.count('hostHttpBufferBytes') === 0)
    await fixture.handle.kill()
  }, 30000)
  test('a lost actual blob-release reply retains HTTP storage until proved guardian exit', async () => {
    const fixture = await setup({ guardianControlMs: 80 }),
      lease = (fixture.handle as unknown as { lease: KimiLease }).lease,
      server = lease.server as unknown as Pick<
        typeof lease.server,
        'rpc' | 'http'
      > & {
        child: { stdout: { pause(): void; resume(): void } }
      },
      original = server.rpc.bind(server),
      host = fixture.host as KimiHostOwner
    let paused = false
    server.rpc = (message, ms) => {
      if (message.op === 'blob_release' && !paused) {
        paused = true
        server.child.stdout.pause()
      }
      return original(message, ms)
    }
    try {
      await expect(
        server.http(lease.lane, '/api/v1/config'),
      ).rejects.toMatchObject({ code: 'kimi_deadline' })
      expect(paused).toBe(true)
      expect(host.budget.count('hostHttpBufferBytes')).toBe(3 * 1048576)
    } finally {
      server.child.stdout.resume()
      server.rpc = original
    }
    await fixture.handle.kill()
    await fixture.host.close()
    expect(host.budget.count('hostHttpBufferBytes')).toBe(0)
  }, 30000)
  test('strict UTF-8 failure in an actual owned JSON transfer releases its blob before another read', async () => {
    const fixture = await setup(),
      lease = (fixture.handle as unknown as { lease: KimiLease }).lease,
      path = `/api/v1/sessions/${fixture.handle.binding!.providerSessionId}/messages?page_size=20`
    await fixture.control({
      op: 'scenario',
      value: { invalidMessageUtf8: true },
    })
    await expect(lease.server.http(lease.lane, path)).rejects.toMatchObject({
      code: 'kimi_invalid_json',
    })
    expect(
      (fixture.host as KimiHostOwner).budget.count('hostHttpBufferBytes'),
    ).toBe(0)
    await fixture.control({
      op: 'scenario',
      value: { invalidMessageUtf8: false },
    })
    await expect(lease.server.http(lease.lane, path)).resolves.toEqual({
      items: [],
      has_more: false,
    })
    await fixture.handle.kill()
  }, 30000)
  test('delivers an exact 8 MiB native JSON envelope and a 16 MiB raw response through bounded IPC chunks', async () => {
    const fixture = await setup(),
      lease = (fixture.handle as unknown as { lease: KimiLease }).lease
    await observe(
      fixture,
      () =>
        (fixture.host as KimiHostOwner).budget.count('hostHttpBufferBytes') ===
        0,
    )
    await fixture.control({
      op: 'scenario',
      value: { messageEnvelopeBytes: 8388608 },
    })
    const value = (await lease.server.http(
      lease.lane,
      `/api/v1/sessions/${fixture.handle.binding!.providerSessionId}/messages?page_size=20`,
      { maxBytes: 8388608 },
    )) as { items: { content: { text: string }[] }[] }
    expect(value.items).toHaveLength(1)
    expect(
      value.items[0].content.reduce((size, part) => size + part.text.length, 0),
    ).toBeGreaterThan(8388000)
    await fixture.control({
      op: 'scenario',
      value: { messageEnvelopeBytes: 8388609 },
    })
    await expect(
      lease.server.http(
        lease.lane,
        `/api/v1/sessions/${fixture.handle.binding!.providerSessionId}/messages?page_size=20`,
        { maxBytes: 8388608 },
      ),
    ).rejects.toBeDefined()
    await fixture.handle.kill()
    await fixture.host.close()
    // A separate proved home avoids reusing uncertain oversized-response ownership.
    const raw = await setup(),
      rawLease = (raw.handle as unknown as { lease: KimiLease }).lease
    await raw.control({ op: 'scenario', value: { rawBytes: 16777216 } })
    await observe(
      raw,
      () =>
        (raw.host as KimiHostOwner).budget.count('hostHttpBufferBytes') === 0,
    )
    const bytes = (await rawLease.server.http(
      rawLease.lane,
      '/api/v1/files/max',
      { raw: true, maxBytes: 16777216 },
    )) as KimiOwnedBytes
    expect(bytes.bytes.length).toBe(16777216)
    expect(bytes.bytes[16777215]).toBe(7)
    expect(
      (raw.host as KimiHostOwner).budget.count('hostAttachmentBytes'),
    ).toBe(16777216)
    bytes.release()
    expect(
      (raw.host as KimiHostOwner).budget.count('hostAttachmentBytes'),
    ).toBe(0)
    await raw.handle.kill()
  }, 30000)
  test('installs all nonempty native pages with the original before_turn and then applies sequence 11', async () => {
    const fixture = await setup(
      { pageTurns: 2 },
      {},
      {
        baseline: {
          seq: 10,
          items: Array.from({ length: 5 }, (_, index) => coldTurn(index)),
          global: {
            tasks: [
              {
                taskId: 'shell',
                kind: 'shell',
                state: 'running',
                detached: true,
                outputTail: 'old',
              },
            ],
          },
        },
      },
    )
    const sessionId = fixture.handle.binding!.providerSessionId
    const reads = (await fixture.control({ op: 'inspect' })).requests as {
      path: string
      query: string
    }[]
    expect(
      reads
        .filter((read) => read.path.endsWith('/transcript'))
        .map((read) => read.query),
    ).toEqual([
      '?agent_id=main&page_size=2',
      '?agent_id=main&page_size=2&before_turn=t3',
      '?agent_id=main&page_size=2&before_turn=t1',
    ])
    expect(fixture.storage.projection().visible).toHaveLength(16)
    await fixture.control({
      op: 'transcript',
      sessionId,
      seq: 11,
      ops: [
        {
          op: 'append',
          target: { type: 'frame', frameId: 'frame-0' },
          offset: 6,
          text: '-next',
        },
      ],
    })
    await observe(fixture, () =>
      fixture.storage
        .projection()
        .visible.some(
          (entry) =>
            (entry.payload as { native?: { text?: string } }).native?.text ===
            'cold-0-next',
        ),
    )
    expect(
      fixture.storage.projection().visible.every((entry) => !entry.root),
    ).toBe(true)
    await fixture.handle.kill()
  }, 30000)
  test('unbridged display removal keeps the original live question usable', async () => {
    const fixture = await setup(),
      sessionId = fixture.handle.binding!.providerSessionId
    const receipt = fixture.handle.prompt('Original live owner')
    await receipt.delivery
    await fixture.control({
      op: 'frame',
      sessionId,
      type: 'event.question.requested',
      payload: {
        question_id: 'unbridged',
        session_id: sessionId,
        turn_id: 0,
        questions: [
          {
            id: 'item',
            question: 'Continue?',
            options: [{ id: 'yes', label: 'Yes' }],
            multi_select: false,
            allow_other: false,
          },
        ],
      },
    })
    await observe(fixture, () =>
      fixture.events.some((event) => event.type === 'question_requested'),
    )
    const request = fixture.events.find(
      (event) => event.type === 'question_requested',
    )!
    await fixture.control({
      op: 'transcript',
      sessionId,
      ops: [
        {
          op: 'turn.upsert',
          turn: { turnId: 't0', ordinal: 1, state: 'completed' },
        },
        {
          op: 'frame.upsert',
          turnId: 't0',
          stepId: 't0.1',
          frame: {
            frameId: 'cold',
            kind: 'text',
            role: 'assistant',
            text: 'Historical',
          },
        },
        { op: 'items.remove', ids: ['t0'] },
      ],
    })
    await observe(
      fixture,
      () => fixture.storage.projection().removedItemIds.length === 2,
    )
    expect(
      fixture.events.filter((event) => event.type === 'request_cancelled'),
    ).toEqual([])
    await fixture.handle.replyQuestion!(request.request.requestId, {
      item: { type: 'selected', optionIds: ['yes'] },
    })
    await finish(fixture)
    expect((await receipt.completion).status).toBe('completed')
    await fixture.handle.kill()
  }, 30000)
  test('a delayed final page fails completion before publication and retains its physical HTTP and page ownership', async () => {
    const fixture = await setup({ messageMs: 30 })
    const receipt = fixture.handle.prompt('Held final page')
    await receipt.delivery
    await fixture.control({ op: 'scenario', value: { holdMessages: true } })
    await finish(fixture)
    expect(await receipt.completion).toMatchObject({
      status: 'failed',
      code: 'kimi_final_content_unavailable',
    })
    expect(
      fixture.storage.rows
        .flatMap((row) => row.records)
        .some((entry) => entry.kind === 'content.unavailable'),
    ).toBe(true)
    expect(
      (fixture.host as KimiHostOwner).budget.count('hostHttpBufferBytes'),
    ).toBeGreaterThanOrEqual(3 * 8388608)
    expect(
      fixture.storage
        .projection()
        .visible.filter((entry) => entry.kind === 'message'),
    ).toEqual([])
    await fixture.control({ op: 'releaseMessages' })
    await observe(
      fixture,
      () =>
        (fixture.host as KimiHostOwner).budget.count('hostHttpBufferBytes') ===
        0,
    )
    await fixture.handle.kill()
  }, 30000)
})

describe('1. Authority and startup', () => {
  test('validates every named ceiling and zero-only limits', () => {
    expect(Object.keys(kimiLimitCeilings)).toHaveLength(145)
    expect(kimiLimits()).toEqual(kimiLimitCeilings)
    for (const [key, value] of Object.entries(kimiLimitCeilings)) {
      expect(() => kimiLimits({ [key]: value })).not.toThrow()
      for (const invalid of [-1, 0.5, Infinity, NaN, value + 1])
        expect(() => kimiLimits({ [key]: invalid })).toThrow()
      if (value) expect(() => kimiLimits({ [key]: 0 })).toThrow()
    }
    expect(sequence(0)).toBe(0)
    expect(() => sequence(-1)).toThrow()
  })
  test('rejects invalid authority before launch and compares complete model environment', async () => {
    const selected = await authority(),
      limits = kimiLimits()
    expect(() =>
      captureAuthority(
        { ...selected, account: { ...selected.account, disabledAt: 1 } },
        limits,
      ),
    ).toThrow()
    expect(() =>
      captureAuthority(
        { ...selected, harness: { ...selected.harness, args: ['--other'] } },
        limits,
      ),
    ).toThrow()
    for (const key of kimiModelOverrides)
      await expect(
        effectiveAuthority(
          captureAuthority(
            {
              ...selected,
              environment: { ...selected.environment, [key]: 'dummy' },
            },
            limits,
          ),
        ),
      ).rejects.toMatchObject({ code: 'kimi_unowned_model_override' })
    const a = await effectiveAuthority(captureAuthority(selected, limits))
    const b = await effectiveAuthority(
      captureAuthority(
        {
          ...selected,
          harness: {
            ...selected.harness,
            env: { KIMI_MODEL_NAME: 'fixture-two' },
          },
        },
        limits,
      ),
    )
    expect(sameAuthority(a, b)).toBe(false)
  })
  test('launches the actual guardian and preserves native token across clean shutdown', async () => {
    const fixture = await setup()
    expect(fixture.handle.binding?.cwd).toBe(fixture.cwd)
    const tokenPath = join(fixture.selected.account.homePath, 'server.token'),
      before = await stat(tokenPath)
    expect(before.mode & 0o777).toBe(0o600)
    expect((await readFile(tokenPath)).length).toBe(43)
    await fixture.handle.kill()
    const catalog = await discoverKimi({
      authority: fixture.selected,
      host: fixture.host,
      signal: new AbortController().signal,
    })
    expect(catalog.version).toBe('0.34.0')
    expect((await stat(tokenPath)).ino).toBe(before.ino)
  }, 30000)
})
describe('2. Home concurrency', () => {
  test('one session exhausting IPC cannot stop another session in the shared home', async () => {
    const fixture = await setup({ ipcFrames: 128 }),
      b = await fixture.adapter.spawn(
        {
          id: 'forge-b',
          cwd: await temp(),
          provider: fixture.selected.provider,
          accountId: fixture.selected.account.id,
        },
        () => {},
      )
    const aReceipt = fixture.handle.prompt('A')
    await aReceipt.delivery
    const bReceipt = b.prompt('B')
    expect(
      await Promise.all([aReceipt.delivery, bReceipt.delivery]),
    ).toMatchObject([{ status: 'delivered' }, { status: 'delivered' }])
    for (let index = 0; index < 160; index++)
      await fixture.control({
        op: 'frame',
        sessionId: fixture.handle.binding!.providerSessionId,
        type: 'session.meta.updated',
        payload: { title: `fixture-${index}` },
      })
    expect((await aReceipt.completion).status).toBe('failed')
    await finish(fixture, b)
    expect((await bReceipt.completion).status).toBe('completed')
    expect((await fixture.control({ op: 'inspect' })).sessions).toHaveLength(2)
    await b.kill()
    await fixture.host.close()
  }, 30000)
  test('uncertain cancellation retains A while B completes on the same server', async () => {
    const fixture = await setup(),
      b = await fixture.adapter.spawn(
        {
          id: 'forge-b',
          cwd: await temp(),
          provider: fixture.selected.provider,
          accountId: fixture.selected.account.id,
        },
        () => {},
      )
    const aReceipt = fixture.handle.prompt('A')
    await aReceipt.delivery
    const bReceipt = b.prompt('B')
    expect(
      await Promise.all([aReceipt.delivery, bReceipt.delivery]),
    ).toMatchObject([{ status: 'delivered' }, { status: 'delivered' }])
    await fixture.control({
      op: 'scenario',
      value: { loseAbort: true, holdAbortTerminal: true },
    })
    await expect(fixture.handle.cancel()).rejects.toMatchObject({
      code: 'kimi_cleanup_uncertain',
    })
    expect((await aReceipt.completion).status).toBe('failed')
    expect((fixture.host as KimiHostOwner).budget.count('hostSessions')).toBe(2)
    await finish(fixture, b)
    expect((await bReceipt.completion).status).toBe('completed')
    await b.kill()
    expect((fixture.host as KimiHostOwner).budget.count('hostSessions')).toBe(1)
    await fixture.host.close()
    expect((fixture.host as KimiHostOwner).budget.count('hostSessions')).toBe(0)
  }, 30000)
  test('resident capacity survives detach and cannot interrupt a remaining session', async () => {
    const fixture = await setup({ homeResidentSessions: 2 }),
      b = await fixture.adapter.spawn(
        {
          id: 'forge-b',
          cwd: await temp(),
          provider: fixture.selected.provider,
          accountId: fixture.selected.account.id,
        },
        () => {},
      )
    await fixture.handle.kill()
    await expect(
      fixture.adapter.spawn(
        {
          id: 'forge-c',
          cwd: await temp(),
          provider: fixture.selected.provider,
          accountId: fixture.selected.account.id,
        },
        () => {},
      ),
    ).rejects.toBeDefined()
    const receipt = b.prompt('B after rejected C')
    await receipt.delivery
    await finish(fixture, b)
    expect((await receipt.completion).status).toBe('completed')
    const inspection = await fixture.control({ op: 'inspect' })
    expect(inspection.sessions).toHaveLength(2)
    expect(
      (inspection.requests as { method: string; path: string }[]).some(
        (r) => r.method === 'DELETE' || /:close|:archive/.test(r.path),
      ),
    ).toBe(false)
    await b.kill()
    expect(
      (fixture.host as KimiHostOwner).budget.count('hostResidentSessions'),
    ).toBe(0)
  }, 30000)
  test('load cannot create a second writer for an existing native session', async () => {
    const fixture = await setup()
    await expect(
      fixture.adapter.load(
        {
          id: 'forge-a',
          cwd: fixture.cwd,
          provider: fixture.selected.provider,
          accountId: fixture.selected.account.id,
          binding: fixture.handle.binding,
        },
        () => {},
      ),
    ).rejects.toBeDefined()
    expect((await fixture.control({ op: 'inspect' })).sessions).toHaveLength(1)
    await fixture.handle.kill()
  }, 30000)
  test('shares one server across workspaces and cancels only A', async () => {
    const fixture = await setup(),
      cwdB = await temp()
    const b = await fixture.adapter.spawn(
      {
        id: 'forge-b',
        cwd: cwdB,
        provider: fixture.selected.provider,
        accountId: fixture.selected.account.id,
      },
      (event) => fixture.events.push(event),
    )
    const inspect = await fixture.control({ op: 'inspect' })
    expect(inspect.cwd).toBe(fixture.selected.account.homePath)
    expect(inspect.sessions).toHaveLength(2)
    expect(b.binding?.cwd).toBe(cwdB)
    const aReceipt = fixture.handle.prompt('A')
    await aReceipt.delivery
    const bReceipt = b.prompt('B')
    expect(await aReceipt.delivery).toMatchObject({ status: 'delivered' })
    expect(await bReceipt.delivery).toMatchObject({ status: 'delivered' })
    await fixture.handle.cancel()
    expect((await aReceipt.completion).status).toBe('interrupted')
    await finish(fixture, b)
    expect((await bReceipt.completion).status).toBe('completed')
    await fixture.handle.kill()
    await b.kill()
  }, 30000)
  test('locks aliases through one permanent descriptor and permits clean reuse', async () => {
    const selected = await authority(),
      runtime = await temp(),
      effective = await effectiveAuthority(selected)
    const lock = await KimiHomeLock.acquire(
      effective.home,
      kimiLimits(),
      runtime,
    )
    const alias = join(await temp(), 'alias')
    await symlink(selected.account.homePath, alias)
    const aliasAuthority = await effectiveAuthority({
      ...selected,
      account: { ...selected.account, homePath: alias },
    })
    await expect(
      KimiHomeLock.acquire(aliasAuthority.home, kimiLimits(), runtime),
    ).rejects.toMatchObject({ code: 'kimi_account_home_busy' })
    await lock.release(true)
    const replacement = await KimiHomeLock.acquire(
      effective.home,
      kimiLimits(),
      runtime,
    )
    await replacement.release(true)
  })
  test('concurrent registrations keep one permanent inode and refuse malformed dirty markers', async () => {
    const selected = await authority(),
      runtime = await temp(),
      effective = await effectiveAuthority(selected)
    const results = await Promise.allSettled([
      KimiHomeLock.acquire(effective.home, kimiLimits(), runtime),
      KimiHomeLock.acquire(effective.home, kimiLimits(), runtime),
    ])
    const accepted = results.filter((value) => value.status === 'fulfilled')
    expect(accepted).toHaveLength(1)
    const lock = accepted[0].value
    await lock.release(true)
    const directory = join(runtime, 'forge-kimi'),
      name = (await readdir(directory)).find((name) =>
        /^[a-f0-9]{64}\.lock$/.test(name),
      )!,
      path = join(directory, name)
    const inode = (await stat(path)).ino
    const again = await KimiHomeLock.acquire(
      effective.home,
      kimiLimits(),
      runtime,
    )
    await again.release(true)
    expect((await stat(path)).ino).toBe(inode)
    for (const marker of [
      '{',
      JSON.stringify({
        state: 'starting',
        boot: (
          await readFile('/proc/sys/kernel/random/boot_id', 'utf8')
        ).trim(),
        nonce: 'a'.repeat(32),
      }),
      JSON.stringify({
        state: 'active',
        boot: '00000000-0000-0000-0000-000000000000',
        nonce: 'a'.repeat(32),
        pgid: 'invalid',
        startTicks: '1',
      }),
    ]) {
      await writeFile(path, marker)
      await expect(
        KimiHomeLock.acquire(effective.home, kimiLimits(), runtime),
      ).rejects.toMatchObject({ code: 'kimi_home_cleanup_unproved' })
    }
  })
})
describe('3. Acceptance and terminals', () => {
  test('a hidden authorized writer cannot supply another receipt’s root', async () => {
    const entered = controlled<void>(),
      release = controlled<void>()
    const fixture = await setup(
      {},
      {
        beforeDispatch: async () => {
          entered.resolve()
          await release.promise
        },
      },
    )
    await fixture.control({ op: 'scenario', value: { holdNextPrompt: true } })
    const inspection = await fixture.control({ op: 'inspect' })
    const token = await readFile(
      join(fixture.selected.account.homePath, 'server.token'),
      'utf8',
    )
    const foreign = fetch(
      `http://127.0.0.1:${inspection.port}/api/v1/sessions/${fixture.handle.binding!.providerSessionId}/prompts`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Request-Id': newKimiRequestId(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: [{ type: 'text', text: 'Foreign writer' }],
        }),
      },
    )
    await observe(fixture, (view) =>
      (view.requests as { method: string; path: string }[]).some(
        (r) => r.method === 'POST' && r.path.endsWith('/prompts'),
      ),
    )
    const ownedReceipt = fixture.handle.prompt('Owned writer')
    await entered.promise
    await fixture.control({ op: 'releasePrompts' })
    await (await foreign).arrayBuffer()
    release.resolve()
    expect(await ownedReceipt.delivery).toMatchObject({
      status: 'unknown',
      code: 'kimi_turn_owner_unknown',
    })
    expect((await ownedReceipt.completion).status).toBe('failed')
    expect(
      fixture.events.some((event) =>
        [
          'turn_started',
          'content_snapshot',
          'text_delta',
          'question_requested',
        ].includes(event.type),
      ),
    ).toBe(false)
    await fixture.host.close()
  }, 30000)
  test('blocked acceptance settles its own receipt without inventing a turn', async () => {
    const fixture = await setup()
    await fixture.control({ op: 'scenario', value: { blocked: true } })
    const receipt = fixture.handle.prompt('Blocked')
    expect(await receipt.nativeAcceptance).toMatchObject({
      status: 'accepted',
      nativeStatus: 'blocked',
    })
    expect(await receipt.delivery).toMatchObject({ status: 'not_delivered' })
    expect((await receipt.completion).status).toBe('failed')
    expect(fixture.events.some((event) => event.type === 'turn_started')).toBe(
      false,
    )
    await fixture.handle.kill()
  }, 30000)
  test('a missing pre-dispatch anchor prevents successful final content', async () => {
    const fixture = await setup(),
      sid = fixture.handle.binding!.providerSessionId
    await fixture.control({
      op: 'message',
      sessionId: sid,
      id: 'before-anchor',
      role: 'assistant',
      content: [{ type: 'text', text: 'Prior content' }],
    })
    const receipt = fixture.handle.prompt('New root')
    await receipt.delivery
    await fixture.control({
      op: 'scenario',
      value: { removeAnchor: 'before-anchor' },
    })
    await finish(fixture)
    expect((await receipt.completion).status).toBe('failed')
    expect(
      fixture.events.some((event) => event.type === 'content_snapshot'),
    ).toBe(false)
    await fixture.host.close()
  }, 30000)
  test('buffers pre-response starts and waits for the actual message barrier', async () => {
    const fixture = await setup()
    const receipt = fixture.handle.prompt('Hello')
    expect(await receipt.nativeAcceptance).toMatchObject({
      status: 'accepted',
      nativeStatus: 'running',
    })
    expect(await receipt.delivery).toMatchObject({
      status: 'delivered',
      mode: 'root',
    })
    await fixture.control({ op: 'scenario', value: { holdMessages: true } })
    let settled = false
    void receipt.completion.then(() => {
      settled = true
    })
    await finish(fixture)
    // The command barrier confirms both terminals were sent while the message read remains held.
    await fixture.control({ op: 'inspect' })
    expect(settled).toBe(false)
    await fixture.control({ op: 'releaseMessages' })
    expect((await receipt.completion).status).toBe('completed')
    expect(
      fixture.events.some(
        (event) =>
          event.type === 'content_snapshot' && event.text === 'Final text',
      ),
    ).toBe(true)
    expect(new Set(fixture.events.map((event) => event.deliveryId)).size).toBe(
      fixture.events.length,
    )
    await fixture.handle.kill()
  }, 30000)
  test('lost POST never retries', async () => {
    const fixture = await setup()
    await fixture.control({ op: 'scenario', value: { losePost: true } })
    const receipt = fixture.handle.prompt('Uncertain')
    expect(await receipt.nativeAcceptance).toMatchObject({ status: 'unknown' })
    expect((await receipt.completion).status).toBe('failed')
    const inspection = await fixture.control({ op: 'inspect' })
    expect(
      (inspection.requests as { path: string; method: string }[]).filter(
        (request) =>
          request.method === 'POST' && request.path.endsWith('/prompts'),
      ),
    ).toHaveLength(1)
    await fixture.host.close()
  }, 30000)
})
describe('4. Steering and queue', () => {
  test('a root ending during the steer hook yields a separately proved root', async () => {
    const entered = controlled<void>(),
      resume = controlled<void>()
    let calls = 0
    const fixture = await setup(
      {},
      {
        beforeDispatch: async () => {
          if (++calls === 2) {
            entered.resolve()
            await resume.promise
          }
        },
      },
    )
    const first = fixture.handle.prompt('First')
    await first.delivery
    const second = fixture.handle.steer('Second')
    await entered.promise
    await finish(fixture)
    expect((await first.completion).status).toBe('completed')
    resume.resolve()
    expect(await second.delivery).toMatchObject({
      status: 'delivered',
      mode: 'root',
      providerTurnId: '1',
    })
    await finish(fixture)
    expect((await second.completion).status).toBe('completed')
    const inspection = await fixture.control({ op: 'inspect' })
    expect(
      (inspection.requests as { path: string }[]).some((row) =>
        row.path.endsWith('prompts:steer'),
      ),
    ).toBe(false)
    await fixture.handle.kill()
  }, 30000)
  test('literal steering edge links a second receipt to only its active root', async () => {
    const fixture = await setup(),
      rootReceipt = fixture.handle.prompt('Root')
    await rootReceipt.delivery
    const steer = fixture.handle.steer('More')
    expect(await steer.delivery).toMatchObject({
      status: 'delivered',
      mode: 'steer',
    })
    await finish(fixture)
    expect(await rootReceipt.completion).toMatchObject({
      status: 'failed',
      code: 'kimi_final_content_unavailable',
    })
    expect(await steer.completion).toMatchObject({
      status: 'failed',
      code: 'kimi_final_content_unavailable',
    })
    await fixture.handle.kill()
  }, 30000)
})
describe('5. Wire ownership and control', () => {
  test('uses unique valid native request IDs', () => {
    const ids = Array.from({ length: 200 }, newKimiRequestId)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
  })
})
describe('6. Replay and snapshots', () => {
  test.each(['buffer_overflow', 'session_recreated', 'epoch_changed'])(
    'resync %s reads a new snapshot before restoring both subscriptions',
    async (reason) => {
      const fixture = await setup(),
        id = fixture.handle.binding!.providerSessionId
      const receipt = fixture.handle.prompt('Recover the owned root')
      expect((await receipt.delivery).status).toBe('delivered')
      const before = (
        (await fixture.control({ op: 'inspect' })).requests as {
          path: string
        }[]
      ).filter((row) => row.path.endsWith('/transcript')).length
      await fixture.control({ op: 'resync', sessionId: id, reason })
      await observe(
        fixture,
        (value) =>
          (value.requests as { path: string }[]).filter((row) =>
            row.path.endsWith('/transcript'),
          ).length > before,
      )
      await finish(fixture)
      expect((await receipt.completion).status).toBe('completed')
      const inspection = await fixture.control({ op: 'inspect' })
      expect(
        (inspection.requests as { path: string }[]).filter((request) =>
          request.path.endsWith('/snapshot'),
        ).length,
      ).toBeGreaterThan(3)
      expect(
        (inspection.sockets as { role: string }[])
          .map((socket) => socket.role)
          .sort(),
      ).toEqual(['life', 'transcript'])
      await fixture.handle.kill()
    },
    30000,
  )
  test('replaces physically closed sockets and keeps the immutable receipt owner', async () => {
    const fixture = await setup(),
      id = fixture.handle.binding!.providerSessionId
    const receipt = fixture.handle.prompt('Reconnect')
    const delivery = await receipt.delivery
    await fixture.control({ op: 'closeSockets', sessionId: id })
    await observe(
      fixture,
      (value) =>
        (value.sockets as unknown[]).length === 2 &&
        (value.requests as { path: string }[]).filter((row) =>
          row.path.endsWith('/transcript'),
        ).length > 1,
    )
    await finish(fixture)
    expect((await receipt.completion).status).toBe('completed')
    expect(await receipt.delivery).toEqual(delivery)
    await fixture.handle.kill()
  }, 30000)
  test('heals a missing transcript batch through the real ops route', async () => {
    const fixture = await setup(),
      id = fixture.handle.binding!.providerSessionId
    const receipt = fixture.handle.prompt('Projection')
    await receipt.delivery
    const frame = {
      op: 'frame.upsert',
      turnId: 't0',
      stepId: 't0.1',
      frame: { frameId: 'f0', kind: 'text', role: 'assistant', text: 'A😀' },
    }
    await fixture.control({
      op: 'transcript',
      sessionId: id,
      hidden: true,
      ops: [frame],
    })
    await fixture.control({
      op: 'transcript',
      sessionId: id,
      ops: [
        {
          op: 'append',
          target: { type: 'frame', frameId: 'f0' },
          offset: 3,
          text: 'B',
        },
      ],
    })
    await observe(fixture, () =>
      fixture.storage
        .projection()
        .visible.some(
          (entry) =>
            (entry.payload as { native?: { text?: string } }).native?.text ===
            'A😀B',
        ),
    )
    expect(
      fixture.storage.rows
        .flatMap((row) => row.records)
        .filter(
          (entry) =>
            entry.kind === 'projection.item' &&
            (entry.payload as { native?: { text?: string } }).native?.text ===
              'A😀',
        ),
    ).toHaveLength(1)
    const inspection = await fixture.control({ op: 'inspect' })
    expect(
      (inspection.requests as { path: string }[]).some((request) =>
        request.path.endsWith('/transcript/ops'),
      ),
    ).toBe(true)
    await finish(fixture, fixture.handle, 'A😀B')
    expect((await receipt.completion).status).toBe('completed')
    await fixture.handle.kill()
  }, 30000)
  test('incomplete catch-up fetches a real snapshot before rebuilding its baseline', async () => {
    const fixture = await setup(),
      sessionId = fixture.handle.binding!.providerSessionId
    const receipt = fixture.handle.prompt('Incomplete catch-up')
    await receipt.delivery
    await fixture.control({
      op: 'scenario',
      value: { incompleteTranscript: true },
    })
    await fixture.control({
      op: 'transcript',
      sessionId,
      hidden: true,
      ops: [],
    })
    await fixture.control({ op: 'transcript', sessionId, ops: [] })
    await observe(fixture, () =>
      fixture.storage.rows.some((row) => row.checkpoint.transcripts.main === 2),
    )
    await observe(
      fixture,
      () =>
        (fixture.host as KimiHostOwner).budget.count('hostTimers') ===
        guardianLimits((fixture.host as KimiHostOwner).budget.limits)
          .hostTimers,
    )
    const inspection = await fixture.control({ op: 'inspect' })
    expect(
      (inspection.requests as { path: string }[]).filter((row) =>
        row.path.endsWith('/transcript'),
      ).length,
    ).toBeGreaterThan(1)
    await finish(fixture)
    expect((await receipt.completion).status).toBe('completed')
    await fixture.handle.kill()
  }, 30000)
  test('an empty reset discards live step bridges and cannot reparent cold content', async () => {
    const fixture = await setup(),
      id = fixture.handle.binding!.providerSessionId
    const receipt = fixture.handle.prompt('Reset')
    await receipt.delivery
    await fixture.control({
      op: 'transcript',
      sessionId: id,
      ops: [{ op: 'reset', snapshot: { items: [], seq: 1 } }],
    })
    await fixture.control({
      op: 'transcript',
      sessionId: id,
      ops: [
        {
          op: 'frame.upsert',
          turnId: 't0',
          stepId: 't0.1',
          frame: { frameId: 'cold', kind: 'text', text: 'Unproved cold text' },
        },
      ],
    })
    await observe(fixture, () =>
      fixture.storage.rows.some((row) => row.checkpoint.transcripts.main === 2),
    )
    expect(
      fixture.events.some(
        (event) =>
          event.type === 'content_snapshot' &&
          event.text === 'Unproved cold text',
      ),
    ).toBe(false)
    await finish(fixture)
    expect((await receipt.completion).status).toBe('completed')
    await fixture.handle.kill()
  }, 30000)
  test('exhausted recovery fails without publishing unproved transcript content', async () => {
    const fixture = await setup({ recoveries: 1 }),
      id = fixture.handle.binding!.providerSessionId
    const receipt = fixture.handle.prompt('Recovery ceiling')
    await receipt.delivery
    await fixture.control({
      op: 'resync',
      sessionId: id,
      reason: 'buffer_overflow',
    })
    await observe(
      fixture,
      (value) =>
        (value.requests as { path: string }[]).filter((row) =>
          row.path.endsWith('/transcript'),
        ).length > 1,
    )
    await observe(
      fixture,
      () =>
        (fixture.host as KimiHostOwner).budget.count('hostTimers') ===
        guardianLimits((fixture.host as KimiHostOwner).budget.limits)
          .hostTimers,
    )
    await fixture.control({
      op: 'resync',
      sessionId: id,
      reason: 'buffer_overflow',
    })
    expect((await receipt.completion).status).toBe('failed')
    expect(
      fixture.events.some(
        (event) =>
          event.type === 'turn_completed' &&
          event.outcome.status === 'completed',
      ),
    ).toBe(false)
    await fixture.host.close()
  }, 30000)
  test('buffers live sequence 25 before replay 21 until the matching cut', async () => {
    const applied: number[] = [],
      replay = new KimiReplay(
        { epoch: 'fixture', seq: 20 },
        new KimiBudget(kimiLimits()),
        async (frame) => {
          applied.push(frame.seq)
        },
      )
    for (const seq of [25, 21, 23, 22, 24, 25])
      replay.push({
        type: 'turn.started',
        payload: {},
        epoch: 'fixture',
        seq,
        session_id: 'fixture',
      })
    expect(applied).toEqual([])
    await replay.acknowledge({ epoch: 'fixture', seq: 25 })
    expect(applied).toEqual([21, 22, 23, 24, 25])
    replay.dispose()
  })
})
describe('7. Content and children', () => {
  test('corrective content, tools, notices, and todo slots keep their source identities', async () => {
    const fixture = await setup(),
      sessionId = fixture.handle.binding!.providerSessionId
    const receipt = fixture.handle.prompt('Structured content')
    await receipt.delivery
    await fixture.control({
      op: 'frame',
      sessionId,
      type: 'tool.call.started',
      payload: {
        turnId: 0,
        toolCallId: 'todo-tool',
        name: 'TodoWrite',
        input: {},
      },
    })
    await observe(fixture, () =>
      fixture.storage.rows.some((row) =>
        row.records.some((entry) => entry.kind === 'tool.call.started'),
      ),
    )
    const upsert = (text: string) => ({
      op: 'frame.upsert',
      turnId: 't0',
      stepId: 't0.1',
      frame: {
        frameId: 'text',
        kind: 'text',
        role: 'assistant',
        text,
        nativeUnknown: { preserved: true },
      },
    })
    for (const text of ['Long text', 'X', ''])
      await fixture.control({
        op: 'transcript',
        sessionId,
        ops: [upsert(text)],
      })
    await fixture.control({
      op: 'transcript',
      sessionId,
      ops: [
        {
          op: 'frame.upsert',
          turnId: 't0',
          stepId: 't0.1',
          frame: { frameId: 'thought', kind: 'thinking', text: 'Thought' },
        },
        {
          op: 'frame.upsert',
          turnId: 't0',
          stepId: 't0.1',
          frame: {
            frameId: 'user',
            kind: 'text',
            role: 'user',
            text: 'User text',
          },
        },
        {
          op: 'frame.upsert',
          turnId: 't0',
          stepId: 't0.1',
          frame: {
            frameId: 'tool',
            kind: 'tool',
            toolCallId: 'todo-tool',
            name: 'TodoWrite',
            state: 'completed',
            todoId: 'todo',
            input: {},
            output: { saved: true },
          },
        },
        {
          op: 'todo.upsert',
          todo: {
            todoId: 'todo',
            items: [{ title: 'First', status: 'pending' }],
          },
        },
        {
          op: 'frame.upsert',
          turnId: 't0',
          stepId: 't0.1',
          frame: {
            frameId: 'notice',
            kind: 'notice',
            level: 'warning',
            message: 'Native notice',
          },
        },
      ],
    })
    await fixture.control({
      op: 'transcript',
      sessionId,
      ops: [
        {
          op: 'todo.upsert',
          todo: {
            todoId: 'todo',
            items: [{ title: 'Changed title', status: 'done' }],
          },
        },
      ],
    })
    await observe(
      fixture,
      () =>
        fixture.events.filter((event) => event.type === 'plan').length === 2,
    )
    const snapshots = fixture.storage.rows
      .flatMap((row) => row.records)
      .filter(
        (entry) =>
          entry.kind === 'projection.item' &&
          (entry.payload as { native?: { frameId?: string } }).native
            ?.frameId === 'text',
      )
    expect(
      snapshots.map(
        (entry) => (entry.payload as { native: { text: string } }).native.text,
      ),
    ).toEqual(['Long text', 'X', ''])
    expect(
      new Set(
        snapshots.map((entry) => (entry.payload as { itemId: string }).itemId),
      ).size,
    ).toBe(1)
    expect(
      snapshots.every(
        (entry) => !entry.root && entry.sourceIdentity.domain === 'cold-import',
      ),
    ).toBe(true)
    const plans = fixture.events.filter((event) => event.type === 'plan')
    expect(plans[0].steps[0].id).toBe(plans[1].steps[0].id)
    expect(plans[1].steps[0]).toMatchObject({
      title: 'Changed title',
      status: 'completed',
    })
    expect(
      fixture.events.some(
        (event) => event.type === 'tool_update' && event.status === 'completed',
      ),
    ).toBe(true)
    expect(
      fixture.storage
        .projection()
        .visible.some(
          (entry) =>
            (entry.payload as { native?: { message?: string } }).native
              ?.message === 'Native notice',
        ),
    ).toBe(true)
    expect(
      fixture.storage
        .projection()
        .visible.some((entry) =>
          JSON.stringify(entry.payload).includes('nativeUnknown'),
        ),
    ).toBe(true)
    await finish(fixture)
    expect((await receipt.completion).status).toBe('completed')
    expect(
      fixture.storage
        .projection()
        .visible.filter((entry) => entry.root)
        .every(
          (entry) =>
            entry.kind === 'message' || entry.kind.startsWith('media.'),
        ),
    ).toBe(true)
    await fixture.handle.kill()
  }, 30000)
  test('keeps reused child executions and usage under their original roots', async () => {
    const fixture = await setup(),
      sessionId = fixture.handle.binding!.providerSessionId
    const send = (type: string, payload: unknown) =>
      fixture.control({ op: 'frame', sessionId, type, payload })
    const a = fixture.handle.prompt('Root A', undefined, {
      runId: 'run',
      turnId: 'A',
    })
    await a.delivery
    await send('agent.created', { agentId: 'C' })
    await send('tool.call.started', {
      turnId: 0,
      toolCallId: 'X',
      name: 'Agent',
      input: {},
    })
    await send('subagent.spawned', {
      subagentId: 'C',
      subagentName: 'Child',
      parentToolCallId: 'X',
      runInBackground: true,
    })
    await send('turn.started', {
      agentId: 'C',
      turnId: 0,
      origin: { kind: 'user' },
    })
    await send('turn.step.completed', {
      agentId: 'C',
      turnId: 0,
      step: 1,
      usage: {
        inputOther: 2,
        output: 3,
        inputCacheRead: 4,
        inputCacheCreation: 5,
      },
    })
    await send('subagent.completed', {
      subagentId: 'C',
      resultSummary: 'Child A completed',
    })
    await observe(fixture, () =>
      fixture.events.some((event) => event.type === 'child_finished'),
    )
    expect(
      fixture.events.some((event) => event.type === 'turn_completed'),
    ).toBe(false)
    await finish(fixture)
    expect((await a.completion).status).toBe('completed')
    const b = fixture.handle.prompt('Root B', undefined, {
      runId: 'run',
      turnId: 'B',
    })
    await b.delivery
    await send('tool.call.started', {
      turnId: 1,
      toolCallId: 'Y',
      name: 'Agent',
      input: {},
    })
    await send('subagent.spawned', {
      subagentId: 'C',
      subagentName: 'Child',
      parentToolCallId: 'Y',
      runInBackground: true,
    })
    await send('turn.started', {
      agentId: 'C',
      turnId: 1,
      origin: { kind: 'user' },
    })
    await send('agent.disposed', { agentId: 'C' })
    await observe(
      fixture,
      () =>
        fixture.events.filter((event) => event.type === 'child_finished')
          .length === 2,
    )
    const starts = fixture.events.filter(
      (event) => event.type === 'child_started',
    )
    const ends = fixture.events.filter(
      (event) => event.type === 'child_finished',
    )
    expect(starts.map((event) => event.turnId)).toEqual(['A', 'B'])
    expect(new Set(starts.map((event) => event.childId)).size).toBe(2)
    expect(ends.map((event) => [event.turnId, event.outcome.status])).toEqual([
      ['A', 'completed'],
      ['B', 'failed'],
    ])
    expect(
      fixture.events.filter((event) => event.type === 'usage'),
    ).toMatchObject([
      {
        turnId: 'A',
        childId: starts[0].childId,
        inputTokens: 11,
        outputTokens: 3,
        totalTokens: 14,
      },
    ])
    expect(
      fixture.storage.rows
        .flatMap((row) => row.records)
        .filter((entry) => entry.kind === 'child.terminal')
        .map(
          (entry) =>
            (entry.payload as { contentCoverage: string }).contentCoverage,
        ),
    ).toEqual(['partial', 'partial'])
    await finish(fixture)
    expect((await b.completion).status).toBe('completed')
    await fixture.handle.kill()
  }, 30000)
  test('whole-turn removal replaces the stored subtree and disables its original request', async () => {
    const fixture = await setup(),
      sessionId = fixture.handle.binding!.providerSessionId
    const receipt = fixture.handle.prompt('Remove native turn')
    await receipt.delivery
    await fixture.control({
      op: 'frame',
      sessionId,
      type: 'tool.call.started',
      payload: { turnId: 0, toolCallId: 'X', name: 'Read', input: {} },
    })
    await observe(fixture, () =>
      fixture.storage.rows.some((row) =>
        row.records.some((entry) => entry.kind === 'tool.call.started'),
      ),
    )
    await fixture.control({
      op: 'transcript',
      sessionId,
      ops: [
        { op: 'turn.upsert', turn: { turnId: 't0' } },
        {
          op: 'frame.upsert',
          turnId: 't0',
          stepId: 't0.1',
          frame: { frameId: 'text', kind: 'text', text: 'Visible' },
        },
        {
          op: 'frame.upsert',
          turnId: 't0',
          stepId: 't0.1',
          frame: {
            frameId: 'tool',
            kind: 'tool',
            toolCallId: 'X',
            name: 'Read',
            state: 'running',
            input: {},
          },
        },
        {
          op: 'attachment.upsert',
          turnId: 't0',
          stepId: 't0.1',
          attachment: { attachmentId: 'image', kind: 'image' },
        },
      ],
    })
    await fixture.control({
      op: 'frame',
      sessionId,
      type: 'event.question.requested',
      payload: {
        question_id: 'remove:question',
        session_id: sessionId,
        turn_id: 0,
        questions: [
          {
            id: 'item',
            question: 'Continue?',
            options: [{ id: 'yes', label: 'Yes' }],
            multi_select: false,
            allow_other: false,
          },
        ],
      },
    })
    await observe(fixture, () =>
      fixture.events.some((event) => event.type === 'question_requested'),
    )
    const request = fixture.events.find(
      (event) => event.type === 'question_requested',
    )!
    expect(fixture.storage.projection().visible).toHaveLength(4)
    await fixture.control({
      op: 'transcript',
      sessionId,
      ops: [{ op: 'items.remove', ids: ['t0'] }],
    })
    await observe(
      fixture,
      () => fixture.storage.projection().removedItemIds.length === 4,
    )
    expect(fixture.storage.projection().visible).toEqual([])
    await expect(
      fixture.handle.replyQuestion!(request.request.requestId, {
        item: { type: 'selected', optionIds: ['yes'] },
      }),
    ).rejects.toBeDefined()
    const inspection = await fixture.control({ op: 'inspect' })
    expect(
      (inspection.requests as { method: string; path: string }[]).filter(
        (request) =>
          request.method === 'POST' && request.path.endsWith(':reply'),
      ),
    ).toEqual([])
    const timeline = foldTimeline(
      fixture.storage.events.map((event, index) => ({
        kind: 'delta',
        cursor: index + 1,
        event,
      })),
    )
    expect(
      timeline.events.filter((event) => event.type === 'request_cancelled'),
    ).toHaveLength(1)
    expect(
      new Set(fixture.storage.events.map((event) => event.deliveryId)).size,
    ).toBe(fixture.storage.events.length)
    await fixture.handle.cancel()
    await receipt.completion
    await fixture.handle.kill()
  }, 30000)
  test('cumulative usage stays separate from latest-call counters and is deduplicated', async () => {
    const fixture = await setup(),
      sessionId = fixture.handle.binding!.providerSessionId
    const receipt = fixture.handle.prompt('Usage')
    await receipt.delivery
    await fixture.control({
      op: 'frame',
      sessionId,
      type: 'turn.step.completed',
      payload: {
        turnId: 0,
        step: 1,
        usage: {
          inputOther: 1,
          output: 2,
          inputCacheRead: 3,
          inputCacheCreation: 4,
        },
      },
    })
    const payload = {
      usage: {
        total: {
          inputOther: 10,
          output: 20,
          inputCacheRead: 30,
          inputCacheCreation: 40,
        },
      },
      maxContextTokens: 1000,
    }
    await fixture.control({
      op: 'frame',
      sessionId,
      type: 'agent.status.updated',
      payload,
    })
    await fixture.control({
      op: 'frame',
      sessionId,
      type: 'agent.status.updated',
      payload,
    })
    await finish(fixture)
    expect((await receipt.completion).status).toBe('completed')
    const usage = fixture.events.filter((event) => event.type === 'usage')
    expect(usage).toHaveLength(2)
    expect(usage[1]).toMatchObject({
      inputTokens: 8,
      outputTokens: 2,
      totalTokens: 10,
      cumulative: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
      modelContextWindow: 1000,
    })
    await fixture.handle.kill()
  }, 30000)
  test('keeps full native signatures and system roles during main-message import', async () => {
    const fixture = await setup(),
      sid = fixture.handle.binding!.providerSessionId
    await fixture.control({
      op: 'message',
      sessionId: sid,
      id: 'native-system',
      role: 'system',
      content: [{ type: 'text', text: 'System context' }],
    })
    await fixture.control({
      op: 'message',
      sessionId: sid,
      id: 'native-assistant',
      role: 'assistant',
      content: [
        {
          type: 'thinking',
          thinking: 'Reason',
          signature: 'fixture-signature',
        },
      ],
    })
    const result = await readKimiHistory({
      authority: fixture.selected,
      host: fixture.host,
      binding: fixture.handle.binding!,
      importScope: { sessionId: 'forge-a', importId: 'import-one' },
      readState: fixture.storage.read,
      commitRecords: fixture.storage.sink,
      storeAttachment: fixture.storage.attachment,
      signal: new AbortController().signal,
    })
    expect(result.complete).toBe(true)
    expect(JSON.stringify(fixture.storage.rows)).toContain('fixture-signature')
    expect(JSON.stringify(fixture.storage.rows)).toContain('System context')
    await fixture.handle.kill()
  }, 30000)
})
describe('8. Questions and approvals', () => {
  test.each(['approve_session', 'reject'])(
    'approval %s requires explicit input and a committed native outcome',
    async (choice) => {
      const fixture = await setup(),
        sessionId = fixture.handle.binding!.providerSessionId
      const receipt = fixture.handle.prompt('Approval')
      await receipt.delivery
      await fixture.control({
        op: 'frame',
        sessionId,
        type: 'event.approval.requested',
        payload: {
          approval_id: 'approval:one',
          session_id: sessionId,
          turn_id: 0,
          action: 'Run fixture command',
          tool_name: 'Shell',
          tool_input: {},
        },
      })
      await observe(fixture, () =>
        fixture.events.some((event) => event.type === 'permission_requested'),
      )
      const request = fixture.events.find(
        (event) => event.type === 'permission_requested',
      )!
      const before = await fixture.control({ op: 'inspect' })
      expect(
        (before.requests as { method: string; path: string }[]).filter(
          (row) => row.method === 'POST' && row.path.includes('/approvals/'),
        ),
      ).toEqual([])
      await fixture.handle.replyPermission!({
        requestId: request.request.requestId,
        type: 'selected',
        optionId: choice,
      })
      const inspection = await fixture.control({ op: 'inspect' })
      const writes = (
        inspection.requests as { method: string; path: string; body: unknown }[]
      ).filter(
        (row) => row.method === 'POST' && row.path.includes('/approvals/'),
      )
      expect(writes).toHaveLength(1)
      expect(writes[0].body).toEqual(
        choice === 'approve_session'
          ? { decision: 'approved', scope: 'session' }
          : { decision: 'rejected' },
      )
      expect(
        fixture.storage.rows.some((row) =>
          row.records.some((entry) => entry.kind === 'request.submitted'),
        ),
      ).toBe(true)
      await finish(fixture)
      await receipt.completion
      await fixture.handle.kill()
    },
    30000,
  )
  test('plan approval loads bounded prose through the native plan route', async () => {
    const fixture = await setup(),
      sessionId = fixture.handle.binding!.providerSessionId
    const receipt = fixture.handle.prompt('Plan')
    await receipt.delivery
    await fixture.control({
      op: 'frame',
      sessionId,
      type: 'tool.call.started',
      payload: {
        turnId: 0,
        toolCallId: 'plan-tool',
        name: 'ExitPlanMode',
        input: {},
      },
    })
    await fixture.control({
      op: 'frame',
      sessionId,
      type: 'event.approval.requested',
      payload: {
        approval_id: 'plan',
        session_id: sessionId,
        turn_id: 0,
        tool_call_id: 'plan-tool',
        action: 'Review plan',
        tool_input_display: {
          kind: 'plan_review',
          plan: 'Plan prose',
          options: [{ label: 'Approve and run', description: 'Run the plan' }],
        },
      },
    })
    await observe(fixture, () =>
      fixture.events.some((event) => event.type === 'permission_requested'),
    )
    expect(
      fixture.events.some(
        (event) =>
          event.type === 'content_snapshot' &&
          event.contentType === 'plan' &&
          event.text === 'Plan prose',
      ),
    ).toBe(true)
    const request = fixture.events.find(
      (event) => event.type === 'permission_requested',
    )!
    expect(request.request.options!.map((option) => option.label)).toEqual([
      'Approve and run',
      'Revise',
      'Reject and Exit',
      'Dismiss plan',
    ])
    await fixture.handle.replyPermission!({
      requestId: request.request.requestId,
      type: 'selected',
      optionId: request.request.options![0].id,
    })
    const inspection = await fixture.control({ op: 'inspect' })
    expect(
      (
        inspection.requests as { method: string; path: string; body: unknown }[]
      ).find(
        (row) => row.method === 'POST' && row.path.includes('/approvals/'),
      )!.body,
    ).toEqual({ decision: 'approved', selected_label: 'Approve and run' })
    await finish(fixture)
    await receipt.completion
    await fixture.handle.kill()
  }, 30000)
  test.each([
    [
      { type: 'selected', optionIds: ['x'] },
      false,
      false,
      { kind: 'single', option_id: 'x' },
    ],
    [
      { type: 'selected', optionIds: ['x', 'y'] },
      true,
      false,
      { kind: 'multi', option_ids: ['x', 'y'] },
    ],
    [
      { type: 'free_text', text: 'Text' },
      false,
      true,
      { kind: 'other', text: 'Text' },
    ],
    [
      { type: 'selected_with_text', optionIds: ['x'], text: 'Text' },
      true,
      true,
      { kind: 'multi_with_other', option_ids: ['x'], other_text: 'Text' },
    ],
    [{ type: 'skipped' }, false, false, { kind: 'skipped' }],
  ])(
    'translates an explicit typed answer %j',
    async (answer, multi, other, expected) => {
      const fixture = await setup(),
        sessionId = fixture.handle.binding!.providerSessionId
      const receipt = fixture.handle.prompt('Question')
      await receipt.delivery
      await fixture.control({
        op: 'frame',
        sessionId,
        type: 'event.question.requested',
        payload: {
          question_id: 'native:question',
          session_id: sessionId,
          turn_id: 0,
          questions: [
            {
              id: 'bare:id',
              question: 'Choose',
              options: [
                { id: 'x', label: 'Same' },
                { id: 'y', label: 'Same' },
              ],
              multi_select: multi,
              allow_other: other,
            },
          ],
        },
      })
      await observe(fixture, () =>
        fixture.events.some((event) => event.type === 'question_requested'),
      )
      const event = fixture.events.find(
        (event) => event.type === 'question_requested',
      )!
      await fixture.handle.replyQuestion!(event.request.requestId, {
        'bare:id': questionAnswerSchema.parse(answer),
      })
      const inspection = await fixture.control({ op: 'inspect' })
      const writes = (
        inspection.requests as { method: string; path: string; body: unknown }[]
      ).filter(
        (request) =>
          request.method === 'POST' && request.path.includes('/questions/'),
      )
      expect(writes).toHaveLength(1)
      expect(writes[0].body).toMatchObject({ answers: { 'bare:id': expected } })
      expect(
        fixture.storage.rows.some((row) =>
          row.records.some((entry) => entry.kind === 'request.submitted'),
        ),
      ).toBe(true)
      await finish(fixture)
      await receipt.completion
      await fixture.handle.kill()
    },
    30000,
  )
  test('lost reply acknowledgement records unknown submission and sends one mutation', async () => {
    const fixture = await setup(),
      sessionId = fixture.handle.binding!.providerSessionId
    const receipt = fixture.handle.prompt('Lost answer')
    await receipt.delivery
    await fixture.control({
      op: 'frame',
      sessionId,
      type: 'event.question.requested',
      payload: {
        question_id: 'lost',
        session_id: sessionId,
        turn_id: 0,
        questions: [
          {
            id: 'q',
            question: 'Choose',
            options: [{ id: 'x', label: 'X' }],
            multi_select: false,
            allow_other: false,
          },
        ],
      },
    })
    await observe(fixture, () =>
      fixture.events.some((event) => event.type === 'question_requested'),
    )
    const request = fixture.events.find(
      (event) => event.type === 'question_requested',
    )!
    await fixture.control({ op: 'scenario', value: { loseReply: true } })
    await expect(
      fixture.handle.replyQuestion!(request.request.requestId, {
        q: { type: 'selected', optionIds: ['x'] },
      }),
    ).rejects.toBeDefined()
    expect((await receipt.completion).status).toBe('failed')
    const inspection = await fixture.control({ op: 'inspect' })
    expect(
      (inspection.requests as { method: string; path: string }[]).filter(
        (row) => row.method === 'POST' && row.path.includes('/questions/'),
      ),
    ).toHaveLength(1)
    expect(
      fixture.storage.rows.some((row) =>
        row.records.some((entry) => entry.kind === 'request.unknown'),
      ),
    ).toBe(true)
    await fixture.host.close()
  }, 30000)
  test('explicit dismissal accepts only the native successful 40909 result', async () => {
    const fixture = await setup(),
      sessionId = fixture.handle.binding!.providerSessionId
    const receipt = fixture.handle.prompt('Dismiss')
    await receipt.delivery
    await fixture.control({
      op: 'frame',
      sessionId,
      type: 'event.question.requested',
      payload: {
        question_id: 'dismiss:one',
        session_id: sessionId,
        turn_id: 0,
        questions: [
          {
            id: 'q',
            question: 'Choose',
            options: [{ id: 'x', label: 'X' }],
            multi_select: false,
            allow_other: false,
          },
        ],
      },
    })
    await observe(fixture, () =>
      fixture.events.some((event) => event.type === 'question_requested'),
    )
    const request = fixture.events.find(
      (event) => event.type === 'question_requested',
    )!
    await fixture.handle.dismissQuestion(request.request.requestId)
    expect(
      fixture.storage.rows.some((row) =>
        row.records.some((entry) => entry.kind === 'request.submitted'),
      ),
    ).toBe(true)
    await finish(fixture)
    await receipt.completion
    await fixture.handle.kill()
  }, 30000)
  test('requires explicit complete answers and durable submitted state', async () => {
    const fixture = await setup(),
      receipt = fixture.handle.prompt('Ask')
    const delivery = await receipt.delivery
    if (delivery.status !== 'delivered')
      throw new Error('Fixture delivery failed')
    const sid = fixture.handle.binding!.providerSessionId
    await fixture.control({
      op: 'frame',
      sessionId: sid,
      type: 'event.question.requested',
      payload: {
        question_id: 'question:one',
        session_id: sid,
        turn_id: Number(delivery.providerTurnId),
        questions: [
          {
            id: 'item:one',
            question: 'Choose',
            options: [
              { id: 'x', label: 'Same' },
              { id: 'y', label: 'Same' },
            ],
            multi_select: true,
            allow_other: true,
          },
        ],
        created_at: 0,
      },
    })
    let request:
      Extract<HarnessEvent, { type: 'question_requested' }> | undefined
    for (let index = 0; index < 50 && !request; index++) {
      await fixture.control({ op: 'inspect' })
      await new Promise((resolve) => setImmediate(resolve))
      request = fixture.events.find(
        (
          event,
        ): event is Extract<HarnessEvent, { type: 'question_requested' }> =>
          event.type === 'question_requested',
      )
    }
    expect(request).toBeDefined()
    await expect(
      fixture.handle.replyQuestion!(request!.request.requestId, {}),
    ).rejects.toBeDefined()
    await fixture.handle.replyQuestion!(request!.request.requestId, {
      'item:one': {
        type: 'selected_with_text',
        optionIds: ['x'],
        text: 'Other',
      },
    })
    expect(
      fixture.storage.rows.some((row) =>
        row.records.some((record) => record.kind === 'request.submitted'),
      ),
    ).toBe(true)
    await finish(fixture)
    await receipt.completion
    await fixture.handle.kill()
  }, 30000)
})
describe('9. Attachments and options', () => {
  test('absent, null, and explicit model settings leave global config unchanged', async () => {
    const fixture = await setup()
    const settings: (DispatchOptions | undefined)[] = [
      undefined,
      { permissionMode: 'manual', model: null, reasoning: null },
      { permissionMode: 'manual', model: 'fixture-model', reasoning: 'low' },
    ]
    for (const options of settings) {
      const receipt = fixture.handle.prompt('Settings', options)
      await receipt.delivery
      await finish(fixture)
      expect((await receipt.completion).status).toBe('completed')
    }
    expect(() =>
      fixture.handle.prompt('Invalid effort', {
        permissionMode: 'manual',
        reasoning: 'unsupported',
      }),
    ).toThrow()
    const inspection = await fixture.control({ op: 'inspect' })
    const writes = (
      inspection.requests as {
        method: string
        path: string
        body: Record<string, unknown>
      }[]
    ).filter((row) => row.method === 'POST' && row.path.endsWith('/prompts'))
    expect(writes).toHaveLength(3)
    expect(writes[0].body).not.toHaveProperty('model')
    expect(writes[0].body).not.toHaveProperty('thinking')
    expect(writes[1].body).toMatchObject({
      model: 'fixture-model',
      thinking: 'low',
    })
    expect(writes[2].body).toMatchObject({
      model: 'fixture-model',
      thinking: 'low',
    })
    expect(
      (inspection.requests as { method: string; path: string }[]).some(
        (row) => row.method !== 'GET' && row.path === '/api/v1/config',
      ),
    ).toBe(false)
    await fixture.handle.kill()
  }, 30000)
  test('a later loader failure removes the first upload and sends no prompt', async () => {
    let calls = 0
    const fixture = await setup(
      {},
      {
        loadAttachment: async () => {
          if (++calls === 2) throw new Error('Fixture loader rejected')
          return {
            mime: 'image/png',
            name: 'fixture.png',
            path: '/inert',
            sizeBytes: 3,
            readBytes: async () => Buffer.from([1, 2, 3]),
          }
        },
      },
    )
    const receipt = fixture.handle.prompt([
      { type: 'attachment', attachmentId: 'first', mime: 'image/png' },
      { type: 'attachment', attachmentId: 'second', mime: 'image/png' },
    ])
    expect((await receipt.completion).status).toBe('failed')
    const inspection = await fixture.control({ op: 'inspect' })
    expect(inspection.uploads).toEqual([])
    const requests = inspection.requests as { method: string; path: string }[]
    expect(
      requests.filter(
        (row) => row.method === 'POST' && row.path === '/api/v1/files',
      ),
    ).toHaveLength(1)
    expect(
      requests.filter(
        (row) =>
          row.method === 'DELETE' && row.path.startsWith('/api/v1/files/'),
      ),
    ).toHaveLength(1)
    expect(
      requests.some(
        (row) => row.method === 'POST' && row.path.endsWith('/prompts'),
      ),
    ).toBe(false)
    await fixture.handle.kill()
  }, 30000)
  test('message paging returns a real cursor that resumes the same native snapshot', async () => {
    const fixture = await setup({ pageMessages: 1, messagePages: 1 }),
      sessionId = fixture.handle.binding!.providerSessionId
    for (const id of ['first', 'second'])
      await fixture.control({
        op: 'message',
        sessionId,
        id,
        role: 'system',
        content: [{ type: 'text', text: id }],
      })
    const options = {
      authority: fixture.selected,
      host: fixture.host,
      binding: fixture.handle.binding!,
      importScope: { sessionId: 'forge-a', importId: 'cursor' },
      readState: fixture.storage.read,
      commitRecords: fixture.storage.sink,
      storeAttachment: fixture.storage.attachment,
      signal: new AbortController().signal,
    }
    const first = await readKimiHistory(options)
    expect(first.complete).toBe(false)
    expect(first.nextMessage).toMatchObject({
      source: 'messages',
      beforeId: 'second',
      nativeSessionId: sessionId,
      agentId: 'main',
    })
    const second = await readKimiHistory({
      ...options,
      messageCursor: JSON.parse(JSON.stringify(first.nextMessage)),
    })
    expect(second.complete).toBe(true)
    expect(second.nextMessage).toBeUndefined()
    expect(
      fixture.storage.rows
        .flatMap((row) => row.records)
        .filter((row) => row.kind === 'message')
        .map((row) => (row.payload as { id: string }).id),
    ).toEqual(['second', 'first'])
    await fixture.handle.kill()
  }, 30000)
  test('uploads exact bytes, names and MIME types in the original content order', async () => {
    const fixture = await setup(
      {},
      {
        loadAttachment: async (sessionId, attachmentId) => {
          expect(sessionId).toBe('forge-a')
          const bytes = Buffer.from([0, 255, 13, 10, 128])
          return {
            name: 'fixture.png',
            mime: 'image/png',
            sizeBytes: bytes.length,
            path: `/inert/${attachmentId}`,
            readBytes: async () => bytes,
          }
        },
      },
    )
    const receipt = fixture.handle.prompt([
      { type: 'text', text: 'Before' },
      { type: 'attachment', attachmentId: 'owned-image', mime: 'image/png' },
      { type: 'text', text: 'After' },
    ])
    await receipt.delivery
    const inspection = await fixture.control({ op: 'inspect' })
    expect(inspection.uploads).toEqual([
      {
        id: expect.any(String),
        name: 'fixture.png',
        mime: 'image/png',
        data: Buffer.from([0, 255, 13, 10, 128]).toString('base64'),
      },
    ])
    const prompt = (
      inspection.requests as { method: string; path: string; body: unknown }[]
    ).find(
      (request) =>
        request.method === 'POST' && request.path.endsWith('/prompts'),
    )!
    expect(prompt.body).toMatchObject({
      content: [
        { type: 'text', text: 'Before' },
        {
          type: 'image',
          source: {
            kind: 'file',
            file_id: (inspection.uploads as { id: string }[])[0].id,
          },
        },
        { type: 'text', text: 'After' },
      ],
    })
    await finish(fixture)
    expect((await receipt.completion).status).toBe('completed')
    await fixture.handle.kill()
  }, 30000)
  test('cancellation after upload removes only that upload and keeps the physical hook slot', async () => {
    const entered = controlled<void>(),
      resume = controlled<void>()
    const fixture = await setup(
      {},
      {
        loadAttachment: async () => ({
          name: 'fixture.png',
          mime: 'image/png',
          sizeBytes: 3,
          path: '/inert',
          readBytes: async () => Buffer.from([1, 2, 3]),
        }),
        beforeDispatch: async () => {
          entered.resolve()
          await resume.promise
        },
      },
    )
    const receipt = fixture.handle.prompt([
      { type: 'attachment', attachmentId: 'image', mime: 'image/png' },
    ])
    await entered.promise
    await fixture.handle.cancel()
    expect((await receipt.completion).status).toBe('failed')
    expect((fixture.host as KimiHostOwner).budget.count('sinkCalls')).toBe(1)
    const inspection = await fixture.control({ op: 'inspect' })
    expect(inspection.uploads).toEqual([])
    expect(
      (inspection.requests as { method: string; path: string }[]).some(
        (row) => row.method === 'POST' && row.path.endsWith('/prompts'),
      ),
    ).toBe(false)
    resume.resolve()
    await resume.promise
    await fixture.handle.kill()
  }, 30000)
  test('native queue limits reject before an extra prompt POST', async () => {
    const fixture = await setup({ nativeQueuedPrompts: 1 })
    const root = fixture.handle.prompt('Root')
    await root.delivery
    const queued = fixture.handle.queue('First queued')
    await queued.nativeAcceptance
    expect(() => fixture.handle.queue('Excess queued')).toThrow()
    const inspection = await fixture.control({ op: 'inspect' })
    expect(
      (inspection.requests as { method: string; path: string }[]).filter(
        (row) => row.method === 'POST' && row.path.endsWith('/prompts'),
      ),
    ).toHaveLength(2)
    await fixture.handle.abortPrompt(queued.receiptId)
    await queued.completion
    await fixture.handle.cancel()
    await root.completion
    await fixture.handle.kill()
  }, 30000)
  test('imports exact inline bytes with immutable native image references', async () => {
    const fixture = await setup()
    await fixture.control({
      op: 'message',
      sessionId: fixture.handle.binding!.providerSessionId,
      id: 'native-image',
      role: 'assistant',
      content: [
        {
          type: 'image',
          source: { kind: 'base64', media_type: 'image/png', data: 'AQID' },
        },
      ],
    })
    const result = await readKimiHistory({
      authority: fixture.selected,
      host: fixture.host,
      binding: fixture.handle.binding!,
      importScope: { sessionId: 'forge-a', importId: 'image-import' },
      readState: fixture.storage.read,
      commitRecords: fixture.storage.sink,
      storeAttachment: fixture.storage.attachment,
      signal: new AbortController().signal,
    })
    expect(result.coverage.media).toBe('complete')
    expect([...fixture.storage.images.values()]).toEqual([
      Buffer.from([1, 2, 3]),
    ])
    await fixture.handle.kill()
  }, 30000)
})
describe('10. Storage and hard limits', () => {
  test('a fast sink cannot reset publication limits or consume the terminal reserve', async () => {
    const fixture = await setup({ publishedEvents: 3 }),
      sessionId = fixture.handle.binding!.providerSessionId
    const receipt = fixture.handle.prompt('Publication ceiling')
    expect((await receipt.delivery).status).toBe('delivered')
    await fixture.control({
      op: 'frame',
      sessionId,
      type: 'assistant.delta',
      payload: { turnId: 0, delta: 'Must not publish' },
    })
    const error = await receipt.completion.catch((value: unknown) => value)
    expect(isCompletionPersistenceFailure(error)).toBe(true)
    expect(error).toMatchObject({
      persistence: {
        code: 'completion_not_committed',
        failure: { phase: 'constructed' },
        required: {
          state: 'not_committed',
          terminal: { phase: 'acknowledged' },
        },
      },
    })
    expect(
      fixture.events.some((event) => event.type === 'content_snapshot'),
    ).toBe(false)
    expect(
      fixture.events.filter(
        (event) => event.type === 'diagnostic' && event.severity === 'error',
      ),
    ).toHaveLength(1)
    expect(
      fixture.storage.events.filter((event) => event.type === 'turn_completed'),
    ).toHaveLength(1)
    await fixture.host.close()
    expect((fixture.host as KimiHostOwner).budget.count('hostProcesses')).toBe(
      0,
    )
    expect((fixture.host as KimiHostOwner).budget.count('hostSockets')).toBe(0)
    expect((fixture.host as KimiHostOwner).budget.count('hostHttp')).toBe(0)
  }, 30000)
  test('committed outbox replay survives publication failure with distinct delivery identities', async () => {
    const storage = store(),
      host = new KimiHostOwner(),
      controller = new AbortController()
    const records = new KimiRecords(
      {
        sessionId: 'outbox',
        binding: {
          provider: 'kimi',
          accountId: 'account',
          cwd: '/fixture',
          providerSessionId: 'native',
        },
        runtimeGeneration: 'generation',
      },
      new KimiBudget(kimiLimits()),
      host,
      storage.sink,
      () => {
        throw new Error('Publisher stopped after commit')
      },
      controller.signal,
    )
    await records.restore(storage.read)
    const events: HarnessEvent[] = [
      {
        runId: 'run',
        runtimeGeneration: 'generation',
        deliveryId: '',
        type: 'run_started',
      },
      {
        runId: 'run',
        turnId: 'turn',
        runtimeGeneration: 'generation',
        deliveryId: '',
        type: 'turn_started',
      },
      {
        runId: 'run',
        turnId: 'turn',
        runtimeGeneration: 'generation',
        deliveryId: '',
        itemId: 'text',
        type: 'content_snapshot',
        contentType: 'text',
        text: 'Committed',
      },
    ]
    await expect(records.commit('batch', [], events)).rejects.toThrow(
      'Publisher stopped',
    )
    expect(await records.commit('batch', [], events)).toBe(1)
    expect(storage.rows).toHaveLength(1)
    const replayed = foldTimeline(
      storage.events.map((event, index) => ({
        kind: 'delta',
        cursor: index + 1,
        event,
      })),
    )
    expect(replayed.events).toHaveLength(3)
    expect(replayed.deliveryIds.size).toBe(3)
    await expect(records.commit('batch', [], [])).rejects.toMatchObject({
      code: 'kimi_batch_conflict',
    })
    await host.close()
  })
  test('two queued socket commits merge only their own cursor domains', async () => {
    const storage = store(),
      host = new KimiHostOwner(),
      records = new KimiRecords(
        {
          sessionId: 'cursors',
          binding: {
            provider: 'kimi',
            accountId: 'account',
            cwd: '/fixture',
            providerSessionId: 'native',
          },
          runtimeGeneration: 'generation',
        },
        new KimiBudget(kimiLimits()),
        host,
        storage.sink,
        () => {},
        new AbortController().signal,
      )
    await records.restore(storage.read)
    const release = storage.hold()
    const life = records.commit('life', [], [], {
      session: { epoch: 'epoch', seq: 0 },
      transcripts: {},
    })
    const transcript = records.commit('tx', [], [], {
      transcripts: { main: 1 },
    })
    release()
    expect(await life).toBe(1)
    expect(await transcript).toBe(2)
    expect(records.checkpoint).toEqual({
      session: { epoch: 'epoch', seq: 0 },
      transcripts: { main: 1 },
    })
    expect(await records.commit('local-reply', [])).toBe(3)
    expect(records.checkpoint).toEqual({
      session: { epoch: 'epoch', seq: 0 },
      transcripts: { main: 1 },
    })
    await host.close()
  })
  test('a cancelled loader keeps its host slot through native restart until the callback settles', async () => {
    const entered = controlled<void>(),
      resume = controlled<void>()
    let calls = 0,
      reads = 0
    const fixture = await setup(
      { hostAttachmentLoads: 1 },
      {
        loadAttachment: async () => {
          calls++
          entered.resolve()
          await resume.promise
          return {
            mime: 'image/png',
            name: 'fixture.png',
            path: '/inert',
            sizeBytes: 3,
            readBytes: async () => {
              reads++
              return Buffer.from([1, 2, 3])
            },
          }
        },
      },
    )
    const first = fixture.handle.prompt([
      { type: 'attachment', attachmentId: 'one', mime: 'image/png' },
    ])
    await entered.promise
    await fixture.handle.cancel()
    expect((await first.completion).status).toBe('failed')
    await fixture.handle.kill()
    expect((fixture.host as KimiHostOwner).budget.count('hostProcesses')).toBe(
      0,
    )
    expect(
      (fixture.host as KimiHostOwner).budget.count('hostAttachmentLoads'),
    ).toBe(1)
    const replacement = await retryFixtureAdmission(() =>
      fixture.adapter.spawn(
        {
          id: 'replacement',
          cwd: fixture.cwd,
          provider: fixture.selected.provider,
          accountId: fixture.selected.account.id,
        },
        () => {},
      ),
    )
    const second = replacement.prompt([
      { type: 'attachment', attachmentId: 'two', mime: 'image/png' },
    ])
    expect((await second.completion).status).toBe('failed')
    expect(calls).toBe(1)
    await replacement.kill()
    let ended = false
    const closing = fixture.host.close().then(() => {
      ended = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(ended).toBe(false)
    resume.resolve()
    await closing
    expect(reads).toBe(0)
    expect(
      (fixture.host as KimiHostOwner).budget.count('hostAttachmentLoads'),
    ).toBe(0)
  }, 30000)
  test('serializes concurrent local batches and retains physical callback charges after cancellation', async () => {
    const storage = store(),
      host = new KimiHostOwner(),
      controller = new AbortController(),
      budget = new KimiBudget(kimiLimits())
    const records = new KimiRecords(
      {
        sessionId: 'fixture',
        binding: {
          provider: 'kimi',
          accountId: 'account',
          cwd: '/fixture',
          providerSessionId: 'native',
        },
        runtimeGeneration: 'generation',
      },
      budget,
      host,
      storage.sink,
      () => {},
      controller.signal,
    )
    await records.restore(storage.read)
    const release = storage.hold(),
      first = records.commit('first', []),
      second = records.commit('second', [])
    release()
    expect(await first).toBe(1)
    expect(await second).toBe(2)
    const pending = controlled<void>(),
      abort = new AbortController()
    const result = boundedCallback(
      budget,
      'sinkCalls',
      1000,
      abort.signal,
      () => pending.promise,
    )
    abort.abort()
    await expect(result).rejects.toBeDefined()
    expect(budget.count('sinkCalls')).toBe(1)
    pending.resolve()
    await pending.promise
    await new Promise((resolve) => setImmediate(resolve))
    expect(budget.count('sinkCalls')).toBe(0)
    await host.close()
  })
})
