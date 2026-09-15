import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { retireContainer, type ContainerIdentity } from './container.js'
import { cursorLimits } from './limits.js'

const io = vi.hoisted(() => ({
  execFile: vi.fn(),
  open: vi.fn(),
  readFile: vi.fn(),
  lstat: vi.fn(),
  entries: vi.fn(),
}))
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile: io.execFile,
}))
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  open: io.open,
  readFile: io.readFile,
  lstat: io.lstat,
}))
vi.mock('./scan.js', () => ({ boundedEntries: io.entries }))
afterEach(() => vi.resetAllMocks())

const identity: ContainerIdentity = {
  unit: 'forge-cursor-11111111-1111-1111-1111-111111111111.service',
  nonce: 'nonce',
  generation: 'generation',
  leaseId: 'lease',
  boot: 'boot',
  host: 'host',
  invocation: 'original-invocation',
  cgroup: '/user.slice/original.service',
  pid: 42,
  start: 'original-start',
}
const root = `/sys/fs/cgroup${identity.cgroup}`
function missing() {
  return Object.assign(new Error('synthetic missing kernel entry'), {
    code: 'ENOENT',
  })
}
function setup(rows: Record<string, string>[] = []) {
  const defaultRow = {
    InvocationID: identity.invocation!,
    ControlGroup: '',
    MainPID: '0',
    ActiveState: 'failed',
    SubState: 'failed',
    Job: '',
  }
  io.execFile.mockImplementation((_command, args, _options, callback) => {
    expect(args[0]).toBe('--user')
    expect(args[1]).toBe('show')
    expect(args[2]).toBe(identity.unit)
    const row = { ...defaultRow, ...rows.shift() }
    queueMicrotask(() =>
      callback(
        null,
        Object.entries(row)
          .map(([key, value]) => `${key}=${value}`)
          .join('\n'),
        '',
      ),
    )
    return { stderr: new EventEmitter() }
  })
  io.readFile.mockImplementation(async (path) => {
    if (path === '/proc/sys/kernel/random/boot_id') return 'boot'
    if (path === '/etc/machine-id') return 'host'
    throw Error('unexpected identity read')
  })
  io.open.mockImplementation(async (path) => {
    expect(path).toBe('/proc/42/stat')
    throw missing()
  })
  io.entries.mockImplementation(async (path) => {
    expect(path).toBe(root)
    throw missing()
  })
  io.lstat.mockImplementation(async (path) => {
    expect(path).toBe(root)
    throw missing()
  })
}

it('proves the original path removed when systemd retains invocation but clears ControlGroup', async () => {
  setup()
  await expect(retireContainer(identity, cursorLimits())).resolves.toEqual({
    kind: 'removed',
  })
  expect(io.execFile).toHaveBeenCalledTimes(3)
  expect(io.entries).toHaveBeenCalledOnce()
  expect(io.lstat).toHaveBeenCalledOnce()
})

it.each([
  [
    { ControlGroup: '/user.slice/replaced.service' },
    'cursor_container_cgroup_changed',
  ],
  [{ InvocationID: 'replacement' }, 'cursor_container_invocation_changed'],
])(
  'refuses changed ownership before any stop or kernel proof: %j',
  async (row, code) => {
    setup([row])
    await expect(retireContainer(identity, cursorLimits())).rejects.toThrow(
      code,
    )
    expect(io.execFile).toHaveBeenCalledOnce()
    expect(io.open).not.toHaveBeenCalled()
    expect(io.entries).not.toHaveBeenCalled()
  },
)

it.each([
  [{ InvocationID: 'replacement' }, 'cursor_container_invocation_changed'],
  [{ ActiveState: 'active' }, 'cursor_container_repopulated'],
  [{ Job: '123' }, 'cursor_container_pending_job'],
])(
  'requires final manager proof after original path inspection: %j',
  async (row, code) => {
    setup([{}, {}, row])
    await expect(retireContainer(identity, cursorLimits())).rejects.toThrow(
      code,
    )
    expect(io.entries).toHaveBeenCalledOnce()
    expect(io.execFile).toHaveBeenCalledTimes(3)
  },
)

it('refuses an original cgroup that still contains tasks despite an empty manager ControlGroup', async () => {
  setup()
  io.entries.mockResolvedValue([])
  io.open.mockImplementation(async (path) => {
    if (path === '/proc/42/stat') throw missing()
    const value = path === `${root}/cgroup.events` ? 'populated 1\n' : '43\n'
    expect([`${root}/cgroup.events`, `${root}/cgroup.procs`]).toContain(path)
    let read = false
    return {
      read: async (buffer: Buffer, offset: number) => {
        if (read) return { bytesRead: 0 }
        read = true
        return { bytesRead: buffer.write(value, offset) }
      },
      close: vi.fn(async () => {}),
    }
  })
  await expect(retireContainer(identity, cursorLimits())).rejects.toThrow(
    'cursor_cgroup_not_empty',
  )
  expect(io.execFile).toHaveBeenCalledTimes(2)
  expect(io.lstat).not.toHaveBeenCalled()
})

it('does not report retirement while original path proof is held', async () => {
  setup()
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  io.entries.mockImplementation(async (path) => {
    expect(path).toBe(root)
    entered()
    await held
    throw missing()
  })
  let settled = false
  const result = retireContainer(identity, cursorLimits()).finally(() => {
    settled = true
  })
  try {
    await started
    expect(settled).toBe(false)
    expect(io.lstat).not.toHaveBeenCalled()
  } finally {
    release()
  }
  await expect(result).resolves.toEqual({ kind: 'removed' })
  expect(io.lstat).toHaveBeenCalledOnce()
})
