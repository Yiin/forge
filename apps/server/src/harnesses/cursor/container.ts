import { execFile } from 'node:child_process'
import { readFile, readlink, lstat, open, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, dirname } from 'node:path'
import { NativeProcess } from '../process.js'
import {
  bootstrapEnvironment,
  nativeBootstrapOverrides,
  type CursorLaunch,
} from './launch.js'
import { CursorWire, type CursorFrame } from './wire.js'
import {
  CursorError,
  invariant,
  plainCopy,
  type CursorLimits,
  CursorResources,
  serviceGrant,
  type CursorServiceGrant,
} from './limits.js'
import { boundedRead } from './store.js'
import type { CursorOwner, CursorReservation } from './contracts.js'
import { inventoryTransaction, writeInventoryMarker } from './inventory.js'
import { boundedEntries } from './scan.js'

export type ContainerIdentity = {
  unit: string
  nonce: string
  boot: string
  host: string
  generation: string
  leaseId: string
  grant?: CursorServiceGrant
  invocation?: string
  cgroup?: string
  pid?: number
  start?: string
  supervisor?: Awaited<ReturnType<typeof processIdentity>>
  guardian?: Awaited<ReturnType<typeof processIdentity>>
  client?: Awaited<ReturnType<typeof processIdentity>>
}
export async function processIdentity(pid: number) {
  invariant(Number.isSafeInteger(pid) && pid > 0, 'cursor_container_pid')
  const raw = (await kernelRead(`/proc/${pid}/stat`, 16384)).toString('utf8')
  const stat = raw.slice(raw.lastIndexOf(')') + 2).split(' ')
  const cgroup = (await kernelRead(`/proc/${pid}/cgroup`, 16384))
    .toString('utf8')
    .trim()
    .split('\n')
    .find((line) => line.startsWith('0::'))
    ?.slice(3)
  invariant(cgroup && stat[19], 'cursor_container_identity')
  return {
    pid,
    start: stat[19],
    cgroup,
    executable: await readlink(`/proc/${pid}/exe`),
  }
}
async function kernelRead(path: string, maximum: number): Promise<Buffer> {
  const file = await open(path, 'r')
  try {
    const bytes = Buffer.alloc(maximum + 1)
    let offset = 0
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, null)
      if (!result.bytesRead) break
      offset += result.bytesRead
    }
    invariant(offset <= maximum, 'cursor_kernel_read_limit')
    return bytes.subarray(0, offset)
  } finally {
    await file.close()
  }
}
let managerWork: Promise<unknown> = Promise.resolve(),
  managerPending = 0
export function managerCall(
  args: string[],
  limits: CursorLimits,
  environment = bootstrapEnvironment(),
): Promise<string> {
  invariant(managerPending < 2, 'cursor_manager_queue_limit')
  managerPending++
  const work = managerWork.then(
    () =>
      new Promise<string>((resolve, reject) => {
        // This helper receives only fixed verbs and an already reserved unit identity.
        const helper = execFile(
          '/usr/bin/systemctl',
          ['--user', ...args],
          {
            env: environment,
            timeout: limits.helperMs,
            maxBuffer: limits.helperBytes,
            killSignal: 'SIGKILL',
          },
          (error, stdout, stderr) => {
            if (error || Buffer.byteLength(stderr) > limits.helperErrorBytes)
              reject(new CursorError('cursor_manager_unavailable'))
            else resolve(stdout)
          },
        )
        let errors = 0
        helper.stderr?.on('data', (chunk) => {
          errors += chunk.length
          if (errors > limits.helperErrorBytes) helper.kill('SIGKILL')
        })
      }),
  )
  managerWork = work.catch(() => {})
  return work.finally(() => {
    managerPending--
  })
}
const properties = [
  'Id',
  'InvocationID',
  'ControlGroup',
  'MainPID',
  'ActiveState',
  'SubState',
  'Job',
  'KillMode',
  'SendSIGKILL',
  'ExitType',
  'Restart',
  'TasksMax',
  'RuntimeMaxUSec',
]
export async function queryContainer(
  identity: ContainerIdentity,
  limits: CursorLimits,
) {
  invariant(
    /^forge-cursor-[a-f0-9-]{36}\.service$/.test(identity.unit),
    'cursor_container_unit',
  )
  const text = await managerCall(
    [
      'show',
      identity.unit,
      ...properties.map((property) => `--property=${property}`),
    ],
    limits,
  )
  return Object.fromEntries(
    text
      .trim()
      .split('\n')
      .map((line) => {
        const split = line.indexOf('=')
        return [line.slice(0, split), line.slice(split + 1)]
      }),
  )
}
export async function bindContainer(
  identity: ContainerIdentity,
  node: string,
  sidecarPid: number,
  limits: CursorLimits,
): Promise<ContainerIdentity> {
  const row = await queryContainer(identity, limits)
  const runtime = /^(\d+(?:\.\d+)?)(us|ms|s|min|h)$/.exec(
    row.RuntimeMaxUSec ?? '',
  )
  invariant(
    runtime &&
      Number(runtime[1]) *
        { us: 0.001, ms: 1, s: 1000, min: 60000, h: 3600000 }[runtime[2]]! <=
        limits.runtimeMs,
    'cursor_container_runtime_limit',
  )
  invariant(
    row.Id === identity.unit &&
      /^[a-f0-9]{32}$/.test(row.InvocationID) &&
      row.ControlGroup.startsWith('/user.slice/') &&
      Number(row.MainPID) === sidecarPid &&
      row.KillMode === 'control-group' &&
      row.SendSIGKILL === 'yes' &&
      row.ExitType === 'main' &&
      row.Restart === 'no' &&
      Number(row.TasksMax) <= limits.tasks,
    'cursor_container_properties',
  )
  const main = await processIdentity(sidecarPid)
  const guardian = await processIdentity(process.pid)
  invariant(
    main.executable === node &&
      main.cgroup === row.ControlGroup &&
      guardian.cgroup !== main.cgroup,
    'cursor_container_membership',
  )
  return {
    ...identity,
    invocation: row.InvocationID,
    cgroup: main.cgroup,
    pid: main.pid,
    start: main.start,
    guardian,
  }
}
export async function proveRetired(
  identity: ContainerIdentity,
  limits: CursorLimits,
) {
  invariant(
    identity.invocation && identity.cgroup && identity.pid && identity.start,
    'cursor_container_unverified',
  )
  const boot = (
    await readFile('/proc/sys/kernel/random/boot_id', 'utf8')
  ).trim()
  invariant(boot === identity.boot, 'cursor_container_boot_changed')
  const row = await queryContainer(identity, limits)
  invariant(
    !row.InvocationID || row.InvocationID === identity.invocation,
    'cursor_container_invocation_changed',
  )
  invariant(!row.Job || row.Job === '0', 'cursor_container_pending_job')
  const main = await processIdentity(identity.pid).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  invariant(
    !main || main.start !== identity.start,
    'cursor_container_main_live',
  )
  const root = join('/sys/fs/cgroup', identity.cgroup)
  const pending = [{ path: root, depth: 0 }]
  let directories = 0,
    tasks = 0,
    bytes = 0,
    removed = false
  while (pending.length) {
    const current = pending.pop()!
    let entries
    try {
      entries = await boundedEntries(
        current.path,
        limits.cgroupDirectories + 256,
      )
    } catch (error) {
      if (
        current.path === root &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        removed = true
        break
      }
      throw error
    }
    invariant(
      ++directories <= limits.cgroupDirectories &&
        current.depth <= limits.cgroupDepth,
      'cursor_cgroup_scan_limit',
    )
    const events = await kernelRead(
      join(current.path, 'cgroup.events'),
      Math.min(limits.cgroupBytes, 16384),
    )
    const procs = (
      await kernelRead(
        join(current.path, 'cgroup.procs'),
        Math.min(limits.cgroupBytes, limits.cgroupTasks * 12 + 1),
      )
    ).toString('utf8')
    bytes +=
      events.length + Buffer.byteLength(procs) + Buffer.byteLength(current.path)
    const pids = procs.trim() ? procs.trim().split('\n') : []
    tasks += pids.length
    invariant(
      bytes <= limits.cgroupBytes &&
        tasks <= limits.cgroupTasks &&
        pids.length === 0 &&
        /(?:^|\n)populated 0(?:\n|$)/.test(events.toString()),
      'cursor_cgroup_not_empty',
    )
    for (const entry of entries)
      if (entry.isDirectory()) {
        invariant(
          pending.length < limits.cgroupDirectories,
          'cursor_cgroup_scan_limit',
        )
        pending.push({
          path: join(current.path, entry.name),
          depth: current.depth + 1,
        })
      }
  }
  const final = await queryContainer(identity, limits)
  invariant(
    !final.InvocationID || final.InvocationID === identity.invocation,
    'cursor_container_invocation_changed',
  )
  invariant(!final.Job || final.Job === '0', 'cursor_container_pending_job')
  invariant(
    !['active', 'activating', 'reloading'].includes(final.ActiveState),
    'cursor_container_repopulated',
  )
  if (removed)
    invariant(
      await lstat(root).then(
        () => false,
        (error) => {
          if (error.code === 'ENOENT') return true
          throw error
        },
      ),
      'cursor_container_repopulated',
    )
  return { kind: removed ? ('removed' as const) : ('empty' as const) }
}
export async function retireContainer(
  identity: ContainerIdentity,
  limits: CursorLimits,
) {
  invariant(
    identity.invocation && identity.cgroup,
    'cursor_container_unverified',
  )
  invariant(
    identity.boot ===
      (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() &&
      identity.host === (await readFile('/etc/machine-id', 'utf8')).trim(),
    'cursor_container_boot_changed',
  )
  const row = await queryContainer(identity, limits)
  invariant(
    !row.InvocationID || row.InvocationID === identity.invocation,
    'cursor_container_invocation_changed',
  )
  if (row.InvocationID) {
    invariant(
      row.ControlGroup === identity.cgroup,
      'cursor_container_cgroup_changed',
    )
    const main = identity.pid
      ? await processIdentity(identity.pid).catch((error) => {
          if (error.code === 'ENOENT') return null
          throw error
        })
      : null
    invariant(
      !main ||
        (main.start === identity.start && main.cgroup === identity.cgroup),
      'cursor_container_start_changed',
    )
    await managerCall(['stop', identity.unit], limits)
  }
  return proveRetired(identity, limits)
}
/** Explicit recovery only. Ordinary load never calls this function. */
export async function retireRecordedContainer(
  identity: ContainerIdentity,
  limits: CursorLimits,
) {
  invariant(
    identity.supervisor &&
      identity.guardian &&
      identity.client &&
      identity.invocation &&
      identity.cgroup,
    'cursor_recovery_identity_incomplete',
  )
  const host = (await readFile('/etc/machine-id', 'utf8')).trim(),
    boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
  invariant(identity.host === host, 'cursor_recovery_host')
  if (identity.boot !== boot) {
    const row = await queryContainer(identity, limits)
    invariant(
      !row.InvocationID && (!row.Job || row.Job === '0'),
      'cursor_recovery_new_boot_conflict',
    )
    invariant(
      await lstat(join('/sys/fs/cgroup', identity.cgroup)).then(
        () => false,
        (error) => {
          if (error.code === 'ENOENT') return true
          throw error
        },
      ),
      'cursor_recovery_new_boot_conflict',
    )
    return {
      kind: 'prior-boot' as const,
      previousBoot: identity.boot,
      currentBoot: boot,
      pipesClosed: true,
    }
  }
  const absent = async (record: NonNullable<ContainerIdentity['guardian']>) => {
    const current = await processIdentity(record.pid).catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    return !current || current.start !== record.start
  }
  invariant(
    (await absent(identity.supervisor)) && (await absent(identity.guardian)),
    'cursor_recovery_owner_live',
  )
  const proof = await retireContainer(identity, limits)
  const deadline = performance.now() + limits.helperMs
  while (!(await absent(identity.client))) {
    invariant(performance.now() < deadline, 'cursor_recovery_pipes_live')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return { ...proof, pipesClosed: true }
}
export class CursorContainer {
  process?: NativeProcess
  wire?: CursorWire
  identity?: ContainerIdentity
  private closing?: Promise<void>
  private closed = false
  private release?: () => void
  private fence: string
  constructor(
    readonly launch: CursorLaunch,
    readonly owner: CursorOwner,
    readonly sdkDirectory: string,
    private readonly resources: CursorResources,
    readonly limits: CursorLimits,
    readonly onFrame: (frame: CursorFrame) => void,
    readonly reservation?: CursorReservation,
    readonly discovery = false,
    readonly onFailure?: (error: Error) => void,
  ) {
    this.fence = join(dirname(sdkDirectory), 'writer-fence.json')
  }
  async start() {
    invariant(
      !this.process && !this.identity,
      'cursor_container_already_started',
    )
    await inventoryTransaction(
      this.resources,
      this.launch.stateRoot,
      this.limits,
      async (inventory) => {
        this.release = this.resources.reserveContainer(this.fence, this.limits)
        // Reserve each service's full store capacity in the shared parent pool before spawning it.
        // This keeps independent Node stores within the server ceilings without a second IPC scheduler.
        this.identity = {
          unit: `forge-cursor-${randomUUID()}.service`,
          nonce: randomUUID(),
          generation: this.owner.generation,
          leaseId: randomUUID(),
          grant: serviceGrant(this.limits),
          boot: (
            await readFile('/proc/sys/kernel/random/boot_id', 'utf8')
          ).trim(),
          host: (await readFile('/etc/machine-id', 'utf8')).trim(),
          supervisor: await processIdentity(process.pid),
        }
        await writeInventoryMarker(
          this.fence,
          { state: 'dirty', identity: this.identity, owner: this.owner },
          inventory,
          this.limits,
          true,
        )
      },
    )
    const environment = nativeBootstrapOverrides(process.env)
    const started = await NativeProcess.start(
      {
        command: this.launch.node,
        args: [
          ...this.launch.args,
          this.launch.guardian,
          this.owner.generation,
        ],
        cwd: this.owner.cwd,
        env: environment,
        secrets:
          this.launch.selected.credential.type === 'api-key'
            ? [this.launch.selected.credential.apiKey]
            : [],
        startupTimeoutMs: this.limits.startupMs,
        cleanupTimeoutMs: 5000,
      },
      async (process) => {
        this.process = process
        this.wire = new CursorWire(
          process.child.stdin,
          process.child.stdout,
          this.owner.generation,
          this.limits,
          this.onFrame,
        )
        process.ownTransport(this.wire.transport)
        void this.wire.transport.done.then(() => {
          if (!this.closing)
            this.onFailure?.(new CursorError('cursor_process_lost'))
        })
        const created = await this.wire.request('initialize', {
          identity: this.identity,
          node: this.launch.node,
          args: this.launch.args,
          entry: this.launch.entry,
          cwd: this.owner.cwd,
          fence: this.fence,
          stateRoot: this.launch.stateRoot,
          limits: this.limits,
          removed: Object.keys(this.launch.environment).filter(
            (key) => this.launch.environment[key] === undefined,
          ),
        })
        this.identity = plainCopy(
          created.identity,
          this.limits.markerBytes,
        ) as ContainerIdentity
        const disk = JSON.parse(
          (
            await boundedRead(this.fence, this.limits.markerBytes, true)
          ).toString('utf8'),
        )
        invariant(
          JSON.stringify(disk.identity) === JSON.stringify(this.identity),
          'cursor_container_fence',
        )
        const environment = {
          ...this.launch.environment,
          CURSOR_DATA_DIR: join(dirname(this.sdkDirectory), 'native-data'),
        }
        return this.wire.request('container_bound', {
          nonce: this.identity.nonce,
          identity: this.identity,
          environment,
          selected: this.launch.selected,
          directory: this.sdkDirectory,
          owner: this.owner,
          reservation: this.reservation,
          discovery: this.discovery,
          limits: this.limits,
        })
      },
    )
    return started.value
  }
  close(): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (this.closing) return this.closing
    this.closing = (async () => {
      let retirement: string | undefined, direct: string | undefined
      let reply: string | undefined
      const code = (error: unknown) =>
        error instanceof CursorError
          ? error.code.slice(0, 256)
          : 'cursor_cleanup_operation_failed'
      try {
        invariant(
          this.wire && this.identity,
          'cursor_retirement_identity_missing',
        )
        await this.wire
          .request('close', {}, this.limits.cancellationMs)
          .catch(() => {})
        const retired = await this.wire.request(
          'retire',
          {},
          this.limits.helperMs + this.limits.cancellationMs,
        )
        invariant(retired.type === 'retired', 'cursor_retirement_reply_invalid')
      } catch (error) {
        reply = code(error)
      }
      // Retirement can fail before its reply. Direct cleanup still owns the
      // guardian process and all three pipes, and must always run.
      try {
        invariant(this.process, 'cursor_direct_process_missing')
        await this.process.close()
      } catch (error) {
        direct = code(error)
      }
      try {
        invariant(this.identity, 'cursor_retirement_identity_missing')
        const receipt = JSON.parse(
          (
            await boundedRead(
              `${this.fence}.retired`,
              this.limits.markerBytes,
              true,
            )
          ).toString('utf8'),
        )
        invariant(
          JSON.stringify(receipt.identity) === JSON.stringify(this.identity),
          'cursor_retirement_identity_mismatch',
        )
        invariant(
          receipt.pipesClosed === true,
          'cursor_retirement_pipes_unproved',
        )
        invariant(
          ['removed', 'empty'].includes(receipt.proof?.kind),
          'cursor_retirement_service_unproved',
        )
      } catch (error) {
        retirement = code(error)
      }
      if (retirement || direct)
        throw new CursorCleanupError({ retirement, direct, reply })
      await unlink(this.fence)
      const folder = await open(dirname(this.fence), 'r')
      try {
        await folder.sync()
      } finally {
        await folder.close()
      }
      this.release?.()
      this.wire?.releaseAfterRetirement()
      this.closed = true
    })().catch((error) => {
      this.closing = undefined
      if (error instanceof CursorCleanupError) throw error
      throw new CursorCleanupError({
        retirement:
          error instanceof CursorError
            ? error.code.slice(0, 256)
            : 'cursor_cleanup_fence_failed',
      })
    })
    return this.closing
  }
}

export class CursorCleanupError extends CursorError {
  readonly failures: Readonly<{
    retirement?: string
    direct?: string
    reply?: string
  }>
  constructor(failures: {
    retirement?: string
    direct?: string
    reply?: string
  }) {
    super('cursor_cleanup_failed')
    this.failures = Object.freeze({ ...failures })
  }
}
