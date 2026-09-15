import {
  mkdtemp,
  mkdir,
  rm,
  readFile,
  writeFile,
  lstat,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import type { HarnessEvent, HarnessSession } from '../types.js'
import type {
  CursorDurableSink,
  CursorNativeEnvelope,
  CursorReservation,
  CursorSelectedRecords,
} from './contracts.js'
import { deferred } from '../transport-test-helpers.js'
import { NativeProcess, type NativeProcessOptions } from '../process.js'
import { processIdentity } from './container.js'

const fixture = vi.hoisted(() => ({
  peer: '',
  current: undefined as any,
  pause: false,
  paused: false,
  frames: 0,
  starts: [] as any[],
  ends: [] as any[],
  instances: [] as any[],
}))
vi.mock('./container.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./container.js')>()
  return {
    ...original,
    CursorContainer: class extends original.CursorContainer {
      constructor(
        launch: any,
        owner: any,
        directory: string,
        resources: any,
        limits: any,
        onFrame: any,
        reservation: any,
        discovery: any,
        onFailure: any,
      ) {
        let pauseOutput = () => {}
        super(
          { ...launch, entry: fixture.peer },
          owner,
          directory,
          resources,
          limits,
          (frame) => {
            fixture.frames++
            if (
              fixture.pause &&
              frame.type === 'event' &&
              (frame.event as HarnessEvent).type === 'run_started'
            ) {
              fixture.pause = false
              fixture.paused = true
              pauseOutput()
            }
            onFrame(frame)
          },
          reservation,
          discovery,
          onFailure,
        )
        pauseOutput = () => {
          this.process!.child.stdout.pause()
        }
        fixture.current = this
        fixture.instances.push(this)
      }
      override async start() {
        const result = await super.start()
        const receipt = {
          identity: this.identity,
          guardian: await original.processIdentity(this.process!.child.pid!),
          sidecar:
            'source-shaped synthetic SDK through actual CursorSidecarRuntime',
        }
        fixture.starts.push(receipt)
        await writeFile(
          `/var/tmp/forge-comet-cursor-review-correction-e4-${this.owner.generation}-start.json`,
          JSON.stringify(receipt),
          { flag: 'wx' },
        )
        return result
      }
      private endReceipt: Promise<void> | undefined
      override async close() {
        await super.close()
        // Concurrent close callers retain one original write and its failure.
        return (this.endReceipt ??= Promise.resolve().then(async () => {
          const receipt = {
            generation: this.owner.generation,
            retirement: JSON.parse(
              await readFile(
                join(dirname(this.sdkDirectory), 'writer-fence.json.retired'),
                'utf8',
              ),
            ),
            pipesDestroyed: [
              this.process!.child.stdin.destroyed,
              this.process!.child.stdout.destroyed,
              this.process!.child.stderr.destroyed,
            ],
          }
          await writeFile(
            `/var/tmp/forge-comet-cursor-review-correction-e4-${this.owner.generation}-end.json`,
            JSON.stringify(receipt),
            { flag: 'wx' },
          )
          fixture.ends.push(receipt)
        }))
      }
    },
  }
})
import { createCursorAdapter, createCursorResources } from './index.js'
import { cursorLimits } from './limits.js'
let root: string, stateRoot: string, home: string, maximumCwd: string
const physical: Array<{
  process: NativeProcess
  identity: Awaited<ReturnType<typeof processIdentity>>
  prefix: string
}> = []
beforeAll(async () => {
  root = await mkdtemp('/tmp/forge-cursor-content-')
  stateRoot = join(root, 'state')
  home = join(root, 'accounts', 'synthetic')
  await mkdir(stateRoot, { mode: 0o700 })
  await mkdir(home, { recursive: true, mode: 0o700 })
  await mkdir(join(root, 'cursor-sidecar'), { mode: 0o700 })
  maximumCwd = root
  // Linux permits 4095 pathname bytes before its terminating NUL.
  while (maximumCwd.length < cursorLimits().argValueBytes - 1) {
    maximumCwd = join(
      maximumCwd,
      '"'.repeat(
        Math.min(254, cursorLimits().argValueBytes - 2 - maximumCwd.length),
      ),
    )
    await mkdir(maximumCwd, { mode: 0o700 })
  }
  fixture.peer = join(root, 'cursor-sidecar', 'sidecar.mjs')
  await promisify(execFile)(
    'bun',
    [
      'build',
      '--target=node',
      '--external',
      '@cursor/sdk',
      resolve('apps/server/test/fixtures/cursor-peer.ts'),
      '--outfile',
      fixture.peer,
    ],
    { timeout: 30000, maxBuffer: 4096 },
  )
  const prefix = `/var/tmp/forge-comet-cursor-review-correction-e4-${root.split('/').at(-1)}`
  const artifacts: Array<{
    source: string
    capture: string
    sha256: string
    bytes: number
  }> = []
  for (const [name, source] of [
    ['synthetic-sidecar.mjs', fixture.peer],
    ...[
      'guardian.mjs',
      'sidecar.mjs',
      'sidecar-runtime.mjs',
      'probe.mjs',
      'manifest.json',
    ].map((name) => [name, resolve('apps/server/src/cursor-sidecar', name)]),
  ]) {
    const bytes = await readFile(source),
      capture = `${prefix}-${name}`
    await writeFile(capture, bytes, { flag: 'wx' })
    artifacts.push({
      source,
      capture,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    })
  }
  await writeFile(`${prefix}-artifacts.json`, JSON.stringify(artifacts), {
    flag: 'wx',
  })
  const originalStart = NativeProcess.start.bind(NativeProcess)
  vi.spyOn(NativeProcess, 'start').mockImplementation(
    async <T>(
      options: NativeProcessOptions,
      initialize: (process: NativeProcess) => Promise<T>,
    ) =>
      originalStart(options, async (process) => {
        const identity = await processIdentity(process.child.pid!)
        const prefix = `/var/tmp/forge-comet-cursor-review-correction-e4-physical-${identity.pid}-${identity.start}`
        physical.push({ process, identity, prefix })
        await writeFile(`${prefix}-start.json`, JSON.stringify(identity), {
          flag: 'wx',
        })
        return initialize(process)
      }),
  )
  vi.stubEnv('FORGE_ACCOUNTS_DIR', join(root, 'accounts'))
})
afterAll(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const original of physical) {
    const current = await processIdentity(original.identity.pid).catch(
      () => undefined,
    )
    await writeFile(
      `${original.prefix}-end.json`,
      JSON.stringify({
        identity: original.identity,
        originalPresent: current?.start === original.identity.start,
        pipesDestroyed: [
          original.process.child.stdin.destroyed,
          original.process.child.stdout.destroyed,
          original.process.child.stderr.destroyed,
        ],
      }),
      { flag: 'wx' },
    )
  }
  const unresolved = fixture.instances.filter((instance) => !instance.closed)
  if (unresolved.length) {
    await writeFile(
      `/var/tmp/forge-comet-cursor-review-correction-e4-retained-${root.split('/').at(-1)}.json`,
      JSON.stringify({
        root,
        reason: 'Original container cleanup remains unproved',
        owners: unresolved.map((instance) => ({
          owner: instance.owner,
          identity: instance.identity,
          sdkDirectory: instance.sdkDirectory,
        })),
      }),
      { flag: 'wx' },
    )
    return
  }
  await rm(root, { recursive: true, force: true })
})
function selected(scenario: string): CursorSelectedRecords {
  return {
    provider: 'cursor-content',
    selectionEpoch: 'epoch',
    harness: {
      name: 'Cursor',
      command: process.execPath,
      args: [],
      env: {},
      protocol: 'acp',
      adapterKind: 'native',
      enabled: true,
    },
    account: {
      id: 'synthetic',
      harnessKey: 'cursor-content',
      kind: 'cursor',
      adapterKind: 'native',
      homePath: home,
      disabledAt: null,
      label: 'Synthetic',
      orderIndex: 0,
      createdAt: 0,
      lastUsedAt: null,
      identity: null,
      config: null,
    },
    credential: { type: 'api-key', apiKey: 'synthetic-key' },
    accountEnv: { TEST_SCENARIO: scenario },
    settingSources: [],
  }
}
it.each([
  'content-ordinary',
  'content-escaped',
  'content-escaped-final-only',
  'content-escaped-correction',
  'content-escaped-append',
  'content-escaped-overflow',
  'content-escaped-correction-maximum-owner',
])(
  'preserves maximum content through the real guardian, parent and sink: %s',
  async (scenario) => {
    const limits = cursorLimits(),
      resources = createCursorResources(),
      reservations = new Map<string, CursorReservation>()
    const events: HarnessEvent[] = [],
      records: CursorNativeEnvelope[] = [],
      positions: number[] = []
    const sink: CursorDurableSink = {
      reserve: async (value) => {
        reservations.set(value.creationOwner.forgeSessionId, value)
        return value
      },
      readSession: async (id) => reservations.get(id) ?? null,
      confirm: async (value) => {
        const previous = reservations.get(value.owner.forgeSessionId)!
        reservations.set(value.owner.forgeSessionId, {
          ...previous,
          state: 'native-confirmed',
          record: value.record,
        })
      },
      markDirty: async () => {},
      appendNative: async (record) => {
        records.push(record)
        positions.push(records.length)
        return { position: records.length }
      },
      seal: async () => ({ through: positions.at(-1) ?? 0 }),
      flush: async (value) => ({ committedThrough: value.through }),
    }
    const maximumOwner = scenario.includes('maximum-owner'),
      maximumId = '"'.repeat(limits.idBytes)
    const recordsSelected = selected(scenario)
    const captured = maximumOwner
      ? {
          ...recordsSelected,
          provider: maximumId,
          account: {
            ...recordsSelected.account,
            id: maximumId,
            harnessKey: maximumId,
          },
        }
      : recordsSelected
    const handle = await createCursorAdapter({
      selected: captured,
      stateRoot,
      resources,
      sink,
      loadAttachment: async () => {
        throw new Error('unexpected attachment')
      },
    }).spawn(
      {
        id: maximumOwner ? maximumId : scenario,
        provider: captured.provider,
        accountId: captured.account.id,
        cwd: maximumOwner ? maximumCwd : root,
      } as HarnessSession,
      (event) => events.push(event),
    )
    try {
      const receipt = await handle.prompt(
        'content boundary',
        { permissionMode: 'auto', model: 'test' },
        maximumOwner ? { runId: maximumId, turnId: maximumId } : undefined,
      )
      const outcome = await receipt.completion
      await writeFile(
        `/var/tmp/forge-comet-cursor-review-correction-e4-${fixture.current.owner.generation}-outcome.json`,
        JSON.stringify({
          scenario,
          outcome,
          eventTypes: events.map((event) => event.type),
          recordKinds: records.map((record) => record.kind),
          diagnostics: fixture.current.process?.diagnostics?.slice(-4096),
          stageManifestSha256: createHash('sha256')
            .update(
              await readFile(
                resolve('apps/server/src/cursor-sidecar/manifest.json'),
              ),
            )
            .digest('hex'),
          syntheticSidecarSha256: createHash('sha256')
            .update(await readFile(fixture.peer))
            .digest('hex'),
        }),
        { flag: 'wx' },
      )
      if (scenario.includes('overflow')) {
        expect(outcome.status).toBe('failed')
        expect(records.some((record) => record.kind === 'terminal')).toBe(false)
        expect(
          events.some(
            (event) =>
              event.type === 'content_snapshot' || event.type === 'text_delta',
          ),
        ).toBe(false)
      } else {
        expect(outcome.status).toBe('completed')
        const original = (scenario.includes('escaped') ? '\u0000' : 'x').repeat(
          limits.itemBytes,
        )
        const expected = scenario.includes('correction')
          ? `${original.slice(0, -1)}Z`
          : original
        let text = ''
        const content = events.filter(
          (event) =>
            event.type === 'text_delta' || event.type === 'content_snapshot',
        )
        for (const event of content)
          text =
            event.type === 'content_snapshot' ? event.text : text + event.text
        expect(text).toBe(expected)
        expect(new Set(content.map((event) => event.itemId)).size).toBe(1)
        const terminal = records.filter((record) => record.kind === 'terminal')
        expect(terminal).toHaveLength(1)
        expect((terminal[0].payload as any).result).toBe(expected)
        if (!scenario.includes('final-only'))
          expect(
            (
              records.find(
                (record) => (record.payload as any).source === 'onStep',
              )!.payload as any
            ).step.message.text,
          ).toBe(original)
        if (scenario.includes('append'))
          expect(
            content.filter((event) => event.type === 'text_delta'),
          ).toHaveLength(2048)
        const semanticBytes = [...events, ...records].reduce(
          (sum, value) => sum + Buffer.byteLength(JSON.stringify(value)),
          0,
        )
        expect(semanticBytes).toBeLessThan(limits.rootEventBytes)
        await writeFile(
          `/var/tmp/forge-comet-cursor-review-correction-e4-${fixture.current.owner.generation}-content.json`,
          JSON.stringify({
            scenario,
            outcome,
            itemBytes: Buffer.byteLength(expected),
            sha256: createHash('sha256').update(expected).digest('hex'),
            semanticBytes,
            events: events.length,
            records: records.length,
            outputFrameBytes: (handle as any).totalEventBytes,
            ownerBytes: Object.fromEntries(
              Object.entries(terminal[0].owner).map(([key, value]) => [
                key,
                Buffer.byteLength(value),
              ]),
            ),
            sdk: 'synthetic methods',
            transport:
              'actual sidecar runtime, systemd service, guardian, parent adapter, recording sink',
          }),
          { flag: 'wx' },
        )
      }
    } finally {
      await handle.kill()
    }
    expect(
      Object.values(resources.snapshot()).every((value) => value === 0),
    ).toBe(true)
    const last = fixture.starts.at(-1)
    await expect(lstat(`/proc/${last.guardian.pid}`)).rejects.toMatchObject({
      code: 'ENOENT',
    })
  },
  60000,
)

it('keeps blocked guardian forwarding and a held parent sink bounded until their original work settles', async () => {
  const resources = createCursorResources(),
    held = deferred<void>(),
    records: CursorNativeEnvelope[] = []
  let reservation: CursorReservation | null = null,
    entered = false,
    completed = false
  const sink: CursorDurableSink = {
    reserve: async (value) => (reservation = value),
    readSession: async () => reservation,
    confirm: async (value) => {
      reservation = {
        ...reservation!,
        state: 'native-confirmed',
        record: value.record,
      }
    },
    markDirty: async () => {},
    appendNative: async (record) => {
      entered = true
      await held.promise
      records.push(record)
      return { position: records.length }
    },
    seal: async () => ({ through: records.length }),
    flush: async (value) => ({ committedThrough: value.through }),
  }
  const handle = await createCursorAdapter({
    selected: selected('content-escaped-correction'),
    stateRoot,
    resources,
    sink,
    loadAttachment: async () => {
      throw new Error('unexpected attachment')
    },
  }).spawn(
    {
      id: 'blocked-forwarding',
      provider: 'cursor-content',
      accountId: 'synthetic',
      cwd: root,
    } as HarnessSession,
    () => {},
  )
  fixture.pause = true
  fixture.paused = false
  let bodyFailed = false,
    cleanupFailed = false
  let bodyError: unknown, cleanupError: unknown
  try {
    const receipt = await handle.prompt('blocked output', {
      permissionMode: 'auto',
      model: 'test',
    })
    void receipt.completion.then(() => {
      completed = true
    })
    await vi.waitFor(() => expect(fixture.paused).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(completed).toBe(false)
    expect(entered).toBe(false)
    fixture.current.process.child.stdout.resume()
    await vi.waitFor(() => expect(entered).toBe(true), { timeout: 10000 })
    expect(completed).toBe(false)
    expect(resources.snapshot().callbacks).toBe(1)
    expect((handle as any).nativeBytes).toBeLessThanOrEqual(
      cursorLimits().queuedWireBytes,
    )
    held.resolve()
    expect((await receipt.completion).status).toBe('completed')
    expect(
      (records.find((record) => record.kind === 'terminal')!.payload as any)
        .result.length,
    ).toBe(cursorLimits().itemBytes)
  } catch (error) {
    bodyFailed = true
    bodyError = error
    console.error('CURSOR_E4_BODY_FAILURE', error)
  } finally {
    fixture.current?.process?.child.stdout.resume()
    held.resolve()
    try {
      const original = fixture.current
      // Exercise concurrent receipt capture after the same physical close.
      const closes = await Promise.allSettled([
        handle.kill(),
        original.close(),
        original.close(),
      ])
      const failed = closes.find((result) => result.status === 'rejected')
      if (failed?.status === 'rejected') {
        cleanupFailed = true
        cleanupError = failed.reason
        console.error('CURSOR_E4_CLEANUP_FAILURE', failed.reason)
      } else {
        expect(
          fixture.ends.filter(
            (entry) => entry.generation === original.owner.generation,
          ),
        ).toHaveLength(1)
      }
    } catch (error) {
      cleanupFailed = true
      cleanupError = error
      console.error('CURSOR_E4_CLEANUP_FAILURE', error)
    } finally {
      fixture.pause = false
    }
  }
  if (bodyFailed) throw bodyError
  if (cleanupFailed) throw cleanupError
  expect(
    Object.values(resources.snapshot()).every((value) => value === 0),
  ).toBe(true)
}, 60000)
