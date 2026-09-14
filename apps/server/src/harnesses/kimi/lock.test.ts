import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest'
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
  unlink,
  rename,
  symlink,
} from 'node:fs/promises'
import { execFile, fork } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { KimiHomeLock, processStartTicks } from './lock.js'
import { directoryIdentity } from './authority.js'
import { deadline, kimiLimits } from './limits.js'

const control = vi.hoisted(() => ({
  beforeOpen: undefined as undefined | ((path: string) => Promise<void>),
  afterOpen: undefined as
    | undefined
    | ((path: string, file: import('node:fs/promises').FileHandle) => void),
  beforeLink: undefined as undefined | (() => Promise<void>),
  handles: new Set<import('node:fs/promises').FileHandle>(),
}))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return {
    ...fs,
    link: async (...args: Parameters<typeof fs.link>) => {
      await control.beforeLink?.()
      return fs.link(...args)
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const path = String(args[0])
      await control.beforeOpen?.(path)
      const file = await fs.open(...args)
      control.handles.add(file)
      const close = file.close.bind(file)
      file.close = async () => {
        await close()
        control.handles.delete(file)
      }
      control.afterOpen?.(path, file)
      return file
    },
  }
})

const roots: string[] = []
const locks: KimiHomeLock[] = []
let processFixture: string
let buildRoot: string
beforeAll(async () => {
  buildRoot = await mkdtemp('/var/tmp/forge-comet-kimi-gate-repair-lock-build-')
  processFixture = join(buildRoot, 'lock-process.mjs')
  await promisify(execFile)('bun', [
    'build',
    '--target=node',
    fileURLToPath(new URL('./__fixtures__/lock-process.ts', import.meta.url)),
    '--outfile',
    processFixture,
  ])
})
afterAll(async () => {
  await rm(buildRoot, { recursive: true, force: true })
})
function barrier() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => (release = resolve))
  return { promise, release }
}
async function fixture() {
  const root = await mkdtemp('/var/tmp/forge-comet-kimi-gate-repair-lock-')
  roots.push(root)
  const home = join(root, 'home')
  const runtime = join(root, 'runtime')
  await mkdir(home, { mode: 0o700 })
  await mkdir(runtime, { mode: 0o700 })
  console.info('owned lock fixture before admission', {
    root,
    checkout: process.cwd(),
    pid: process.pid,
    startTicks: await processStartTicks(process.pid),
    boot: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
    rootIdentity: { dev: (await stat(root)).dev, ino: (await stat(root)).ino },
  })
  return { root, runtime, home: await directoryIdentity(home, true) }
}
async function acquire(f: Awaited<ReturnType<typeof fixture>>) {
  const lock = await KimiHomeLock.acquire(f.home, kimiLimits(), f.runtime)
  locks.push(lock)
  return lock
}
afterEach(async () => {
  control.beforeOpen = undefined
  control.afterOpen = undefined
  control.beforeLink = undefined
  for (const lock of locks.splice(0)) await lock.release(true)
  expect(control.handles.size).toBe(0)
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true })
})

test('the first published registry inode is already locked across registration awaits', async () => {
  const f = await fixture()
  const creatorSync = barrier()
  const resumeCreator = barrier()
  const contenderRead = barrier()
  const resumeContender = barrier()
  let selected = false
  control.afterOpen = (path, file) => {
    if (selected || !/\/registry\.(?:lock|candidate)$/.test(path)) return
    selected = true
    const sync = file.sync.bind(file)
    file.sync = async () => {
      creatorSync.release()
      await resumeCreator.promise
      await sync()
    }
  }
  control.beforeOpen = async (path) => {
    if (!path.endsWith('/registry.json')) return
    contenderRead.release()
    await resumeContender.promise
  }
  const first = acquire(f)
  const firstResult = Promise.allSettled([first])
  let secondResult: Promise<PromiseSettledResult<KimiHomeLock>[]> | undefined
  try {
    await creatorSync.promise
    secondResult = Promise.allSettled([acquire(f)])
    const stage = await Promise.race([
      contenderRead.promise.then(() => 'read'),
      secondResult.then(() => 'settled'),
    ])
    resumeCreator.release()
    if (stage === 'settled') resumeContender.release()
    const [creator] = await firstResult
    resumeContender.release()
    const [contender] = await secondResult
    console.info('registration ordering results', {
      creator: creator.status === 'rejected' ? creator.reason.code : 'accepted',
      contender:
        contender.status === 'rejected' ? contender.reason.code : 'accepted',
      openDescriptors: control.handles.size,
      files: await readdir(join(f.runtime, 'forge-kimi')),
      permanentRegistry: {
        stat: await stat(join(f.runtime, 'forge-kimi', 'registry.lock')),
        bytes: await readFile(
          join(f.runtime, 'forge-kimi', 'registry.lock'),
          'utf8',
        ),
      },
    })
    expect(creator.status).toBe('fulfilled')
    expect(contender).toMatchObject({
      status: 'rejected',
      reason: { code: 'kimi_registry_candidate_unresolved' },
    })
    const registryPath = join(f.runtime, 'forge-kimi', 'registry.lock')
    const before = await stat(registryPath)
    if (creator.status === 'fulfilled') await creator.value.release(true)
    control.beforeOpen = undefined
    control.afterOpen = undefined
    const reused = await acquire(f)
    await reused.release(true)
    expect((await stat(registryPath)).ino).toBe(before.ino)
    expect((await stat(registryPath)).mode & 0o777).toBe(0o600)
    expect((await readdir(join(f.runtime, 'forge-kimi'))).sort()).toHaveLength(
      3,
    )
    expect(control.handles.size).toBe(0)
  } finally {
    resumeCreator.release()
    resumeContender.release()
    await firstResult
    await secondResult
  }
}, 15000)

test('a delayed candidate creator loses publication to the already-locked permanent inode', async () => {
  const f = await fixture()
  const candidateOpen = barrier()
  const resumeCandidate = barrier()
  const registryRead = barrier()
  const resumeRegistry = barrier()
  let selected = false
  control.beforeOpen = async (path) => {
    if (path.endsWith('/registry.candidate') && !selected) {
      selected = true
      candidateOpen.release()
      await resumeCandidate.promise
    } else if (path.endsWith('/registry.json')) {
      registryRead.release()
      await resumeRegistry.promise
    }
  }
  const delayed = Promise.allSettled([acquire(f)])
  let winner: Promise<PromiseSettledResult<KimiHomeLock>[]> | undefined
  try {
    await candidateOpen.promise
    winner = Promise.allSettled([acquire(f)])
    await registryRead.promise
    resumeCandidate.release()
    expect((await delayed)[0]).toMatchObject({
      status: 'rejected',
      reason: { code: 'kimi_account_home_busy' },
    })
    expect(await readdir(join(f.runtime, 'forge-kimi'))).toEqual([
      'registry.lock',
    ])
    resumeRegistry.release()
    const [result] = await winner
    expect(result.status).toBe('fulfilled')
    if (result.status === 'fulfilled') await result.value.release(true)
    expect(control.handles.size).toBe(0)
  } finally {
    resumeCandidate.release()
    resumeRegistry.release()
    await delayed
    await winner
  }
}, 15000)

test.each(['sync', 'link'] as const)(
  'a candidate %s failure closes its descriptor and removes only its private name',
  async (phase) => {
    const f = await fixture()
    const failure = new Error(`injected candidate ${phase} failure`)
    if (phase === 'sync') {
      control.afterOpen = (path, file) => {
        if (path.endsWith('.candidate'))
          file.sync = async () => {
            throw failure
          }
      }
    } else
      control.beforeLink = async () => {
        throw failure
      }
    await expect(acquire(f)).rejects.toBe(failure)
    expect(control.handles.size).toBe(0)
    expect(await readdir(join(f.runtime, 'forge-kimi'))).toEqual([])
    control.afterOpen = undefined
    control.beforeLink = undefined
    await (await acquire(f)).release(true)
  },
)

test('candidate replacement is refused without removing the replacement inode', async () => {
  const f = await fixture()
  let replacement = ''
  let replacementInode = 0
  control.afterOpen = (path, file) => {
    if (!path.endsWith('.candidate')) return
    file.sync = async () => {
      replacement = join(
        f.runtime,
        'forge-kimi',
        path.slice(path.lastIndexOf('/') + 1),
      )
      await rename(replacement, `${replacement}.original`)
      await writeFile(replacement, 'foreign candidate', {
        mode: 0o600,
        flag: 'wx',
      })
      replacementInode = (await stat(replacement)).ino
    }
  }
  await expect(acquire(f)).rejects.toMatchObject({
    code: 'kimi_lock_identity_changed',
  })
  expect(control.handles.size).toBe(0)
  expect((await stat(replacement)).ino).toBe(replacementInode)
  expect(await readFile(replacement, 'utf8')).toBe('foreign candidate')
  expect((await readdir(join(f.runtime, 'forge-kimi'))).sort()).toEqual([
    replacement.slice(replacement.lastIndexOf('/') + 1),
    `${replacement.slice(replacement.lastIndexOf('/') + 1)}.original`,
  ])
})

test.each(['missing', 'malformed', 'wrong-inode'] as const)(
  'an existing permanent registry with %s data remains fail-closed',
  async (kind) => {
    const f = await fixture()
    await (await acquire(f)).release(true)
    const directory = join(f.runtime, 'forge-kimi')
    const lockPath = join(directory, 'registry.lock')
    const registryPath = join(directory, 'registry.json')
    const original = await stat(lockPath)
    if (kind === 'missing') await unlink(registryPath)
    else if (kind === 'malformed') await writeFile(registryPath, '{')
    else {
      const registry = JSON.parse(await readFile(registryPath, 'utf8'))
      registry.registryLock.ino++
      await writeFile(registryPath, JSON.stringify(registry))
    }
    await expect(acquire(f)).rejects.toMatchObject({
      code: 'kimi_registry_corrupt',
    })
    expect((await stat(lockPath)).ino).toBe(original.ino)
    expect(
      (await readdir(directory)).some((name) => name.endsWith('.candidate')),
    ).toBe(false)
    expect(control.handles.size).toBe(0)
  },
)

test('a failure after publication keeps the permanent inode and refuses missing registry recovery', async () => {
  const f = await fixture()
  const failure = new Error('injected directory sync failure after publication')
  let linked = false
  control.beforeLink = async () => {
    linked = true
  }
  control.afterOpen = (path, file) => {
    if (path !== join(f.runtime, 'forge-kimi')) return
    const sync = file.sync.bind(file)
    file.sync = async () => {
      if (linked) throw failure
      await sync()
    }
  }
  await expect(acquire(f)).rejects.toBe(failure)
  const path = join(f.runtime, 'forge-kimi', 'registry.lock')
  const original = await stat(path)
  expect(await readdir(join(f.runtime, 'forge-kimi'))).toEqual([
    'registry.lock',
  ])
  expect(control.handles.size).toBe(0)
  control.afterOpen = undefined
  control.beforeLink = undefined
  await expect(acquire(f)).rejects.toMatchObject({
    code: 'kimi_registry_corrupt',
  })
  expect((await stat(path)).ino).toBe(original.ino)
})

test('a registry symlink cannot publish a candidate or replace its target', async () => {
  const f = await fixture()
  const directory = join(f.runtime, 'forge-kimi')
  await mkdir(directory, { mode: 0o700 })
  const target = join(f.root, 'target')
  await writeFile(target, 'unchanged', { mode: 0o600 })
  await symlink(target, join(directory, 'registry.lock'))
  await expect(acquire(f)).rejects.toMatchObject({ code: 'ELOOP' })
  expect(await readFile(target, 'utf8')).toBe('unchanged')
  expect(await readdir(directory)).toEqual(['registry.lock'])
})

test('independent processes publish one locked registry and retain conflict and reuse behavior', async () => {
  const f = await fixture()
  type Report = {
    phase: string
    status?: string
    code?: string
    handles?: number
    pid?: number
    startTicks?: string
    boot?: string
  }
  type Peer = {
    wait(phase: string): Promise<Report>
    send(command: string): boolean
    closed: Promise<number | null>
    expectedExit: number | null
    crash(): Promise<void>
  }
  const peers: Peer[] = []
  function peer(role: string, target = f): Peer {
    const child = fork(
      processFixture,
      [target.runtime, target.home.path, role],
      {
        execPath: process.execPath,
        cwd: process.cwd(),
        env: { PATH: process.env.PATH },
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      },
    )
    const reports = new Map<string, Report>()
    const waiting = new Map<string, (value: Report) => void>()
    child.on('message', (value) => {
      const report = value as Report
      reports.set(report.phase, report)
      waiting.get(report.phase)?.(report)
      console.info('owned lock process', { role, ...report })
    })
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    void closed.catch(() => {})
    const p: Peer = {
      wait: (phase: string) =>
        reports.has(phase)
          ? Promise.resolve(reports.get(phase)!)
          : deadline(
              Promise.race([
                new Promise<Report>((resolve) => waiting.set(phase, resolve)),
                closed.then(() => {
                  throw new Error(`Fixture exited before ${phase}`)
                }),
              ]),
              10000,
            ),
      send: (command: string) => child.connected && child.send(command),
      closed,
      expectedExit: 0,
      crash: async () => {
        const original = reports.get('owned')!
        expect(child.pid).toBe(original.pid)
        expect(await processStartTicks(original.pid!)).toBe(original.startTicks)
        expect(
          (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
        ).toBe(original.boot)
        p.expectedExit = null
        expect(child.kill('SIGKILL')).toBe(true)
        expect(await closed).toBe(null)
        expect(child.signalCode).toBe('SIGKILL')
        console.info('owned candidate process crash settled', original)
      },
    }
    peers.push(p)
    return p
  }
  try {
    const creator = peer('creator')
    const contender = peer('contender')
    await Promise.all([creator.wait('owned'), contender.wait('owned')])
    creator.send('start')
    await creator.wait('candidate_sync')
    const directory = join(f.runtime, 'forge-kimi')
    const candidates = await readdir(directory)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toBe('registry.candidate')
    expect((await stat(join(directory, candidates[0]))).mode & 0o777).toBe(
      0o600,
    )
    contender.send('start')
    expect(await contender.wait('result')).toMatchObject({
      status: 'rejected',
      code: 'kimi_registry_candidate_unresolved',
      handles: 0,
    })
    expect(
      (await readdir(directory)).filter((name) => name.endsWith('.candidate')),
    ).toHaveLength(1)
    creator.send('resume')
    expect(await creator.wait('result')).toMatchObject({
      status: 'accepted',
      handles: 2,
    })
    const original = await stat(join(directory, 'registry.lock'))
    const conflict = peer('ordinary')
    await conflict.wait('owned')
    conflict.send('start')
    expect(await conflict.wait('result')).toMatchObject({
      status: 'rejected',
      code: 'kimi_account_home_busy',
      handles: 0,
    })
    creator.send('release')
    expect(await creator.wait('settled')).toMatchObject({ handles: 0 })
    expect(await creator.closed).toBe(0)
    const reused = peer('ordinary')
    await reused.wait('owned')
    reused.send('start')
    expect(await reused.wait('result')).toMatchObject({
      status: 'accepted',
      handles: 2,
    })
    reused.send('release')
    expect(await reused.wait('settled')).toMatchObject({ handles: 0 })
    expect((await stat(join(directory, 'registry.lock'))).ino).toBe(
      original.ino,
    )
    expect(
      (await readdir(directory)).some((name) => name.endsWith('.candidate')),
    ).toBe(false)
    const abandoned = await fixture()
    const crashed = peer('creator', abandoned)
    await crashed.wait('owned')
    crashed.send('start')
    await crashed.wait('candidate_sync')
    const abandonedDirectory = join(abandoned.runtime, 'forge-kimi')
    const candidatePath = join(abandonedDirectory, 'registry.candidate')
    const candidateBefore = await stat(candidatePath)
    await crashed.crash()
    for (let attempt = 0; attempt < 12; attempt++) {
      await expect(acquire(abandoned)).rejects.toMatchObject({
        code: 'kimi_registry_candidate_unresolved',
      })
      expect(await readdir(abandonedDirectory)).toEqual(['registry.candidate'])
      expect(await stat(candidatePath)).toEqual(candidateBefore)
      expect(control.handles.size).toBe(0)
    }
    // Fresh processes prove the persistent slot does not depend on a local queue.
    for (let attempt = 0; attempt < 2; attempt++) {
      const next = peer('ordinary', abandoned)
      await next.wait('owned')
      next.send('start')
      expect(await next.wait('result')).toMatchObject({
        status: 'rejected',
        code: 'kimi_registry_candidate_unresolved',
        handles: 0,
      })
      next.send('release')
      expect(await next.wait('settled')).toMatchObject({ handles: 0 })
      expect(await next.closed).toBe(0)
    }
    expect(await readdir(abandonedDirectory)).toEqual(['registry.candidate'])
    expect(await stat(candidatePath)).toEqual(candidateBefore)
    console.info('bounded retained candidate after 14 admissions', {
      path: candidatePath,
      stat: candidateBefore,
      bytes: await readFile(candidatePath, 'utf8'),
    })
  } finally {
    for (const p of peers) {
      p.send('start')
      p.send('resume')
      p.send('release')
    }
    expect(await Promise.all(peers.map((p) => p.closed))).toEqual(
      peers.map((p) => p.expectedExit),
    )
  }
}, 20000)
