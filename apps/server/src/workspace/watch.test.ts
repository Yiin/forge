import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fixture, until } from './fixtures.js'
import { Subscription } from './watch.js'
import { createProject, createSession } from '../db/queries.js'
import { runGit } from '../git/exec.js'
import type { WorkspaceChange } from '@forge/protocol/workspace'

async function next(
  subscription: Subscription,
  predicate: (event: WorkspaceChange) => boolean = () => true,
) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const event = await Promise.race([
        subscription.next(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Missing watch event')),
            5000,
          )
        }),
      ])
      if (!event) throw new Error('Subscription closed')
      if (predicate(event)) return event
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error('Missing matching watch event')
}
describe('bounded shared workspace invalidations', () => {
  it('watches real edits, directory creation, unlink/recreate, and releases owned resources', async () => {
    const f = await fixture()
    const a = await f.service.watches.subscribe(f.target),
      b = await f.service.watches.subscribe(f.target)
    expect((await next(a)).resyncRequired).toBe(true)
    expect((await next(b)).mode).toBe('native')
    expect(f.service.diagnostics.watchRoots).toBe(1)
    expect(f.service.diagnostics.checkoutPolls).toBe(1)
    await writeFile(join(f.root, 'file.txt'), 'external')
    expect(
      (await next(a, (e) => e.paths.includes('file.txt'))).resyncRequired,
    ).toBe(false)
    await mkdir(join(f.root, 'new'))
    await until(
      () => f.service.diagnostics.watchDirectories,
      (count) => count === 2,
    )
    await writeFile(join(f.root, 'new/child'), 'created')
    await next(a, (e) => e.paths.includes('new/child'))
    await rm(join(f.root, 'new'), { recursive: true })
    await until(
      () => f.service.diagnostics.watchDirectories,
      (count) => count === 1,
    )
    await mkdir(join(f.root, 'new'))
    await until(
      () => f.service.diagnostics.watchDirectories,
      (count) => count === 2,
    )
    a.close()
    expect(f.service.diagnostics.subscribers).toBe(1)
    b.close()
    await until(
      () => f.service.diagnostics.watchTasks,
      (count) => count === 0,
    )
    expect(f.service.diagnostics).toMatchObject({
      watchRoots: 0,
      watchDirectories: 0,
      subscribers: 0,
      checkoutPolls: 0,
    })
  })
  it('forces resync after raw event and subscriber buffer overflow', async () => {
    const f = await fixture()
    const sub = await f.service.watches.subscribe(f.target)
    await next(sub)
    f.service.watches.invalidate(
      sub.workspace.workspaceId,
      Array.from({ length: 300 }, (_, i) => `entry-${i}`),
    )
    expect(await next(sub)).toMatchObject({ resyncRequired: true, paths: [] })
    for (let i = 0; i < 100; i++) sub.push([`slow-${i}`], false, 'native')
    expect(await next(sub)).toMatchObject({ resyncRequired: true, paths: [] })
    sub.close()
  })
  it('polls identical-tree branch changes across aliases and linked metadata outside the visible root', async () => {
    const f = await fixture(true)
    await mkdir(join(f.root, 'nested'))
    const alias = createProject(f.db, {
      name: 'Alias',
      path: join(f.root, 'nested'),
    })
    const target = { kind: 'project' as const, projectId: alias.id }
    const a = await f.service.watches.subscribe(f.target),
      b = await f.service.watches.subscribe(target)
    const beforeA = await next(a),
      beforeB = await next(b)
    expect(f.service.diagnostics.checkoutPolls).toBe(1)
    await runGit(f.root, ['checkout', '-b', 'identical'])
    const afterA = await next(
      a,
      (e) =>
        e.workspace.workspaceRevision > beforeA.workspace.workspaceRevision,
    )
    const afterB = await next(
      b,
      (e) =>
        e.workspace.workspaceRevision > beforeB.workspace.workspaceRevision,
    )
    expect(afterA.resyncRequired && afterB.resyncRequired).toBe(true)
    a.close()
    b.close()
    const worktree = join(f.dir, 'linked')
    await runGit(f.root, ['worktree', 'add', '-b', 'linked', worktree])
    const session = createSession(f.db, {
      projectId: f.project.id,
      cwd: worktree,
      harness: 'missing',
      title: 'Linked',
    })
    const linked = await f.service.watches.subscribe({
      kind: 'session',
      sessionId: session.id,
    })
    const first = await next(linked)
    await runGit(worktree, ['commit', '--allow-empty', '-m', 'new'])
    await runGit(worktree, ['pack-refs', '--all', '--prune'])
    expect(
      (
        await next(
          linked,
          (e) =>
            e.workspace.workspaceRevision > first.workspace.workspaceRevision,
        )
      ).resyncRequired,
    ).toBe(true)
    linked.close()
  })
  it('closes a selected target subscription after root replacement or deletion', async () => {
    const f = await fixture()
    const sub = await f.service.watches.subscribe(f.target)
    await next(sub)
    await rename(f.root, join(f.dir, 'old'))
    await mkdir(f.root)
    expect(await next(sub, (e) => e.targetChanged === true)).toMatchObject({
      targetChanged: true,
      resyncRequired: true,
    })
    expect(await sub.next()).toBeUndefined()
    const second = await f.service.watches.subscribe(f.target)
    await next(second)
    f.db
      .prepare('UPDATE sessions SET deleted_at = 1 WHERE id = ?')
      .run(f.session.id)
    expect(await next(second, (e) => e.targetChanged === true)).toMatchObject({
      mode: 'unavailable',
      targetChanged: true,
    })
    expect(await second.next()).toBeUndefined()
  })
  it('bounds subscriptions and closes SSE on disconnect and shutdown', async () => {
    const f = await fixture()
    const response = await f.app.request(f.url('changes'))
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      'workspace_change',
    )
    await reader.cancel()
    await until(
      () => f.service.diagnostics.subscribers,
      (count) => count === 0,
    )
    const subscriptions: Subscription[] = []
    for (let i = 0; i < 64; i++)
      subscriptions.push(await f.service.watches.subscribe(f.target))
    await expect(f.service.watches.subscribe(f.target)).rejects.toMatchObject({
      status: 429,
    })
    await f.service.close()
    expect(f.service.diagnostics).toMatchObject({
      subscribers: 0,
      watchDirectories: 0,
      watchTasks: 0,
      checkoutPolls: 0,
    })
  })
  it('ends a stalled SSE writer at the operation deadline', async () => {
    const f = await fixture()
    const workspace = await f.service.resolve(f.target)
    const response = await f.app.request(f.url('changes'))
    try {
      for (let i = 0; i < 5; i++) {
        f.service.watches.invalidate(workspace.workspaceId, [`event-${i}`])
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
      await until(
        () => f.service.diagnostics.subscribers,
        (count) => count === 0,
        7500,
      )
      await f.service.close()
      expect(f.service.diagnostics.watchTasks).toBe(0)
    } finally {
      await response.body?.cancel()
    }
  }, 10_000)
})
