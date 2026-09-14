import { constants } from 'node:fs'
import {
  open,
  mkdir,
  link,
  unlink,
  readFile,
  rename,
  type FileHandle,
} from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { groupHasRunningMember } from '../process-group.js'
import { KimiError, deadline, jsonBytes, type KimiLimits } from './limits.js'
import { assertIdentity, type FileIdentity } from './authority.js'

type Inode = { dev: number; ino: number }
type Registration = { home: FileIdentity; lock: Inode }
type Registry = {
  version: 1
  directory: Inode
  registryLock: Inode
  homes: Record<string, Registration>
}
type Lease =
  | { state: 'clean' }
  | { state: 'starting'; boot: string; nonce: string }
  | {
      state: 'active'
      boot: string
      nonce: string
      pgid: number
      startTicks: string
    }
const nofollow = constants.O_NOFOLLOW
const inode = (value: Inode): Inode => ({ dev: value.dev, ino: value.ino })
const equal = (a: Inode, b: Inode) => a.dev === b.dev && a.ino === b.ino

async function privateFile(file: FileHandle) {
  const info = await file.stat()
  if (
    !info.isFile() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o777) !== 0o600
  )
    throw new KimiError('kimi_unsafe_lock')
  return info
}
async function boundedRead(file: FileHandle, limit: number) {
  const info = await privateFile(file)
  if (info.size > limit) throw new KimiError('kimi_lock_limit')
  const bytes = Buffer.alloc(limit + 1)
  const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
  if (bytesRead > limit) throw new KimiError('kimi_lock_limit')
  return new TextDecoder('utf8', { fatal: true }).decode(
    bytes.subarray(0, bytesRead),
  )
}
async function samePath(file: FileHandle, path: string) {
  const current = await open(path, constants.O_RDONLY | nofollow)
  try {
    if (!equal(await file.stat(), await current.stat()))
      throw new KimiError('kimi_lock_identity_changed')
  } finally {
    await current.close()
  }
}
async function flock(file: FileHandle, ms: number) {
  // fd 3 shares the guardian's open file description. Keep file open after flock exits.
  const utility = spawn('/usr/bin/flock', ['--nonblock', '3'], {
    stdio: ['ignore', 'ignore', 'ignore', file.fd],
  })
  const done = new Promise<void>((resolve, reject) => {
    utility.once('error', () => reject(new KimiError('kimi_lock_unavailable')))
    utility.once('exit', (code) =>
      code === 0 ? resolve() : reject(new KimiError('kimi_account_home_busy')),
    )
  })
  try {
    await deadline(done, ms)
  } catch (error) {
    utility.kill('SIGTERM')
    await done.catch(() => {})
    throw error
  }
}
async function writeRecord(
  file: FileHandle,
  record: unknown,
  limits: Readonly<KimiLimits>,
  maximum: number,
) {
  jsonBytes(record, limits, maximum)
  const bytes = Buffer.from(JSON.stringify(record))
  await file.truncate(0)
  await file.write(bytes, 0, bytes.length, 0)
  await file.sync()
}

export async function processStartTicks(
  pid: number,
): Promise<string | undefined> {
  let file: FileHandle
  try {
    file = await open(`/proc/${pid}/stat`, constants.O_RDONLY | nofollow)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  try {
    const bytes = Buffer.alloc(4096)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    if (bytesRead === bytes.length)
      throw new KimiError('kimi_process_identity_unavailable')
    const value = bytes.toString('utf8', 0, bytesRead)
    const fields = value.slice(value.lastIndexOf(')') + 2).split(' ')
    const ticks = fields[19]
    if (!ticks || !/^\d+$/.test(ticks))
      throw new KimiError('kimi_process_identity_unavailable')
    return ticks
  } finally {
    await file.close()
  }
}

/** Permanent, cooperative per-user registry. This does not contain arbitrary same-user processes. */
export class KimiHomeLock {
  private lease: Lease = { state: 'clean' }
  private closed = false
  private constructor(
    readonly home: FileIdentity,
    private readonly directory: FileHandle,
    private readonly directoryPath: string,
    private readonly file: FileHandle,
    private readonly filePath: string,
    private readonly boot: string,
    private readonly limits: Readonly<KimiLimits>,
  ) {}

  static async acquire(
    home: FileIdentity,
    limits: Readonly<KimiLimits>,
    // Internal filesystem seam for owned tests. It is not a host or adapter option.
    runtimeParent = `/run/user/${process.getuid?.()}`,
  ): Promise<KimiHomeLock> {
    const parent = await open(
      runtimeParent,
      constants.O_RDONLY | constants.O_DIRECTORY | nofollow,
    )
    let directory: FileHandle | undefined,
      registryLock: FileHandle | undefined,
      file: FileHandle | undefined
    try {
      const parentInfo = await parent.stat()
      if (parentInfo.uid !== process.getuid?.() || parentInfo.mode & 0o077)
        throw new KimiError('kimi_unsafe_lock_directory')
      const directoryPath = join(runtimeParent, 'forge-kimi')
      try {
        await mkdir(`/proc/self/fd/${parent.fd}/forge-kimi`, { mode: 0o700 })
        await parent.sync()
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      directory = await open(
        directoryPath,
        constants.O_RDONLY | constants.O_DIRECTORY | nofollow,
      )
      const directoryInfo = await directory.stat()
      if (
        directoryInfo.uid !== process.getuid?.() ||
        (directoryInfo.mode & 0o777) !== 0o700
      )
        throw new KimiError('kimi_unsafe_lock_directory')
      await samePath(parent, runtimeParent)
      await samePath(directory, directoryPath)
      const anchored = `/proc/self/fd/${directory.fd}`
      const registryLockPath = join(anchored, 'registry.lock')
      let createdRegistryLock = false
      try {
        registryLock = await open(registryLockPath, constants.O_RDWR | nofollow)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        // Publish only an already-locked inode. A contender must never own an
        // uninitialized permanent registry while its creator waits for flock.
        // One persistent slot also bounds candidates across failed startups.
        // Never open, adopt, or remove a candidate left by another owner.
        const candidatePath = join(anchored, 'registry.candidate')
        let candidate: FileHandle
        try {
          candidate = await open(
            candidatePath,
            constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | nofollow,
            0o600,
          )
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST')
            throw new KimiError('kimi_registry_candidate_unresolved')
          throw error
        }
        try {
          await privateFile(candidate)
          await flock(candidate, limits.guardianControlMs)
          await candidate.sync()
          await samePath(candidate, candidatePath)
          try {
            await link(candidatePath, registryLockPath)
            registryLock = candidate
            createdRegistryLock = true
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          }
          if (createdRegistryLock) await directory.sync()
        } finally {
          try {
            await samePath(candidate, candidatePath)
            await unlink(candidatePath)
            await directory.sync()
          } finally {
            if (registryLock !== candidate) await candidate.close()
          }
        }
        registryLock ??= await open(
          registryLockPath,
          constants.O_RDWR | nofollow,
        )
      }
      const registryLockInfo = await privateFile(registryLock)
      if (!createdRegistryLock)
        await flock(registryLock, limits.guardianControlMs)
      await samePath(registryLock, registryLockPath)
      let registry: Registry
      try {
        const index = await open(
          join(anchored, 'registry.json'),
          constants.O_RDONLY | nofollow,
        )
        try {
          registry = JSON.parse(
            await boundedRead(index, limits.lockRegistryBytes),
          ) as Registry
        } finally {
          await index.close()
        }
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== 'ENOENT' ||
          !createdRegistryLock
        )
          throw new KimiError('kimi_registry_corrupt')
        registry = {
          version: 1,
          directory: inode(directoryInfo),
          registryLock: inode(registryLockInfo),
          homes: {},
        }
      }
      jsonBytes(registry, limits, limits.lockRegistryBytes)
      if (
        registry.version !== 1 ||
        !equal(registry.directory, directoryInfo) ||
        !equal(registry.registryLock, registryLockInfo) ||
        !registry.homes ||
        Array.isArray(registry.homes)
      )
        throw new KimiError('kimi_registry_corrupt')
      const key = createHash('sha256').update(home.path).digest('hex')
      const filePath = join(directoryPath, `${key}.lock`)
      const anchoredPath = join(anchored, `${key}.lock`)
      const registration = registry.homes[key]
      if (registration) {
        if (
          !equal(registration.home, home) ||
          registration.home.path !== home.path
        )
          throw new KimiError('kimi_home_identity_changed')
        file = await open(anchoredPath, constants.O_RDWR | nofollow)
        if (!equal(await privateFile(file), registration.lock))
          throw new KimiError('kimi_lock_identity_changed')
      } else {
        if (Object.keys(registry.homes).length >= limits.lockRegistryEntries)
          throw new KimiError('kimi_registry_limit')
        file = await open(
          anchoredPath,
          constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | nofollow,
          0o600,
        )
        await writeRecord(
          file,
          { state: 'clean' },
          limits,
          limits.lockRecordBytes,
        )
        registry.homes[key] = { home, lock: inode(await privateFile(file)) }
        const temporaryPath = join(
          anchored,
          `registry-${randomBytes(16).toString('hex')}.tmp`,
        )
        const temporary = await open(
          temporaryPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | nofollow,
          0o600,
        )
        try {
          await writeRecord(
            temporary,
            registry,
            limits,
            limits.lockRegistryBytes,
          )
        } finally {
          await temporary.close()
        }
        await rename(temporaryPath, join(anchored, 'registry.json'))
        await directory.sync()
      }
      await flock(file, limits.guardianControlMs)
      await samePath(directory, directoryPath)
      await samePath(file, filePath)
      await assertIdentity(home)
      const boot = (
        await readFile('/proc/sys/kernel/random/boot_id', 'utf8')
      ).trim()
      if (!/^[0-9a-f-]{36}$/.test(boot))
        throw new KimiError('kimi_boot_identity_unavailable')
      const lock = new KimiHomeLock(
        home,
        directory,
        directoryPath,
        file,
        filePath,
        boot,
        limits,
      )
      await lock.recover()
      directory = undefined
      file = undefined
      return lock
    } finally {
      await registryLock?.close()
      await file?.close()
      await directory?.close()
      await parent.close()
    }
  }

  private async recover() {
    try {
      const record: unknown = JSON.parse(
        await boundedRead(this.file, this.limits.lockRecordBytes),
      )
      if (!record || typeof record !== 'object') throw new Error()
      const lease = record as Lease
      if (lease.state === 'clean' && Object.keys(lease).length === 1) return
      if (
        (lease.state !== 'active' && lease.state !== 'starting') ||
        !/^[0-9a-f-]{36}$/.test(lease.boot) ||
        !/^[0-9a-f]{32}$/.test(lease.nonce) ||
        Object.keys(lease).length !== (lease.state === 'active' ? 5 : 3) ||
        (lease.state === 'active' &&
          (!Number.isSafeInteger(lease.pgid) ||
            lease.pgid <= 1 ||
            !/^\d+$/.test(lease.startTicks)))
      )
        throw new Error()
      if (lease.boot !== this.boot) {
        await writeRecord(
          this.file,
          { state: 'clean' },
          this.limits,
          this.limits.lockRecordBytes,
        )
        return
      }
      if (
        lease.state !== 'active' ||
        !Number.isSafeInteger(lease.pgid) ||
        lease.pgid <= 1 ||
        !/^\d+$/.test(lease.startTicks)
      )
        throw new Error()
      const ticks = await processStartTicks(lease.pgid)
      if (ticks !== undefined && ticks !== lease.startTicks) throw new Error()
      if (
        await groupHasRunningMember(
          lease.pgid,
          performance.now() + this.limits.shutdownMs,
        )
      )
        throw new Error()
      await writeRecord(
        this.file,
        { state: 'clean' },
        this.limits,
        this.limits.lockRecordBytes,
      )
    } catch {
      throw new KimiError('kimi_home_cleanup_unproved')
    }
  }

  async starting() {
    await this.validate()
    this.lease = {
      state: 'starting',
      boot: this.boot,
      nonce: randomBytes(16).toString('hex'),
    }
    await writeRecord(
      this.file,
      this.lease,
      this.limits,
      this.limits.lockRecordBytes,
    )
  }
  async active(pgid: number) {
    if (this.lease.state !== 'starting') throw new KimiError('kimi_lease_state')
    const startTicks = await processStartTicks(pgid)
    if (!startTicks) throw new KimiError('kimi_process_identity_unavailable')
    this.lease = { ...this.lease, state: 'active', pgid, startTicks }
    await writeRecord(
      this.file,
      this.lease,
      this.limits,
      this.limits.lockRecordBytes,
    )
    await this.validate()
  }
  async validate() {
    if (this.closed) throw new KimiError('kimi_lock_closed')
    await samePath(this.directory, this.directoryPath)
    await samePath(this.file, this.filePath)
    await assertIdentity(this.home)
  }
  async release(cleanupProved: boolean) {
    if (this.closed) return
    if (!cleanupProved) throw new KimiError('kimi_home_cleanup_unproved')
    if (
      this.lease.state === 'active' &&
      (await groupHasRunningMember(
        this.lease.pgid,
        performance.now() + this.limits.shutdownMs,
      ))
    )
      throw new KimiError('kimi_home_cleanup_unproved')
    await this.validate()
    await writeRecord(
      this.file,
      { state: 'clean' },
      this.limits,
      this.limits.lockRecordBytes,
    )
    this.closed = true
    await this.file.close()
    await this.directory.close()
  }
}

export type KimiToken = { value: string; identity: Inode; size: number }
export async function readToken(
  home: FileIdentity,
  limits: Readonly<KimiLimits>,
): Promise<KimiToken> {
  for (let attempt = 0; attempt < limits.tokenReadAttempts; attempt++) {
    try {
      return await readTokenOnce(home, limits)
    } catch (error) {
      if (
        !(error instanceof KimiError && error.code === 'kimi_token_changed') ||
        attempt + 1 === limits.tokenReadAttempts
      )
        throw error
    }
  }
  throw new KimiError('kimi_token_changed')
}
async function readTokenOnce(
  home: FileIdentity,
  limits: Readonly<KimiLimits>,
): Promise<KimiToken> {
  await assertIdentity(home)
  const path = join(home.path, 'server.token')
  const file = await open(path, constants.O_RDONLY | nofollow)
  try {
    const info = await privateFile(file)
    const value = await boundedRead(file, limits.tokenBytes)
    if (!value || /\s/.test(value)) throw new KimiError('kimi_unsafe_token')
    await samePath(file, path)
    const after = await privateFile(file)
    if (
      info.size !== after.size ||
      info.mtimeMs !== after.mtimeMs ||
      info.ctimeMs !== after.ctimeMs
    )
      throw new KimiError('kimi_token_changed')
    return { value, identity: inode(info), size: info.size }
  } finally {
    await file.close()
  }
}
export async function ensureToken(
  home: FileIdentity,
  limits: Readonly<KimiLimits>,
) {
  try {
    return await readToken(home, limits)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const temporaryPath = join(
    home.path,
    `.forge-token-${randomBytes(16).toString('hex')}`,
  )
  const file = await open(
    temporaryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | nofollow,
    0o600,
  )
  try {
    await file.writeFile(randomBytes(32).toString('base64url'))
    await file.sync()
    try {
      await link(temporaryPath, join(home.path, 'server.token'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const directory = await open(
      home.path,
      constants.O_RDONLY | constants.O_DIRECTORY | nofollow,
    )
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } finally {
    await file.close()
    await unlink(temporaryPath)
  }
  return readToken(home, limits)
}
export async function assertToken(
  home: FileIdentity,
  token: KimiToken,
  limits: Readonly<KimiLimits>,
) {
  const current = await readToken(home, limits)
  if (
    !equal(current.identity, token.identity) ||
    current.size !== token.size ||
    current.value !== token.value
  )
    throw new KimiError('kimi_token_changed')
}
