import { DatabaseSync } from 'node:sqlite'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fixture } from './fixtures.js'
import { createProject, createSession } from '../db/queries.js'
import { runGit } from '../git/exec.js'
import { WorkspaceFiles } from './files.js'
import { migrate } from '../db/migrate.js'

describe('persisted provider-independent workspace targets', () => {
  it('resolves main, separate worktree, project, and fork cwd without provider state', async () => {
    const f = await fixture(true)
    const worktree = join(f.dir, 'work tree\nname')
    await runGit(f.root, ['worktree', 'add', '-b', 'feature', worktree])
    await writeFile(join(worktree, 'file.txt'), 'worktree\n')
    const fork = createSession(f.db, {
      projectId: f.project.id,
      cwd: worktree,
      harness: 'missing',
      title: 'Fork',
    })
    const snapshot = await f.snapshot('file.txt', {
      kind: 'session',
      sessionId: fork.id,
    })
    expect(snapshot.file.text).toBe('worktree\n')
    expect(snapshot.workspace.worktreePath).toBe(worktree)
    expect((await f.snapshot()).file.text).toBe('original\n')
    const project = await f.snapshot('file.txt', {
      kind: 'project',
      projectId: f.project.id,
    })
    expect(project.workspace.workspaceId).toBe(
      (await f.snapshot()).workspace.workspaceId,
    )
    const before = await f.service.resolve(f.target)
    f.db
      .prepare(
        "UPDATE sessions SET status = 'archived', provider_session_id = 'changed', account_id = NULL WHERE id = ?",
      )
      .run(f.session.id)
    expect(await f.service.resolve(f.target)).toEqual(before)
    const linkedProject = createProject(f.db, {
      name: 'Linked project',
      path: worktree,
    })
    expect(
      (
        await f.service.resolve({
          kind: 'project',
          projectId: linkedProject.id,
        })
      ).worktreePath,
    ).toBe(worktree)
    const index = await readFile(join(f.root, '.git/index'))
    expect(
      (
        await f.save(
          await f.input('worktree edit', 'file.txt', {
            kind: 'session',
            sessionId: fork.id,
          }),
        )
      ).status,
    ).toBe(200)
    expect(await readFile(join(f.root, 'file.txt'), 'utf8')).toBe('original\n')
    expect(await readFile(join(f.root, '.git/index'))).toEqual(index)
  })
  it('reports no target, unknown/deleted targets, missing roots, and invalid worktree hints', async () => {
    const f = await fixture()
    expect(
      (await f.app.request(f.url('target', {}, { kind: 'none' }))).status,
    ).toBe(404)
    expect(
      (
        await f.app.request(
          f.url('target', {}, { kind: 'session', sessionId: 'missing' }),
        )
      ).status,
    ).toBe(404)
    f.db
      .prepare('UPDATE sessions SET worktree_path = ? WHERE id = ?')
      .run(f.root, f.session.id)
    expect((await f.app.request(f.url('target'))).status).toBe(403)
    f.db
      .prepare('UPDATE sessions SET worktree_path = NULL, cwd = ? WHERE id = ?')
      .run(join(f.dir, 'absent'), f.session.id)
    expect((await f.app.request(f.url('target'))).status).toBe(503)
    f.db
      .prepare('UPDATE sessions SET deleted_at = 1 WHERE id = ?')
      .run(f.session.id)
    expect((await f.app.request(f.url('target'))).status).toBe(404)
  })
  it('keeps project reads independent and rejects archived projects without creating sessions', async () => {
    const f = await fixture()
    const count = f.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()
    expect(
      (
        await f.snapshot('file.txt', {
          kind: 'project',
          projectId: f.project.id,
        })
      ).workspace.cwd,
    ).toBe(f.root)
    f.db
      .prepare('UPDATE projects SET archived_at = 1 WHERE id = ?')
      .run(f.project.id)
    expect(
      (
        await f.app.request(
          f.url('target', {}, { kind: 'project', projectId: f.project.id }),
        )
      ).status,
    ).toBe(404)
    expect((await f.app.request(f.url('target'))).status).toBe(200)
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual(
      count,
    )
  })
  it('persists revisions and identities across database/service restarts and repeated migrations', async () => {
    const f = await fixture(true)
    const before = await f.service.resolve(f.target)
    await f.service.targets.mutate(f.target, async () => {})
    const changed = await f.service.resolve(f.target)
    expect(changed.workspaceRevision).toBeGreaterThan(before.workspaceRevision)
    await f.service.close()
    const db = new DatabaseSync(join(f.dir, 'forge.db'))
    db.exec('DROP TABLE schema_migrations')
    migrate(db)
    migrate(db)
    const service = new WorkspaceFiles(db)
    try {
      expect(await service.resolve(f.target)).toEqual(changed)
    } finally {
      await service.close()
      db.close()
    }
  })
  it.each(['branch', 'commit', 'cwd', 'root'])(
    'rejects stale saves after an observed %s change',
    async (change) => {
      const f = await fixture(true)
      const input = await f.input('new')
      if (change === 'branch')
        await runGit(f.root, ['checkout', '-b', 'same-tree'])
      if (change === 'commit') {
        await runGit(f.root, ['commit', '--allow-empty', '-m', 'metadata'])
        await runGit(f.root, ['pack-refs', '--all', '--prune'])
      }
      if (change === 'cwd') {
        const worktree = join(f.dir, 'worktree')
        await runGit(f.root, ['worktree', 'add', '-b', 'feature', worktree])
        f.db
          .prepare('UPDATE sessions SET cwd = ? WHERE id = ?')
          .run(worktree, f.session.id)
      }
      if (change === 'root') {
        await rename(f.root, join(f.dir, 'old'))
        await mkdir(f.root)
        await writeFile(join(f.root, 'file.txt'), 'original\n')
      }
      const response = await f.save(input)
      expect(response.status).toBe(409)
      expect((await response.json()).reason).toBe('workspace_changed')
    },
  )
  it('invalidates all nested aliases across Forge-controlled A-to-B-to-A checkout changes', async () => {
    const f = await fixture(true)
    await mkdir(join(f.root, 'nested'))
    await writeFile(join(f.root, 'nested/file.txt'), 'nested')
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
    const nestedTarget = { kind: 'session' as const, sessionId: session.id }
    const first = await f.input('first'),
      second = await f.input('second', 'file.txt', nestedTarget)
    expect(first.expectedWorkspaceId).not.toBe(second.expectedWorkspaceId)
    await f.service.targets.mutate(f.target, async () => {
      await runGit(f.root, ['checkout', '-b', 'identical'])
      await runGit(f.root, ['checkout', 'main'])
    })
    for (const input of [first, second]) {
      const response = await f.save(input)
      expect(response.status).toBe(409)
      expect((await response.json()).reason).toBe('workspace_changed')
    }
  })
  it('observes external packed-ref changes in a linked worktree', async () => {
    const f = await fixture(true)
    const worktree = join(f.dir, 'linked')
    await runGit(f.root, ['worktree', 'add', '-b', 'linked', worktree])
    const session = createSession(f.db, {
      projectId: f.project.id,
      cwd: worktree,
      harness: 'missing',
      title: 'Linked',
    })
    const target = { kind: 'session' as const, sessionId: session.id }
    const before = await f.service.resolve(target)
    await runGit(worktree, ['commit', '--allow-empty', '-m', 'next'])
    await runGit(worktree, ['pack-refs', '--all', '--prune'])
    const after = await f.service.resolve(target)
    expect(after.workspaceId).toBe(before.workspaceId)
    expect(after.workspaceRevision).toBeGreaterThan(before.workspaceRevision)
  })
})
