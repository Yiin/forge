import { Dir } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { readProcNames } from './proc-names.js'
import { groupHasRunningMember } from './process-group.js'
import { ownedListener } from './kimi/listener.js'

const io = vi.hoisted(() => ({
  opendir: vi.fn(),
  open: vi.fn(),
  readlink: vi.fn(),
}))
vi.mock('node:fs/promises', async (load) => ({
  ...(await load<typeof import('node:fs/promises')>()),
  ...io,
}))
afterEach(() => {
  vi.resetAllMocks()
  vi.useRealTimers()
})
const options = {
  maximum: 20,
  check() {},
  limitError: () => new Error('scan limit'),
}
function directory(
  batches: Array<Array<string | number> | null>,
  path = '/proc',
) {
  const close = vi.fn((request?: { oncomplete: (error: null) => void }) => {
    if (request) queueMicrotask(() => request.oncomplete(null))
  })
  const handle = {
    read(
      _encoding: unknown,
      _size: unknown,
      request: { oncomplete: (error: null, result: unknown) => void },
    ) {
      queueMicrotask(() => request.oncomplete(null, batches.shift() ?? null))
    },
    close,
  }
  // Use Node's real Dirent conversion, including its DT_UNKNOWN lstat fallback.
  const value = new (
    Dir as unknown as new (handle: object, path: string, options: object) => Dir
  )(handle, path, { bufferSize: 32 })
  return { value, close }
}
function statFile(value: string) {
  return {
    read: vi.fn(async (buffer: Buffer) => ({ bytesRead: buffer.write(value) })),
    close: vi.fn(async () => {}),
  }
}

it('restarts Node directory conversion after a disappearing entry without losing its live suffix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forge-dirent-proof-'))
  try {
    const proof = directory([['123', 0, '456', 2], null], root)
    const error = await proof.value
      .read()
      .catch((error: NodeJS.ErrnoException) => error)
    expect(error).toMatchObject({
      code: 'ENOENT',
      syscall: 'lstat',
      path: join(root, '123'),
    })
    expect((error as Error).stack).toContain('getDirent')
    expect((error as Error).stack).toContain('Dir.processReadResult')
    expect(await proof.value.read()).toBeNull()
    await proof.value.close()

    const first = directory([['123', 0, '456', 2], null], root)
    const restarted = directory([['456', 2], null], root)
    io.opendir
      .mockResolvedValueOnce(first.value)
      .mockResolvedValueOnce(restarted.value)
    const member = statFile('456 (owned child) S 1 900 0')
    io.open.mockImplementation(async (path) => {
      expect(path).toBe('/proc/456/stat')
      return member
    })
    expect(await groupHasRunningMember(900, performance.now() + 1000)).toBe(
      true,
    )
    expect(io.opendir).toHaveBeenCalledTimes(2)
    expect(first.close).toHaveBeenCalledTimes(1)
    expect(restarted.close).toHaveBeenCalledTimes(1)
    expect(member.close).toHaveBeenCalledTimes(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('counts partial listings and failed reads against one cap across retries', async () => {
  const close = vi.fn(async () => {})
  io.opendir.mockImplementation(async () => ({
    read: vi
      .fn()
      .mockResolvedValueOnce({ name: '456' })
      .mockRejectedValueOnce(
        Object.assign(new Error('gone'), { code: 'ENOENT' }),
      ),
    close,
  }))
  await expect(
    readProcNames('/proc', { ...options, maximum: 3 }),
  ).rejects.toThrow('scan limit')
  expect(io.opendir).toHaveBeenCalledTimes(2)
  expect(close).toHaveBeenCalledTimes(2)
})

it('keeps permission failures instead of treating them as a complete scan', async () => {
  const error = Object.assign(new Error('permission'), { code: 'EACCES' })
  const close = vi.fn(async () => {})
  io.opendir.mockResolvedValue({
    read: vi.fn().mockRejectedValue(error),
    close,
  })
  await expect(readProcNames('/proc', options)).rejects.toBe(error)
  expect(io.opendir).toHaveBeenCalledTimes(1)
  expect(close).toHaveBeenCalledTimes(1)
})

it('closes a late directory without reading after the original cleanup deadline expires', async () => {
  vi.useFakeTimers()
  let opened!: (directory: unknown) => void
  io.opendir.mockImplementation(
    () =>
      new Promise((resolve) => {
        opened = resolve
      }),
  )
  const result = groupHasRunningMember(900, performance.now() + 20).catch(
    (error: Error) => error,
  )
  await vi.advanceTimersByTimeAsync(20)
  expect(await result).toMatchObject({
    message: 'Native process cleanup timed out',
  })
  const read = vi.fn(),
    close = vi.fn(async () => {})
  opened({ read, close })
  await vi.advanceTimersByTimeAsync(0)
  expect(read).not.toHaveBeenCalled()
  expect(close).toHaveBeenCalledTimes(1)
})

it.each([false, true])(
  'does not grant listener ownership from a lost descriptor listing: disappears=%s',
  async (disappears) => {
    const proc = directory([['456', 2], null])
    const close = vi.fn(async () => {})
    io.opendir.mockImplementation(async (path) => {
      if (path === '/proc') return proc.value
      expect(path).toBe('/proc/456/fd')
      if (disappears) throw Object.assign(new Error('gone'), { code: 'ENOENT' })
      if (io.opendir.mock.calls.length === 2)
        return {
          read: vi
            .fn()
            .mockRejectedValueOnce(
              Object.assign(new Error('gone'), { code: 'ENOENT' }),
            ),
          close,
        }
      return directory([['4', 3], null]).value
    })
    io.open.mockImplementation(async (path) => {
      const value =
        path === '/proc/net/tcp'
          ? 'header\n0: 0100007F:0FA0 00000000:0000 0A 0 0 0 0 0 55\n'
          : '456 (owned child) S 1 900 0'
      let offset = 0
      const file = statFile(value)
      file.read.mockImplementation(async (buffer: Buffer) => {
        const bytesRead = offset ? 0 : buffer.write(value)
        offset += bytesRead
        return { bytesRead }
      })
      return file
    })
    io.readlink.mockResolvedValue('socket:[55]')
    const result = ownedListener(4000, 900, performance.now() + 1000)
    if (disappears) {
      await expect(result).rejects.toMatchObject({
        code: 'kimi_foreign_listener',
      })
      expect(io.readlink).not.toHaveBeenCalled()
    } else {
      expect(await result).toBe(true)
      expect(close).toHaveBeenCalledTimes(1)
      expect(io.readlink).toHaveBeenCalledWith('/proc/456/fd/4')
    }
  },
)
