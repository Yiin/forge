import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
  lstat,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { it, expect, vi } from 'vitest'
import { NativeProcess } from '../process.js'
import { CursorWire } from './wire.js'
import { cursorLimits, serviceGrant } from './limits.js'
import { writeMarker } from './store.js'
import { reservationDirectory } from './store.js'
import { recoverCursorReservation } from './index.js'
import { createCursorResources } from './limits.js'
import type {
  CursorSelectedRecords,
  CursorReservation,
  CursorDurableSink,
} from './contracts.js'
import { nativeBootstrapOverrides } from './launch.js'
import {
  processIdentity,
  retireContainer,
  type ContainerIdentity,
} from './container.js'

it('retires the packaged service and detached writer after main SIGKILL', async () => {
  const directory = await mkdtemp('/tmp/forge-cursor-container-')
  const limits = cursorLimits(),
    generation = randomUUID(),
    nonce = randomUUID()
  const fence = join(directory, 'fence.json')
  let identity: ContainerIdentity = {
    unit: `forge-cursor-${randomUUID()}.service`,
    nonce,
    generation,
    leaseId: randomUUID(),
    grant: serviceGrant(limits),
    boot: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
    host: (await readFile('/etc/machine-id', 'utf8')).trim(),
  }
  let wire!: CursorWire, process: NativeProcess | undefined
  const evidence: Record<string, unknown> = {
    unit: identity.unit,
    generation,
    nonce,
  }
  evidence.guardianSha256 = createHash('sha256')
    .update(
      await readFile(resolve('apps/server/src/cursor-sidecar/guardian.mjs')),
    )
    .digest('hex')
  evidence.manifestSha256 = createHash('sha256')
    .update(
      await readFile(resolve('apps/server/src/cursor-sidecar/manifest.json')),
    )
    .digest('hex')
  try {
    await writeMarker(fence, { state: 'dirty', identity }, limits, true)
    const launched = await NativeProcess.start(
      {
        command: globalThis.process.execPath,
        args: [
          resolve('apps/server/src/cursor-sidecar/guardian.mjs'),
          generation,
        ],
        cwd: directory,
        env: nativeBootstrapOverrides(globalThis.process.env),
        startupTimeoutMs: 15000,
        cleanupTimeoutMs: 5000,
      },
      async (child) => {
        process = child
        wire = new CursorWire(
          child.child.stdin,
          child.child.stdout,
          generation,
          limits,
          () => {},
        )
        child.ownTransport(wire.transport)
        return wire.request('initialize', {
          identity,
          node: globalThis.process.execPath,
          args: ['--max-old-space-size=512'],
          entry: resolve('apps/server/src/cursor-sidecar/sidecar.mjs'),
          cwd: directory,
          fence,
          removed: [],
          probeData: directory,
        })
      },
    )
    identity = launched.value.identity as ContainerIdentity
    evidence.identity = identity
    const ready = await wire.request('container_bound', { identity, nonce })
    const writer = await processIdentity(Number(ready.writerPid))
    const main = await processIdentity(Number(ready.pid))
    const guardian = await processIdentity(process!.child.pid!)
    expect(writer.cgroup).toBe(main.cgroup)
    expect(guardian.cgroup).not.toBe(main.cgroup)
    evidence.writer = writer
    evidence.main = main
    evidence.guardian = guardian
    evidence.directory = directory
    await vi.waitFor(async () =>
      expect((await stat(join(directory, 'heartbeat'))).size).toBeGreaterThan(
        0,
      ),
    )
    globalThis.process.kill(main.pid, 'SIGKILL')
    await vi.waitFor(
      async () => {
        await expect(processIdentity(writer.pid)).rejects.toThrow()
      },
      { timeout: 6000 },
    )
    evidence.retireDeadlineMs = 10000
    const retireStarted = performance.now()
    evidence.retireStartedAt = new Date().toISOString()
    const retired = await wire.request('retire', {}, 10000).catch((error) => {
      evidence.retireFailure = {
        code: error.code ?? error.message,
        elapsedMs: performance.now() - retireStarted,
      }
      throw error
    })
    evidence.retireElapsedMs = performance.now() - retireStarted
    expect(retired.type).toBe('retired')
    expect(retired.pipesClosed).toBe(true)
    await process!.close()
    evidence.retired = retired
    evidence.closed = true
    expect(
      JSON.parse(await readFile(`${fence}.retired`, 'utf8')).identity
        .invocation,
    ).toBe(identity.invocation)
  } finally {
    if (identity.invocation) {
      const started = performance.now()
      await retireContainer(identity, limits).then(
        (proof) => {
          evidence.finalizerRetirement = {
            proof,
            elapsedMs: performance.now() - started,
          }
        },
        (error) => {
          evidence.cleanupError = error.message
        },
      )
    }
    await process?.close().catch((error) => {
      evidence.directCleanupError = error.message
    })
    evidence.finalizerDirectCloseResolved = !evidence.directCleanupError
    await writeFile(
      join(
        '/var/tmp',
        `forge-comet-cursor-review-correction-guardian-${generation}.json`,
      ),
      JSON.stringify(evidence, null, 2) + '\n',
      { flag: 'wx' },
    )
    if (!evidence.cleanupError && !evidence.directCleanupError)
      await rm(directory, { recursive: true, force: true })
  }
}, 30000)

it('keeps a dirty fence after supervisor loss and explicitly retires the recorded service', async () => {
  const directory = await mkdtemp('/tmp/forge-cursor-container-'),
    limits = cursorLimits(),
    stateRoot = join(directory, 'state'),
    home = join(directory, 'accounts', 'test'),
    storeId = randomUUID(),
    generation = randomUUID()
  await mkdir(stateRoot, { mode: 0o700 })
  await mkdir(home, { recursive: true, mode: 0o700 })
  const owner = {
    forgeSessionId: 'recovery-test',
    provider: 'cursor-recovery',
    accountId: 'test',
    cwd: directory,
    storeId,
    generation,
    attemptId: randomUUID(),
    runId: randomUUID(),
    turnId: randomUUID(),
  }
  const reservation: CursorReservation = {
    version: 1,
    reservationId: randomUUID(),
    creationOwner: owner,
    sdkVersion: '1.0.28',
    storeRelativePath: `sessions/${storeId}/sdk`,
    state: 'creation-started',
  }
  const sdk = await reservationDirectory(stateRoot, reservation, limits, true),
    fence = join(sdk, '../writer-fence.json')
  const executable = join(directory, 'supervisor.mjs'),
    artifact = resolve('apps/server/src/cursor-sidecar'),
    evidence: Record<string, unknown> = { generation }
  await promisify(execFile)(
    'bun',
    [
      'build',
      '--target=node',
      '--external',
      '@cursor/sdk',
      resolve('apps/server/test/fixtures/cursor-guardian-supervisor.ts'),
      '--outfile',
      executable,
    ],
    { timeout: 30000, maxBuffer: 4096 },
  )
  await writeMarker(
    join(directory, 'supervisor-launch.json'),
    { owner, fence },
    limits,
    true,
  )
  const selected: CursorSelectedRecords = {
    provider: owner.provider,
    selectionEpoch: 'fixture',
    harness: {
      name: 'Cursor',
      command: globalThis.process.execPath,
      args: [],
      env: {},
      protocol: 'acp',
      adapterKind: 'native',
      enabled: true,
    },
    account: {
      id: 'test',
      harnessKey: owner.provider,
      kind: 'cursor',
      adapterKind: 'native',
      homePath: home,
      disabledAt: null,
      label: 'Test',
      orderIndex: 0,
      createdAt: 0,
      lastUsedAt: null,
      identity: null,
      config: null,
    },
    credential: { type: 'api-key', apiKey: 'synthetic-key' },
    accountEnv: {},
    settingSources: [],
  }
  const sink: CursorDurableSink = {
      readSession: async () => reservation,
      reserve: async () => {
        throw new Error('Recovery cannot reserve')
      },
      confirm: async () => {
        throw new Error('Recovery cannot confirm')
      },
      markDirty: async () => {
        throw new Error('Recovery cannot change ownership')
      },
      appendNative: async () => {
        throw new Error('Recovery cannot append')
      },
      seal: async () => {
        throw new Error('Recovery cannot seal')
      },
      flush: async () => {
        throw new Error('Recovery cannot flush')
      },
    },
    resources = createCursorResources()
  let supervisor: NativeProcess | undefined,
    identity: ContainerIdentity | undefined
  vi.stubEnv('FORGE_ACCOUNTS_DIR', join(directory, 'accounts'))
  try {
    const started = await NativeProcess.start(
      {
        command: globalThis.process.execPath,
        args: [executable, directory, artifact],
        cwd: directory,
      },
      async (child) => {
        supervisor = child
        await vi.waitFor(
          async () =>
            expect(
              await lstat(join(directory, 'supervisor-ready.json')).then(
                () => true,
                () => false,
              ),
            ).toBe(true),
          { timeout: 10000 },
        )
        return JSON.parse(
          await readFile(join(directory, 'supervisor-ready.json'), 'utf8'),
        )
      },
    )
    identity = started.value.identity
    evidence.identity = identity
    evidence.writer = started.value.writer
    supervisor!.child.kill('SIGKILL')
    await supervisor!.close()
    expect(await lstat(fence).then(() => true)).toBe(true)
    await expect(
      recoverCursorReservation(
        {
          selected,
          stateRoot,
          resources,
          sink,
          loadAttachment: async () => {
            throw new Error('no attachment')
          },
        },
        owner.forgeSessionId,
      ),
    ).rejects.toThrow('owner_live')
    const guardian = await processIdentity(identity!.guardian!.pid)
    expect(guardian.start).toBe(identity!.guardian!.start)
    globalThis.process.kill(guardian.pid, 'SIGKILL')
    await vi.waitFor(async () =>
      expect(
        await processIdentity(guardian.pid).then(
          () => false,
          () => true,
        ),
      ).toBe(true),
    )
    const recovered = await recoverCursorReservation(
      {
        selected,
        stateRoot,
        resources,
        sink,
        loadAttachment: async () => {
          throw new Error('no attachment')
        },
      },
      owner.forgeSessionId,
    )
    evidence.recovered = recovered
    expect(recovered.retired).toBe(true)
    expect(
      await lstat(fence).then(
        () => false,
        () => true,
      ),
    ).toBe(true)
    expect(resources.snapshot().containers).toBe(0)
  } finally {
    vi.unstubAllEnvs()
    if (identity?.invocation)
      await retireContainer(identity, limits).catch((error) => {
        evidence.cleanupError = error.message
      })
    await supervisor?.close().catch((error) => {
      evidence.directCleanupError = error.message
    })
    await writeFile(
      `/var/tmp/forge-comet-cursor-review-correction-recovery-${generation}.json`,
      JSON.stringify(evidence, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 },
    )
    if (!evidence.cleanupError && !evidence.directCleanupError)
      await rm(directory, { recursive: true, force: true })
  }
}, 30000)
