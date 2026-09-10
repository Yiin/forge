import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import { barrier, fixture, until } from './fixtures.js'
import { WORKSPACE_LIMITS } from './limits.js'
import { gitStatus } from '../git/repo.js'
import type { WorkspaceFiles } from './files.js'
import type { Subscription } from './watch.js'

function watchRoot(service: WorkspaceFiles) {
  return [
    ...(
      service.watches as unknown as {
        roots: Map<
          string,
          {
            mode: string
            directories: Map<string, unknown>
            initialized: boolean
            refresh?: Promise<void>
            debounce?: ReturnType<typeof setTimeout>
            burst?: ReturnType<typeof setTimeout>
          }
        >
      }
    ).roots.values(),
  ][0]!
}

describe('final workspace review regressions', () => {
  it('publishes all bytes after several controlled writes', async () => {
    const f = await fixture(false, {
      writeTemporary: async (write) => {
        await write(2)
        await write()
      },
    })
    expect((await f.save(await f.input('submitted\n'))).status).toBe(200)
    expect(await readFile(join(f.root, 'file.txt'), 'utf8')).toBe('submitted\n')
    expect(
      (await readdir(f.root)).filter((name) => name.startsWith('.forge-save-')),
    ).toEqual([])
  })
  it('cleans a verified partial write when cancelled', async () => {
    const gate = barrier()
    const f = await fixture(false, {
      writeTemporary: async (write) => {
        await write(2)
        await gate.hook()
      },
    })
    const controller = new AbortController()
    const saving = f.service
      .save(await f.input('submitted\n'), controller.signal)
      .catch((error) => error)
    await gate.reached
    try {
      controller.abort()
    } finally {
      gate.release()
    }
    expect(await saving).toMatchObject({ status: 503, code: 'interrupted' })
    expect(await readFile(join(f.root, 'file.txt'), 'utf8')).toBe('original\n')
    expect(
      (await readdir(f.root)).filter((name) => name.startsWith('.forge-save-')),
    ).toEqual([])
    expect(f.service.diagnostics).toMatchObject({
      operations: 0,
      fileQueues: 0,
      mutationQueues: 0,
    })
  })
  it.each([
    'change',
    'replacement',
    'change and failure',
    'replacement and failure',
  ])('preserves temporary bytes after %s during flush', async (kind) => {
    const gate = barrier()
    const f = await fixture(true, {
      flushTemporary: async (handle) => {
        await handle.sync()
        await gate.hook()
        if (kind.endsWith('failure')) throw new Error('Flush failed')
      },
    })
    const saving = f.save(await f.input('submitted\n'))
    await gate.reached
    let temporary = ''
    try {
      temporary = join(
        f.root,
        (await readdir(f.root)).find((name) =>
          name.startsWith('.forge-save-'),
        )!,
      )
      if (kind.startsWith('replacement'))
        await rename(temporary, join(f.dir, 'displaced'))
      await writeFile(temporary, 'external before staged snapshot\n')
    } finally {
      gate.release()
    }
    const response = await saving
    expect(response.status).toBe(kind.endsWith('failure') ? 503 : 409)
    expect((await response.json()).error).toBe(
      kind.endsWith('failure') ? 'unavailable' : 'conflict',
    )
    expect(await readFile(join(f.root, 'file.txt'), 'utf8')).toBe('original\n')
    expect(await readFile(temporary, 'utf8')).toBe(
      'external before staged snapshot\n',
    )
    expect(
      (await gitStatus(f.root, f.service.targets.temporaryPaths)).dirty,
    ).toBe(true)
    expect(f.service.targets.temporaryPaths.size).toBe(0)
  })
  it.each(['external partial bytes\n', 's'])(
    'preserves changed partial bytes %j after a write failure',
    async (external) => {
      const gate = barrier()
      const f = await fixture(false, {
        writeTemporary: async (write) => {
          await write(2)
          await gate.hook()
          throw new Error('Partial write failed')
        },
      })
      const saving = f.save(await f.input('submitted\n'))
      await gate.reached
      let temporary = ''
      try {
        temporary = join(
          f.root,
          (await readdir(f.root)).find((name) =>
            name.startsWith('.forge-save-'),
          )!,
        )
        await writeFile(temporary, external)
      } finally {
        gate.release()
      }
      expect((await saving).status).toBe(503)
      expect(await readFile(temporary, 'utf8')).toBe(external)
      expect(await readFile(join(f.root, 'file.txt'), 'utf8')).toBe(
        'original\n',
      )
    },
  )
  it('retains incomplete coverage after unrelated parent repair and recovers readable subtrees', async () => {
    const f = await fixture()
    await mkdir(join(f.root, 'early'))
    const sub = await f.service.watches.subscribe(f.target)
    const root = watchRoot(f.service)
    const events = vi.spyOn(sub, 'push')
    try {
      expect((await sub.next())!.mode).toBe('native')
      // Move an already unreadable subtree under the watched root in one operation.
      await mkdir(join(f.dir, 'denied/child'), { recursive: true })
      await chmod(join(f.dir, 'denied'), 0o333)
      await rename(join(f.dir, 'denied'), join(f.root, 'denied'))
      await until(
        () =>
          events.mock.calls.some(
            (call) => call[1] && call[2] === 'repair_only',
          ),
        Boolean,
      )
      await until(() => !root.refresh, Boolean)
      expect(root.directories.has('denied/child')).toBe(false)
      events.mockClear()
      await writeFile(join(f.root, 'early/newfile'), 'parent refresh')
      await until(
        () =>
          events.mock.calls.some((call) => call[0].includes('early/newfile')),
        Boolean,
      )
      await until(() => !root.refresh, Boolean)
      expect(root.mode).toBe('repair_only')
      events.mockClear()
      await writeFile(join(f.root, 'denied/child/unseen'), 'unwatched')
      await delay(200)
      expect(
        events.mock.calls.some((call) =>
          call[0].includes('denied/child/unseen'),
        ),
      ).toBe(false)
      expect(root.mode).toBe('repair_only')
      await chmod(join(f.root, 'denied'), 0o755)
      await until(
        () => root.mode === 'native' && root.directories.has('denied/child'),
        Boolean,
      )
      await writeFile(join(f.root, 'denied/child/recovered'), 'watched')
      await until(
        () =>
          events.mock.calls.some((call) =>
            call[0].includes('denied/child/recovered'),
          ),
        Boolean,
      )
      expect(f.service.diagnostics.watchDirectories).toBe(4)
    } finally {
      events.mockRestore()
      sub.close()
      await chmod(join(f.root, 'denied'), 0o755).catch(() => {})
      await chmod(join(f.dir, 'denied'), 0o755).catch(() => {})
    }
  })
  it('flushes continuous content events within the burst bound after slow initialization', async () => {
    const gate = barrier()
    const f = await fixture(false, {
      beforeWatchDirectory: async (path) => {
        if (path === 'late') await gate.hook()
      },
    })
    await mkdir(join(f.root, 'late'))
    const pending = f.service.watches.subscribe(f.target)
    let sub: Subscription | undefined
    try {
      await gate.reached
      await writeFile(join(f.root, 'file.txt'), 'during initialization')
      await delay(WORKSPACE_LIMITS.burstMs + 150)
      gate.release()
      sub = await pending
      expect((await sub.next())!.resyncRequired).toBe(true)
      const events = vi.spyOn(sub, 'push')
      const start = performance.now()
      let first = Infinity
      while (performance.now() - start < WORKSPACE_LIMITS.burstMs + 400) {
        await writeFile(
          join(f.root, 'file.txt'),
          `continuous ${performance.now()}`,
        )
        if (
          first === Infinity &&
          events.mock.calls.some((call) => call[0].includes('file.txt'))
        )
          first = performance.now() - start
        await delay(40)
      }
      expect(first).toBeLessThan(WORKSPACE_LIMITS.burstMs + 200)
      expect(watchRoot(f.service).mode).toBe('native')
    } finally {
      gate.release()
      sub = await pending
      sub.close()
    }
  })
  it('releases notification timers when closed during initialization', async () => {
    const gate = barrier()
    const f = await fixture(false, {
      beforeWatchDirectory: async (path) => {
        if (path === 'late') await gate.hook()
      },
    })
    await mkdir(join(f.root, 'late'))
    const pending = f.service.watches.subscribe(f.target)
    await gate.reached
    const root = watchRoot(f.service)
    let closing: Promise<void> | undefined
    try {
      await writeFile(join(f.root, 'file.txt'), 'during initialization')
      await until(() => !!root.debounce && !!root.burst, Boolean)
      closing = f.service.close()
    } finally {
      gate.release()
      ;(await pending).close()
      await closing
    }
    expect(root.debounce).toBeUndefined()
    expect(root.burst).toBeUndefined()
    expect(f.service.diagnostics).toMatchObject({
      operations: 0,
      watchRoots: 0,
      watchDirectories: 0,
      subscribers: 0,
      watchTasks: 0,
    })
  })
})
