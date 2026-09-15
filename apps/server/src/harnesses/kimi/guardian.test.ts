import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'vitest'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import {
  spawn,
  execFile,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { connect } from 'node:net'
import { promisify } from 'node:util'
import { resolveKimiGuardian } from './server.js'
import { KimiHomeLock, processStartTicks } from './lock.js'
import { captureAuthority, effectiveAuthority } from './authority.js'
import { deadline, kimiLimits, type KimiLimits } from './limits.js'
import {
  groupHasRunningMember,
  signalProcessGroup,
  waitForProcessGroupExit,
} from '../process-group.js'
import type { KimiLaunchAuthority } from './types.js'
import { retryFixtureAdmission } from './__fixtures__/admission.js'
import {
  fixtureEnvironment,
  fixtureEvidence,
  finishFixtureHomes,
  ownershipLog,
} from './__fixtures__/ownership.js'

const root = fileURLToPath(new URL('../../../../../', import.meta.url))
function controlled<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
const peer = fileURLToPath(new URL('./__fixtures__/peer.mjs', import.meta.url))
const guardianEntry = fileURLToPath(
  new URL('./__fixtures__/guardian.mjs', import.meta.url),
)
let runtime: string
const paths: string[] = [],
  guardians: {
    child: ChildProcessWithoutNullStreams
    closed: Promise<void>
    native?: number
    nativeTicks?: string
  }[] = []
beforeAll(async () => {
  await chmod(peer, 0o755)
  await promisify(execFile)('bun', ['run', 'build:kimi-guardian'], {
    cwd: root,
  })
}, 30000)
beforeEach(async () => {
  runtime = await temp()
  await fixtureEvidence('guardian_test.owns_runtime', { runtime })
})
afterEach(async () => {
  await fixtureEvidence('runner.logical_test_complete', { homes: paths })
  for (const owner of guardians.splice(0)) {
    if (owner.child.exitCode === null && owner.child.signalCode === null)
      owner.child.stdin.end()
    await deadline(owner.closed, 15000).catch(() => {})
    if (
      owner.native &&
      (await groupHasRunningMember(owner.native, performance.now() + 5000))
    ) {
      // Only fixture groups captured from this owned child may receive forced test cleanup.
      const ticks = await processStartTicks(owner.native)
      if (ticks !== undefined && ticks !== owner.nativeTicks)
        throw new Error('Fixture PID changed')
      signalProcessGroup(owner.native, 'SIGKILL')
      await fixtureEvidence('guardian_test.forced_cleanup', {
        pid: owner.native,
        startTicks: owner.nativeTicks,
      })
      await waitForProcessGroupExit(owner.native, performance.now() + 5000)
    }
    if (owner.child.exitCode === null && owner.child.signalCode === null)
      throw new Error('Fixture guardian still runs')
  }
  await finishFixtureHomes(paths)
  for (const path of paths.splice(0))
    await rm(path, { recursive: true, force: true })
})
async function temp() {
  const value = await mkdtemp(
    '/var/tmp/forge-comet-kimi-review-correction-v2-guardian-',
  )
  await chmod(value, 0o700)
  paths.push(value)
  return value
}
async function holdRegistry() {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(
        new URL('./__fixtures__/registry-holder.mjs', import.meta.url),
      ),
      join(runtime, 'forge-kimi', 'registry.lock'),
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )
  const closed = new Promise<void>((resolve) =>
    child.once('close', () => resolve()),
  )
  guardians.push({ child, closed })
  child.stderr.resume()
  await deadline(
    new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', () =>
        reject(new Error('Registry holder exited before admission')),
      )
      child.stdout.once('data', (bytes) => {
        if (String(bytes) === 'locked\n') resolve()
        else reject(new Error('Unexpected registry fixture response'))
      })
    }),
    5000,
  )
  await fixtureEvidence('guardian_test.registry_held', {
    runtime,
    pid: child.pid,
    startTicks: await processStartTicks(child.pid!),
  })
  return async () => {
    child.stdin.end()
    await deadline(closed, 5000)
    await fixtureEvidence('guardian_test.registry_released', {
      runtime,
      pid: child.pid,
    })
  }
}
async function selected(scenario = {}): Promise<KimiLaunchAuthority> {
  const home = await temp()
  await writeFile(
    join(home, 'fixture-scenario.json'),
    JSON.stringify(scenario),
    { mode: 0o600 },
  )
  return {
    provider: 'kimi-fixture',
    credentialPolicy: 'configured-native',
    environment: await fixtureEnvironment(home),
    account: {
      id: 'fixture',
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
  }
}
async function command(
  home: string,
  value: unknown,
): Promise<Record<string, unknown>> {
  const work = new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = connect(join(home, 'fixture.sock'))
    let buffer = ''
    socket.once('connect', () => socket.write(JSON.stringify(value) + '\n'))
    socket.on('data', (bytes) => {
      buffer += bytes
    })
    socket.once('end', () => {
      try {
        resolve(JSON.parse(buffer))
      } catch (error) {
        reject(error)
      }
    })
    socket.once('error', reject)
  })
  return deadline(work, 5000)
}
async function guardian(
  authority: KimiLaunchAuthority,
  overrides: Partial<KimiLimits> = {},
  artifact?: string,
) {
  return retryFixtureAdmission(async () => {
    const running = await startGuardian(authority, overrides, artifact)
    if (
      running.result.type === 'error' &&
      running.result.code === 'kimi_account_home_busy' &&
      !running.result.uncertain
    ) {
      await deadline(running.closed, 10000)
      await expect(
        readFile(join(authority.account.homePath, 'fixture.ready')),
      ).rejects.toMatchObject({ code: 'ENOENT' })
      throw Object.assign(new Error('Fixture lock admission refused'), {
        code: 'kimi_account_home_busy',
      })
    }
    return running
  })
}
async function startGuardian(
  authority: KimiLaunchAuthority,
  overrides: Partial<KimiLimits> = {},
  artifact?: string,
) {
  const child = spawn(
    process.execPath,
    [
      guardianEntry,
      artifact ?? (await resolveKimiGuardian()),
      runtime,
      JSON.stringify(kimiLimits(overrides)),
    ],
    { cwd: authority.account.homePath, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  const closed = new Promise<void>((resolve) =>
    child.once('close', () => resolve()),
  )
  const owner: (typeof guardians)[number] = { child, closed }
  guardians.push(owner)
  await fixtureEvidence('guardian_test.spawned', {
    pid: child.pid,
    startTicks: await processStartTicks(child.pid!),
    home: authority.account.homePath,
  })
  let stdout = '',
    stderr = '',
    buffer = ''
  const ready = controlled<Record<string, unknown>>()
  const messages: Record<string, unknown>[] = []
  child.stderr.on('data', (bytes) => {
    stderr += bytes
  })
  child.stdout.on('data', (bytes) => {
    stdout += bytes
    buffer += bytes
    for (
      let offset = buffer.indexOf('\n');
      offset >= 0;
      offset = buffer.indexOf('\n')
    ) {
      const value = JSON.parse(buffer.slice(0, offset))
      buffer = buffer.slice(offset + 1)
      messages.push(value)
      if (value.id === 'init') ready.resolve(value)
    }
  })
  child.once('error', ready.reject)
  child.stdin.write(
    JSON.stringify({
      id: 'init',
      op: 'initialize',
      authority,
      limits: kimiLimits(overrides),
      removals: [],
    }) + '\n',
  )
  const result = await deadline(ready.promise, 25000)
  await fixtureEvidence('guardian_test.initialized', {
    home: authority.account.homePath,
    runtime,
    result,
  })
  if (result.type === 'result') {
    owner.native = Number(
      await readFile(join(authority.account.homePath, 'fixture.ready'), 'utf8'),
    )
    owner.nativeTicks = await processStartTicks(owner.native)
  }
  return {
    result,
    child,
    closed,
    owner,
    messages,
    output: () => stdout + stderr,
  }
}

describe('Kimi guardian process and release acceptance', () => {
  test('reports registry contention before native startup without confusing it with home ownership', async () => {
    const authority = await selected()
    const effective = await effectiveAuthority(
      captureAuthority(authority, kimiLimits()),
    )
    const seed = await KimiHomeLock.acquire(
      effective.home,
      kimiLimits(),
      runtime,
    )
    await seed.release(true)
    const release = await holdRegistry()
    try {
      const running = await startGuardian(authority)
      expect(running.result, JSON.stringify(running.result)).toMatchObject({
        type: 'error',
        code: 'kimi_account_home_busy',
        uncertain: false,
      })
      await deadline(running.closed, 10000)
      await expect(
        readFile(join(authority.account.homePath, 'fixture.ready')),
      ).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await release()
    }
    const replacement = await guardian(authority)
    expect(
      replacement.result,
      JSON.stringify(replacement.result),
    ).toMatchObject({ type: 'result' })
  }, 30000)
  test.each(['interrupted', 'held_shutdown'] as const)(
    'the owning runner settles its original guardian and native group after %s',
    async (mode) => {
      const selectedAuthority = await selected({
        holdShutdown: mode === 'held_shutdown',
      })
      const limits = kimiLimits({ shutdownMs: 1500 })
      const authority = await effectiveAuthority(
        captureAuthority(selectedAuthority, limits),
      )
      const runner = spawn(
        process.execPath,
        [
          fileURLToPath(new URL('./__fixtures__/runner.mjs', import.meta.url)),
          JSON.stringify({
            artifact: await resolveKimiGuardian(),
            runtime,
            authority: selectedAuthority,
            limits,
            log: ownershipLog,
          }),
        ],
        { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
      )
      runner.stderr!.resume()
      const closed = new Promise<void>((resolve) =>
        runner.once('close', () => resolve()),
      )
      try {
        const ready = await deadline(
          new Promise<Record<string, unknown>>((resolve, reject) => {
            runner.once('message', (value) =>
              resolve(value as Record<string, unknown>),
            )
            runner.once('error', reject)
          }),
          25000,
        )
        expect(ready.result, JSON.stringify(ready.result)).toMatchObject({
          type: 'result',
        })
        const native = Number(
          await readFile(
            join(selectedAuthority.account.homePath, 'fixture.ready'),
            'utf8',
          ),
        )
        const originalTicks = await processStartTicks(native)
        expect(originalTicks).toBeDefined()
        if (mode === 'interrupted') runner.kill('SIGTERM')
        else runner.send({ op: 'close' })
        await deadline(closed, 15000)
        expect(
          await groupHasRunningMember(native, performance.now() + 5000),
        ).toBe(false)
        const allRows = (await readFile(ownershipLog, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
        const rows = allRows.filter((row) => row.runnerPid === runner.pid)
        expect(
          rows.some((row) => row.phase === 'owned_runner.logical_stop'),
        ).toBe(true)
        expect(
          rows.some(
            (row) => row.phase === 'owned_runner.guardian_physical_close',
          ),
        ).toBe(true)
        expect(
          rows.some((row) => row.phase === 'owned_runner.finalizer_settled'),
        ).toBe(true)
        if (mode === 'held_shutdown')
          expect(
            allRows.some(
              (row) =>
                row.phase === 'peer.sigterm' &&
                row.home === authority.home.path &&
                row.held,
            ),
          ).toBe(true)
        const lock = await retryFixtureAdmission(() =>
          KimiHomeLock.acquire(authority.home, limits, runtime),
        )
        await lock.release(true)
      } finally {
        if (runner.exitCode === null && runner.signalCode === null) {
          runner.kill('SIGTERM')
          await deadline(closed, 15000)
        }
      }
    },
    45000,
  )
  test('builds and starts the actual guardian from a staged distribution outside the repository', async () => {
    const stage = await temp(),
      directory = join(stage, 'apps/server/src')
    await mkdir(directory, { recursive: true })
    const artifact = join(directory, 'kimi-guardian.js')
    await copyFile(join(root, 'dist/kimi-guardian.js'), artifact)
    await copyFile(
      artifact,
      `/var/tmp/forge-comet-kimi-review-correction-v2-staged-guardian-${Date.now()}.js`,
    )
    expect(
      await resolveKimiGuardian(
        pathToFileURL(join(directory, 'index.js')).href,
      ),
    ).toBe(artifact)
    await expect(
      resolveKimiGuardian(pathToFileURL(join(stage, 'missing/index.js')).href),
    ).rejects.toMatchObject({ code: 'kimi_guardian_artifact_missing' })
    const authority = await selected({ banner: true }),
      running = await guardian(authority, {}, artifact)
    expect(running.result, JSON.stringify(running.result)).toMatchObject({
      type: 'result',
    })
    expect(
      (await command(authority.account.homePath, { op: 'inspect' })).cwd,
    ).toBe(authority.account.homePath)
    const token = await readFile(
      join(authority.account.homePath, 'server.token'),
      'utf8',
    )
    running.child.stdin.write(
      JSON.stringify({ id: 'close', op: 'close' }) + '\n',
    )
    await deadline(running.closed, 10000)
    expect(
      running.messages.some((message) => message.type === 'cleanup_proved'),
    ).toBe(true)
    expect(running.output().includes(token)).toBe(false)
    expect(
      await groupHasRunningMember(
        running.owner.native!,
        performance.now() + 5000,
      ),
    ).toBe(false)
  }, 30000)
  test.each([
    ['schema-depth', { schemaDepth: 65 }, {}],
    ['ordinary-depth', { ordinaryDepth: 33 }, {}],
    ['version', { version: '0.35.0' }, {}],
    ['schema-nodes', { schemaNodes: 50001 }, {}],
    ['schema-bytes', {}, { startupBytes: 4096 }],
    ['schema-buffer', {}, { hostHttpBufferBytes: 4096 }],
    ['startup-reads', {}, { startupReads: 1 }],
  ] as const)(
    'refuses %s during production startup and proves cleanup',
    async (_name, scenario, limits) => {
      const authority = await selected(scenario),
        running = await guardian(authority, limits)
      expect(running.result.type).toBe('error')
      await deadline(running.closed, 10000)
      expect(
        running.messages.some((message) => message.type === 'cleanup_proved'),
      ).toBe(true)
      const native = Number(
        await readFile(
          join(authority.account.homePath, 'fixture.ready'),
          'utf8',
        ),
      )
      expect(
        await groupHasRunningMember(native, performance.now() + 5000),
      ).toBe(false)
      const effective = await effectiveAuthority(
        captureAuthority(authority, kimiLimits()),
      )
      const replacement = await retryFixtureAdmission(() =>
        KimiHomeLock.acquire(effective.home, kimiLimits(), runtime),
      )
      await replacement.release(true)
    },
    30000,
  )
  test('holds the descriptor while a descendant survives its early leader exit', async () => {
    const authority = await selected(),
      running = await guardian(authority)
    expect(running.result, JSON.stringify(running.result)).toMatchObject({
      type: 'result',
    })
    const effective = await effectiveAuthority(
      captureAuthority(authority, kimiLimits()),
    )
    await command(authority.account.homePath, { op: 'spawn_descendant' })
    await expect(
      KimiHomeLock.acquire(effective.home, kimiLimits(), runtime),
    ).rejects.toMatchObject({ code: 'kimi_account_home_busy' })
    await command(authority.account.homePath, { op: 'exit' })
    await deadline(running.closed, 10000)
    expect(
      await groupHasRunningMember(
        running.owner.native!,
        performance.now() + 5000,
      ),
    ).toBe(false)
    expect(
      running.messages.some((message) => message.type === 'cleanup_proved'),
    ).toBe(true)
    const replacement = await retryFixtureAdmission(() =>
      KimiHomeLock.acquire(effective.home, kimiLimits(), runtime),
    )
    await replacement.release(true)
  }, 30000)
  test('hard guardian death leaves a dirty fence until the captured group is absent', async () => {
    const authority = await selected(),
      running = await guardian(authority)
    expect(running.result, JSON.stringify(running.result)).toMatchObject({
      type: 'result',
    })
    const effective = await effectiveAuthority(
      captureAuthority(authority, kimiLimits()),
    )
    await command(authority.account.homePath, { op: 'spawn_descendant' })
    running.child.kill('SIGKILL')
    await running.closed
    expect(
      await groupHasRunningMember(
        running.owner.native!,
        performance.now() + 5000,
      ),
    ).toBe(true)
    const release = await holdRegistry()
    try {
      await expect(
        KimiHomeLock.acquire(effective.home, kimiLimits(), runtime),
      ).rejects.toMatchObject({ code: 'kimi_account_home_busy' })
    } finally {
      await release()
    }
    await expect(
      KimiHomeLock.acquire(effective.home, kimiLimits(), runtime),
    ).rejects.toMatchObject({ code: 'kimi_home_cleanup_unproved' })
    expect(await processStartTicks(running.owner.native!)).toBe(
      running.owner.nativeTicks,
    )
    signalProcessGroup(running.owner.native!, 'SIGKILL')
    await waitForProcessGroupExit(
      running.owner.native!,
      performance.now() + 5000,
    )
    const replacement = await retryFixtureAdmission(() =>
      KimiHomeLock.acquire(effective.home, kimiLimits(), runtime),
    )
    await replacement.release(true)
  }, 30000)
  test('SIGTERM closes the owned group before the permanent lease becomes reusable', async () => {
    const authority = await selected(),
      running = await guardian(authority)
    expect(running.result, JSON.stringify(running.result)).toMatchObject({
      type: 'result',
    })
    await command(authority.account.homePath, { op: 'spawn_descendant' })
    running.child.kill('SIGTERM')
    await deadline(running.closed, 10000)
    expect(
      running.messages.some((message) => message.type === 'cleanup_proved'),
    ).toBe(true)
    expect(
      await groupHasRunningMember(
        running.owner.native!,
        performance.now() + 5000,
      ),
    ).toBe(false)
  }, 30000)
  test('parent EOF cleans the native group even when the response channel has ended', async () => {
    const authority = await selected(),
      running = await guardian(authority)
    expect(running.result, JSON.stringify(running.result)).toMatchObject({
      type: 'result',
    })
    await command(authority.account.homePath, { op: 'spawn_descendant' })
    running.child.stdin.end()
    await deadline(running.closed, 10000)
    expect(
      await groupHasRunningMember(
        running.owner.native!,
        performance.now() + 5000,
      ),
    ).toBe(false)
    const effective = await effectiveAuthority(
      captureAuthority(authority, kimiLimits()),
    )
    const replacement = await retryFixtureAdmission(() =>
      KimiHomeLock.acquire(effective.home, kimiLimits(), runtime),
    )
    await replacement.release(true)
  }, 30000)
})
