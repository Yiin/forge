import {
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import { fixture, barrier, until } from './fixtures.js'
import { KeyedQueue } from '../keyed-queue.js'
import { WorkspacePath } from './paths.js'
import { createSession } from '../db/queries.js'
import { gitStatus, listRefs } from '../git/repo.js'
import { listWorktrees } from '../git/worktrees.js'
import { gitRoutes } from '../http/git.js'
import { runGit } from '../git/exec.js'
import * as git from '../git/exec.js'

const within = async <T>(task: Promise<T>, ms = 300) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Operation did not settle promptly')),
          ms,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

describe('workspace review regressions', () => {
  it.each(['replacement', 'changed', 'replacement and target changed'])(
    'preserves external temporary entry after %s before publication',
    async (change) => {
      const gate = barrier()
      const f = await fixture(true, { staged: gate.hook })
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
        if (change.startsWith('replacement')) {
          await rename(temporary, join(f.dir, 'displaced'))
        }
        await writeFile(temporary, 'unrelated replacement\n')
        if (change.endsWith('target changed'))
          await writeFile(join(f.root, 'file.txt'), 'external target\n')
        expect(
          (await gitStatus(f.root, f.service.targets.temporaryPaths)).dirty,
        ).toBe(true)
      } finally {
        gate.release()
      }
      expect((await saving).status).toBe(409)
      expect(await readFile(temporary, 'utf8')).toBe('unrelated replacement\n')
      expect(await readFile(join(f.root, 'file.txt'), 'utf8')).toBe(
        change.endsWith('target changed') ? 'external target\n' : 'original\n',
      )
      expect(f.service.targets.temporaryPaths.size).toBe(0)
    },
  )
  it('cancels the middle queue waiter without allowing the third to overtake', async () => {
    const queue = new KeyedQueue()
    const gate = barrier()
    const first = queue.run('same', gate.hook)
    await gate.reached
    const controller = new AbortController()
    let secondCalled = false,
      thirdCalled = false
    const second = queue
      .run(
        'same',
        async () => {
          secondCalled = true
        },
        controller.signal,
      )
      .catch((error) => error)
    const third = queue.run('same', async () => {
      thirdCalled = true
    })
    try {
      controller.abort(new Error('cancelled'))
      expect(await within(second)).toMatchObject({ message: 'cancelled' })
      expect(secondCalled).toBe(false)
      expect(thirdCalled).toBe(false)
      expect(queue.size).toBe(1)
    } finally {
      gate.release()
      await Promise.all([first, second, third])
    }
    expect(thirdCalled).toBe(true)
    expect(queue.size).toBe(0)
  })
  it('shares eight admission leases across mutations and files before queue insertion', async () => {
    const f = await fixture()
    const workspace = await f.service.targets.resolve(f.target)
    const gate = barrier()
    const holder = f.service.targets.mutations.run(workspace.gateKey, gate.hook)
    await gate.reached
    const controller = new AbortController()
    let calls = 0
    const pending = Array.from({ length: 8 }, () =>
      f.service.targets
        .mutate(
          f.target,
          async () => {
            calls++
          },
          controller.signal,
        )
        .catch((error) => error),
    )
    try {
      await delay(50)
      expect(f.service.diagnostics.operations).toBe(8)
      await expect(f.service.resolve(f.target)).rejects.toMatchObject({
        status: 429,
      })
      await expect(
        f.service.targets.mutate(f.target, async () => {
          calls++
        }),
      ).rejects.toMatchObject({ status: 429 })
      controller.abort()
      await within(Promise.all(pending))
      expect(f.service.diagnostics.operations).toBe(0)
      expect(calls).toBe(0)
    } finally {
      controller.abort()
      gate.release()
      await Promise.all([holder, ...pending])
    }
  })
  it('does not rewrite unchanged persisted revisions', async () => {
    const f = await fixture()
    const first = await f.service.resolve(f.target)
    const changes = () =>
      Number(f.db.prepare('SELECT total_changes() AS n').get()!.n)
    const before = changes()
    for (let i = 0; i < 10; i++)
      expect(await f.service.resolve(f.target)).toEqual(first)
    expect(changes()).toBe(before)
  })
  it.each(['with\nnewline', 'with space', 'with-ü'])(
    'uses the same complete worktree path across services and Git routes: %j',
    async (name) => {
      const f = await fixture(true)
      const path = join(f.dir, name)
      await runGit(f.root, ['worktree', 'add', '-b', 'feature', path])
      const session = createSession(f.db, {
        projectId: f.project.id,
        cwd: path,
        harness: 'missing',
        title: 'Worktree',
      })
      expect(
        (await f.service.resolve({ kind: 'session', sessionId: session.id }))
          .cwd,
      ).toBe(path)
      expect(
        (await listWorktrees(f.root)).find(
          (entry) => entry.branch === 'feature',
        )!.path,
      ).toBe(path)
      const refs = await listRefs(f.root)
      expect(
        refs.refs.find((entry) => entry.name === 'feature')!.worktreePath,
      ).toBe(path)
      expect(
        refs.refs.find((entry) => entry.name === 'main')!.worktreePath,
      ).toBe(f.root)
      f.app.route('/', gitRoutes({ db: f.db, dataDir: f.dir }))
      expect(
        (
          await f.app.request(
            `/api/projects/${f.project.id}/git/status?${new URLSearchParams({ cwd: path })}`,
          )
        ).status,
      ).toBe(200)
    },
  )
  it('closes directory traversal handles after watch registration', async () => {
    const f = await fixture()
    let path = f.root
    for (let i = 0; i < 60; i++) {
      path = join(path, 'd')
      await mkdir(path)
    }
    const sub = await f.service.watches.subscribe(f.target)
    try {
      expect((await sub.next())!.mode).toBe('native')
      expect(f.service.diagnostics.watchDirectories).toBe(61)
      const owned = []
      for (const fd of await readdir('/proc/self/fd')) {
        const path = await readlink(`/proc/self/fd/${fd}`).catch(() => '')
        if (path.startsWith(f.root)) owned.push(path)
      }
      expect(owned).toEqual([])
      await writeFile(join(path, 'deep'), 'bytes')
      const event = await within(sub.next(), 2000)
      expect(event!.paths.some((path) => path.endsWith('/deep'))).toBe(true)
    } finally {
      sub.close()
    }
  })
  it('reuses initialized roots and avoids traversal on content changes', async () => {
    const f = await fixture()
    for (let i = 0; i < 25; i++) await mkdir(join(f.root, `d${i}`))
    const spy = vi.spyOn(WorkspacePath, 'open')
    const first = await f.service.watches.subscribe(f.target)
    let second
    try {
      await first.next()
      expect(spy).toHaveBeenCalledTimes(26)
      spy.mockClear()
      second = await f.service.watches.subscribe(f.target)
      await second.next()
      expect(spy).not.toHaveBeenCalled()
      await writeFile(join(f.root, 'file.txt'), 'changed')
      expect((await within(first.next(), 2000))!.paths).toContain('file.txt')
      await delay(200)
      expect(spy).not.toHaveBeenCalled()
      await mkdir(join(f.root, 'd0/new'))
      await until(
        () => f.service.diagnostics.watchDirectories,
        (n) => n === 27,
      )
      expect(spy.mock.calls.length).toBeLessThanOrEqual(3)
    } finally {
      first.close()
      second?.close()
      spy.mockRestore()
    }
  })
  it('drains a structural invalidation received during the initial directory traversal', async () => {
    const f = await fixture()
    await mkdir(join(f.root, 'early'))
    await mkdir(join(f.root, 'late'))
    const gate = barrier()
    f.service.hooks.beforeWatchDirectory = async (path) => {
      if (path === 'late') await gate.hook()
    }
    const pending = f.service.watches.subscribe(f.target)
    await gate.reached
    try {
      await mkdir(join(f.root, 'early/new'))
      await delay(150)
    } finally {
      gate.release()
    }
    const sub = await pending
    try {
      expect((await sub.next())!.mode).toBe('native')
      await until(
        () => f.service.diagnostics.watchDirectories,
        (n) => n === 4,
      )
      await writeFile(join(f.root, 'early/new/child'), 'bytes')
      let found = false
      for (let i = 0; i < 3 && !found; i++)
        found = (await within(sub.next(), 2000))!.paths.includes(
          'early/new/child',
        )
      expect(found).toBe(true)
    } finally {
      sub.close()
    }
  })
  it('shares validated physical observations during an idle checkout poll', async () => {
    const f = await fixture(true)
    const subscriptions = []
    for (let i = 0; i < 16; i++) {
      const session = createSession(f.db, {
        projectId: f.project.id,
        cwd: f.root,
        harness: 'missing',
        title: 'Alias',
      })
      subscriptions.push(
        await f.service.watches.subscribe({
          kind: 'session',
          sessionId: session.id,
        }),
      )
    }
    const watches = f.service.watches as unknown as {
      checkouts: Map<
        string,
        { timer: ReturnType<typeof setInterval>; pending?: Promise<void> }
      >
      poll(key: string): void
    }
    const key = subscriptions[0]!.workspace.checkoutKey
    const poll = watches.checkouts.get(key)!
    clearInterval(poll.timer)
    await poll.pending
    const calls = vi.spyOn(git, 'runGit')
    const changes = () =>
      Number(f.db.prepare('SELECT total_changes() AS n').get()!.n)
    const before = changes()
    try {
      watches.poll(key)
      await poll.pending
      expect(calls.mock.calls.length).toBe(6)
      expect(changes()).toBe(before)
      f.db
        .prepare('UPDATE sessions SET deleted_at = 1 WHERE id = ?')
        .run(
          (subscriptions[1]!.workspace.target as { sessionId: string })
            .sessionId,
        )
      watches.poll(key)
      await poll.pending
      let final
      do {
        final = await subscriptions[1]!.next()
      } while (final && !final.targetChanged)
      expect(final).toMatchObject({ targetChanged: true, mode: 'unavailable' })
    } finally {
      calls.mockRestore()
      for (const sub of subscriptions) sub.close()
    }
  })

  it.each(['listing', 'search'])(
    'keeps the bounded %s result when its deadline expires during final validation',
    async (kind) => {
      const f = await fixture()
      const controller = new AbortController()
      const resolve = f.service.targets.resolve.bind(f.service.targets)
      let calls = 0
      const spy = vi
        .spyOn(f.service.targets, 'resolve')
        .mockImplementation(async (...args) => {
          if (++calls === 2) controller.abort(new Error('deadline'))
          return resolve(...args)
        })
      try {
        const result =
          kind === 'listing'
            ? await f.service.list(
                f.target,
                { path: '', includeHidden: true, includeIgnored: false },
                controller.signal,
              )
            : await f.service.search(
                f.target,
                {
                  query: 'file',
                  limit: 200,
                  includeHidden: true,
                  includeIgnored: false,
                },
                controller.signal,
              )
        expect(result).toMatchObject({
          truncated: true,
          partialReasons: ['timeout'],
        })
      } finally {
        spy.mockRestore()
      }
    },
  )
})
