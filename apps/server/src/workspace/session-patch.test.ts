import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fixture, barrier, until } from './fixtures.js'
import { sessionRoutes } from '../http/sessions.js'
import { SessionManager } from '../sessions/manager.js'
import { EventBus } from '../events/bus.js'
import { runGit } from '../git/exec.js'
import { createProject, createSession } from '../db/queries.js'
import { listWorktrees } from '../git/worktrees.js'

async function setup() {
  const f = await fixture(true)
  const manager = new SessionManager(
    f.db,
    new EventBus(),
    () => {
      throw new Error('Provider must not start')
    },
    undefined,
    () => false,
    join(f.dir, 'data'),
  )
  const released: string[] = []
  manager.releaseHandle = async (id) => {
    released.push(id)
  }
  f.app.route('/', sessionRoutes(manager, undefined, f.service.targets))
  const patch = (value: Record<string, unknown>, id = f.session.id) =>
    f.app.request(`/api/sessions/${id}/workspace`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    })
  return { ...f, manager, released, patch }
}
describe('workspace PATCH coordination and existing behavior', () => {
  it('keeps running-session and dirty-checkout rejection and invalidates failed mutations', async () => {
    const f = await setup()
    const initial = await f.service.resolve(f.target)
    f.db
      .prepare("UPDATE sessions SET status = 'running' WHERE id = ?")
      .run(f.session.id)
    expect((await f.patch({ mode: 'local', branch: 'main' })).status).toBe(409)
    f.db
      .prepare("UPDATE sessions SET status = 'idle' WHERE id = ?")
      .run(f.session.id)
    await writeFile(join(f.root, 'file.txt'), 'dirty')
    expect((await f.patch({ mode: 'local', branch: 'main' })).status).toBe(409)
    expect(
      (await f.service.resolve(f.target)).workspaceRevision,
    ).toBeGreaterThan(initial.workspaceRevision)
    expect(f.released).toEqual([])
    f.manager.close()
  })
  it('invalidates same-path A-to-B-to-A switches without releasing the existing handle', async () => {
    const f = await setup()
    await runGit(f.root, ['branch', 'other'])
    const input = await f.input('new')
    expect((await f.patch({ mode: 'local', branch: 'other' })).status).toBe(200)
    expect((await f.patch({ mode: 'local', branch: 'main' })).status).toBe(200)
    expect((await f.save(input)).status).toBe(409)
    expect(f.released).toEqual([])
    f.manager.close()
  })
  it('preserves worktree selection, branch collisions, lock cleanup, and changed-cwd handle release', async () => {
    const f = await setup()
    const first = await f.patch({
      mode: 'worktree',
      branch: 'feature',
      baseRef: 'main',
    })
    expect(first.status).toBe(200)
    const body = await first.json()
    expect(body.cwd).toBe(
      join(f.dir, 'data/worktrees', f.project.id, 'feature'),
    )
    expect(body.worktreePath).toBe(body.cwd)
    expect(body.branch).toBe('feature')
    expect(f.released).toEqual([f.session.id])
    const other = createSession(f.db, {
      projectId: f.project.id,
      cwd: f.root,
      harness: 'missing',
      title: 'Other',
    })
    expect(
      (
        await f.patch(
          { mode: 'worktree', branch: 'feature', baseRef: 'main' },
          other.id,
        )
      ).status,
    ).toBe(400)
    expect(
      (
        await f.patch(
          { mode: 'worktree', branch: 'after-collision', baseRef: 'main' },
          other.id,
        )
      ).status,
    ).toBe(200)
    expect((await listWorktrees(f.root)).length).toBe(2)
    f.manager.close()
  })
  it('rejects stale staged writes when PATCH wins the common-repository gate', async () => {
    const gate = barrier()
    const f = await setup()
    f.service.hooks.staged = gate.hook
    await runGit(f.root, ['branch', 'other'])
    const saving = f.save(await f.input('submitted'))
    await gate.reached
    const response = await f.patch({ mode: 'local', branch: 'other' })
    gate.release()
    expect(response.status).toBe(200)
    expect((await saving).status).toBe(409)
    expect(await readFile(join(f.root, 'file.txt'), 'utf8')).toBe('original\n')
    f.manager.close()
  })
  it.each(['tracked', 'untracked', 'prefix-lookalike'])(
    'keeps %s edits dirty while a save owns a staged sibling',
    async (kind) => {
      const gate = barrier()
      const f = await setup()
      f.service.hooks.staged = gate.hook
      await runGit(f.root, ['branch', 'other'])
      const saving = f.save(await f.input('submitted'))
      await gate.reached
      try {
        const path =
          kind === 'tracked'
            ? 'file.txt'
            : kind === 'untracked'
              ? 'unrelated'
              : '.forge-save-user-file'
        await writeFile(join(f.root, path), 'external')
        expect((await f.patch({ mode: 'local', branch: 'other' })).status).toBe(
          409,
        )
        expect(await readFile(join(f.root, path), 'utf8')).toBe('external')
      } finally {
        gate.release()
        await saving
        f.manager.close()
      }
      expect(f.service.targets.temporaryPaths.size).toBe(0)
    },
  )
  it('rechecks the live row after waiting for the mutation gate', async () => {
    const f = await setup()
    const workspace = await f.service.targets.resolve(f.target)
    const gate = barrier()
    const holder = f.service.targets.mutations.run(workspace.gateKey, gate.hook)
    await gate.reached
    const pending = f.patch({ mode: 'local', branch: 'main' })
    f.db
      .prepare("UPDATE sessions SET status = 'running' WHERE id = ?")
      .run(f.session.id)
    gate.release()
    await holder
    expect((await pending).status).toBe(409)
    f.manager.close()
  })
  it.each(['missing worktree', 'invalid cwd', 'invalid hint'])(
    'recovers an explicit local selection after %s while keeping file reads strict',
    async (kind) => {
      const f = await setup()
      try {
        const first = await f.patch({
          mode: 'worktree',
          branch: 'recover',
          baseRef: 'main',
        })
        expect(first.status).toBe(200)
        const { cwd } = await first.json()
        const before = await f.service.resolve(f.target)
        if (kind === 'missing worktree') await rename(cwd, join(f.dir, 'moved'))
        if (kind === 'invalid cwd') {
          const outside = join(f.dir, 'outside')
          await mkdir(outside)
          f.db
            .prepare('UPDATE sessions SET cwd = ? WHERE id = ?')
            .run(outside, f.session.id)
        }
        if (kind === 'invalid hint')
          f.db
            .prepare('UPDATE sessions SET worktree_path = ? WHERE id = ?')
            .run(f.root, f.session.id)
        const failedRead = await f.app.request(
          f.url('file', { path: 'file.txt' }),
        )
        expect([403, 503]).toContain(failedRead.status)
        const response = await f.patch({ mode: 'local' })
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({
          cwd: f.root,
          worktreePath: null,
        })
        expect(
          (await f.service.resolve(f.target)).workspaceRevision,
        ).toBeGreaterThan(before.workspaceRevision)
        expect((await f.snapshot()).file.text).toBe('original\n')
      } finally {
        f.manager.close()
      }
    },
  )
  it('recovers damaged old Git metadata while retaining strict authority, cancellation, and mutation failures', async () => {
    const f = await setup()
    try {
      expect(
        (
          await f.patch({
            mode: 'worktree',
            branch: 'damaged',
            baseRef: 'main',
          })
        ).status,
      ).toBe(200)
      const before = await f.service.resolve(f.target)
      const input = await f.input('stale save')
      await writeFile(
        join(before.cwd, '.git'),
        `gitdir: ${join(f.dir, 'absent-git')}\n`,
      )
      expect(
        (await f.app.request(f.url('file', { path: 'file.txt' }))).status,
      ).toBe(503)
      const revision = () =>
        f.db
          .prepare(
            'SELECT revision FROM workspace_target_revisions WHERE target_key = ?',
          )
          .get(`session:${f.session.id}`)!.revision
      const previous = revision()
      const controller = new AbortController()
      controller.abort()
      expect(
        (
          await f.app.request(`/api/sessions/${f.session.id}/workspace`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: 'local' }),
            signal: controller.signal,
          })
        ).status,
      ).toBe(503)
      expect(revision()).toBe(previous)
      await rename(f.root, join(f.dir, 'project-moved'))
      try {
        expect((await f.patch({ mode: 'local' })).status).toBe(503)
        expect(revision()).toBe(previous)
      } finally {
        await rename(join(f.dir, 'project-moved'), f.root)
      }
      expect(
        (await f.patch({ mode: 'local', branch: 'absent-branch' })).status,
      ).toBe(400)
      expect(Number(revision())).toBeGreaterThan(Number(previous))
      expect(
        f.db.prepare('SELECT cwd FROM sessions WHERE id = ?').get(f.session.id)!
          .cwd,
      ).toBe(before.cwd)
      expect(f.released).toEqual([f.session.id])
      const response = await f.patch({ mode: 'local' })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        cwd: f.root,
        worktreePath: null,
      })
      expect(
        (await f.service.resolve(f.target)).workspaceRevision,
      ).toBeGreaterThan(before.workspaceRevision)
      expect((await f.save(input)).status).toBe(409)
      expect((await f.snapshot()).file.text).toBe('original\n')
      expect(f.released).toEqual([f.session.id, f.session.id])
    } finally {
      f.manager.close()
    }
  })
  it('keeps an owned staged file clean for PATCH through a nested registered project', async () => {
    const f = await setup()
    await mkdir(join(f.root, 'nested'))
    await writeFile(join(f.root, 'nested/file.txt'), 'nested\n')
    await runGit(f.root, ['add', '.'])
    await runGit(f.root, ['commit', '-m', 'nested'])
    await runGit(f.root, ['branch', 'other'])
    const project = createProject(f.db, {
      name: 'Nested',
      path: join(f.root, 'nested'),
    })
    const session = createSession(f.db, {
      projectId: project.id,
      cwd: project.path,
      harness: 'missing',
      title: 'Nested',
    })
    const gate = barrier()
    f.service.hooks.staged = gate.hook
    const saving = f.save(
      await f.input('submitted', 'file.txt', {
        kind: 'session',
        sessionId: session.id,
      }),
    )
    await gate.reached
    try {
      expect(
        (await f.patch({ mode: 'local', branch: 'other' }, session.id)).status,
      ).toBe(200)
    } finally {
      gate.release()
      f.manager.close()
    }
    expect((await saving).status).toBe(409)
    expect(await readFile(join(project.path, 'file.txt'), 'utf8')).toBe(
      'nested\n',
    )
  })
  it('cancels queued HTTP PATCH promptly and releases its shared operation lease', async () => {
    const f = await setup()
    const workspace = await f.service.targets.resolve(f.target)
    const gate = barrier()
    const holding = f.service.targets.mutations.run(
      workspace.gateKey,
      gate.hook,
    )
    await gate.reached
    const controller = new AbortController()
    const pending = f.app.request(`/api/sessions/${f.session.id}/workspace`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'local', branch: 'main' }),
      signal: controller.signal,
    })
    try {
      await until(
        () => f.service.diagnostics.operations,
        (n) => n === 1,
      )
      controller.abort()
      await until(
        () => f.service.diagnostics.operations,
        (n) => n === 0,
        500,
      )
      expect((await pending).status).toBe(503)
      expect(f.released).toEqual([])
      expect((await f.service.resolve(f.target)).workspaceRevision).toBe(
        workspace.workspaceRevision,
      )
    } finally {
      controller.abort()
      gate.release()
      await holding
      await pending
      f.manager.close()
    }
  })
})
