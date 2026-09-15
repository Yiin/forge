import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { identity, WorkspacePath } from './paths.js'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
afterEach(async () => {
  vi.restoreAllMocks()
  vi.mocked(fs.open).mockReset()
  vi.mocked(fs.open).mockImplementation(
    (
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      )
    ).open,
  )
})

test('path cleanup closes independent handles and retries only the failed original', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'forge-path-close-'))
  await fs.mkdir(join(root, 'child'))
  let chain: WorkspacePath | undefined
  let rootHandle: fs.FileHandle | undefined
  let rootClose: ReturnType<typeof vi.spyOn> | undefined
  try {
    chain = await WorkspacePath.open(
      root,
      identity(await fs.lstat(root, { bigint: true })),
      'child',
      true,
      undefined,
      {
        onCreated(value) {
          chain = value
        },
        async beforeDirectoryOpen() {
          rootHandle = chain!.parent
          const original = rootHandle.close.bind(rootHandle)
          rootClose = vi
            .spyOn(rootHandle, 'close')
            .mockRejectedValueOnce(Error('held root close'))
            .mockImplementation(original)
        },
      },
    )
    const childClose = vi.spyOn(chain.parent, 'close')
    await expect(chain.close()).rejects.toThrow('held root close')
    expect(childClose).toHaveBeenCalledTimes(1)
    expect(rootHandle!.fd).toBeGreaterThanOrEqual(0)
    await chain.close()
    expect(rootClose).toHaveBeenCalledTimes(2)
    expect(childClose).toHaveBeenCalledTimes(1)
    expect(rootHandle!.fd).toBe(-1)
  } finally {
    await chain?.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('an aborted late root open records and closes its handle without inspecting it', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'forge-path-late-'))
  const rootIdentity = identity(await fs.lstat(root, { bigint: true }))
  const controller = new AbortController()
  const opened = deferred<fs.FileHandle>(),
    release = deferred<void>()
  const originalOpen = (
    await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  ).open
  const openSpy = vi.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await originalOpen(...args)
    opened.resolve(handle)
    await release.promise
    return handle
  })
  let chain: WorkspacePath | undefined
  try {
    const pending = WorkspacePath.open(
      root,
      rootIdentity,
      '',
      true,
      controller.signal,
      {
        onCreated(value) {
          chain = value
        },
      },
    )
    const rejected = expect(pending).rejects.toThrow()
    const handle = await opened.promise
    expect(chain).toBeDefined()
    const inspect = vi.spyOn(handle, 'stat')
    controller.abort()
    release.resolve()
    await rejected
    expect(inspect).not.toHaveBeenCalled()
    expect(handle.fd).toBe(-1)
    expect(openSpy).toHaveBeenCalledTimes(1)
  } finally {
    release.resolve()
    await chain?.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('abort during a directory hook prevents its later native open', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'forge-path-hook-'))
  await fs.mkdir(join(root, 'child'))
  const controller = new AbortController()
  const held = deferred<void>(),
    arrived = deferred<void>()
  let chain: WorkspacePath | undefined
  try {
    const pending = WorkspacePath.open(
      root,
      identity(await fs.lstat(root, { bigint: true })),
      'child',
      true,
      controller.signal,
      {
        onCreated(value) {
          chain = value
        },
        async beforeDirectoryOpen() {
          arrived.resolve()
          await held.promise
        },
      },
    )
    const rejected = expect(pending).rejects.toThrow()
    await arrived.promise
    const rootHandle = chain!.parent
    const nativeOpen = vi.mocked(fs.open).mockClear()
    controller.abort()
    held.resolve()
    await rejected
    expect(nativeOpen).not.toHaveBeenCalled()
    expect(rootHandle.fd).toBe(-1)
  } finally {
    held.resolve()
    await chain?.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('cleanup drains an aborted child open while the original root close is held', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'forge-path-drain-'))
  await fs.mkdir(join(root, 'child'))
  const controller = new AbortController()
  const childOpened = deferred<fs.FileHandle>()
  const releaseChild = deferred<void>()
  const rootClosing = deferred<void>()
  const releaseRoot = deferred<void>()
  const originalOpen = (
    await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  ).open
  let chain: WorkspacePath | undefined
  let rootHandle: fs.FileHandle | undefined
  let calls = 0
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await originalOpen(...args)
    if (++calls === 2) {
      childOpened.resolve(handle)
      await releaseChild.promise
    }
    return handle
  })
  try {
    const pending = WorkspacePath.open(
      root,
      identity(await fs.lstat(root, { bigint: true })),
      'child',
      true,
      controller.signal,
      {
        onCreated(value) {
          chain = value
        },
        async beforeDirectoryOpen() {
          rootHandle = chain!.parent
          const originalClose = rootHandle.close.bind(rootHandle)
          vi.spyOn(rootHandle, 'close').mockImplementation(async () => {
            rootClosing.resolve()
            await releaseRoot.promise
            await originalClose()
          })
        },
      },
    )
    const rejected = expect(pending).rejects.toThrow()
    const child = await childOpened.promise
    const childClose = vi.spyOn(child, 'close')
    controller.abort()
    let settled = false
    const closing = chain!.close().then(() => {
      settled = true
    })
    await rootClosing.promise
    releaseChild.resolve()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
    expect(child.fd).toBeGreaterThanOrEqual(0)
    releaseRoot.resolve()
    await Promise.all([closing, rejected])
    expect(rootHandle!.fd).toBe(-1)
    expect(child.fd).toBe(-1)
    expect(childClose).toHaveBeenCalledTimes(1)
  } finally {
    releaseChild.resolve()
    releaseRoot.resolve()
    await chain?.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})
