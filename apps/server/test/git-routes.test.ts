import { describe, expect, test } from 'vitest'
import { gitRoutes } from '../src/http/git.js'
import { createSession } from '../src/db/queries.js'
import { WorkspaceTargets } from '../src/workspace/target.js'
import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createTestApp as createApp } from './app-fixture.js'
import { migrate } from '../src/db/migrate.js'
import { UploadStore } from '../src/uploads/store.js'
import { runGit } from '../src/git/exec.js'

describe('git routes', () => {
  test('returns status and refs, and rejects outside cwd', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const projectPath = await mkdtemp(`${tmpdir()}/forge-project-`)
    const outside = await mkdtemp(`${tmpdir()}/forge-outside-`)
    try {
      await mkdir(`${projectPath}/.git`)
      db.prepare(
        'INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)',
      ).run('p1', 'Project', projectPath, 1)
      const app = createApp(new UploadStore(db, { dataDir: projectPath }))
      const status = await app.request('/api/projects/p1/git/status')
      expect(status.status).toBe(200)
      expect(await status.json()).toMatchObject({ isRepo: false })
      expect((await app.request('/api/projects/p1/git/branches')).status).toBe(
        200,
      )
      expect(
        (
          await app.request(
            `/api/projects/p1/git/status?cwd=${encodeURIComponent(outside)}`,
          )
        ).status,
      ).toBe(400)
      expect(
        (await app.request('/api/projects/missing/git/status')).status,
      ).toBe(404)
    } finally {
      await rm(projectPath, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('creates, lists, and removes session worktrees', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const projectPath = await mkdtemp(`${tmpdir()}/forge-project-`)
    const dataDir = await mkdtemp(`${tmpdir()}/forge-data-`)
    try {
      await runGit(projectPath, ['init', '-b', 'main'])
      await runGit(projectPath, ['config', 'user.email', 'forge@example.test'])
      await runGit(projectPath, ['config', 'user.name', 'Forge'])
      await writeFile(`${projectPath}/README`, 'test')
      await runGit(projectPath, ['add', '.'])
      await runGit(projectPath, ['commit', '-m', 'initial'])
      db.prepare(
        'INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)',
      ).run('p1', 'Project', projectPath, 1)
      const store = new UploadStore(db, { dataDir })
      const app = createApp(store)
      const create = await app.request('/api/projects/p1/git/worktrees', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseRef: 'main', branch: 'feature/test' }),
      })
      expect(create.status).toBe(201)
      const created = (await create.json()) as { path: string; branch: string }
      const listed = await app.request('/api/projects/p1/git/worktrees')
      expect(listed.status).toBe(200)
      expect(await listed.json()).toEqual({
        worktrees: [
          expect.objectContaining({
            path: created.path,
            branch: 'feature/test',
            detached: false,
            dirty: false,
            activeSession: false,
          }),
        ],
      })
      const duplicate = await app.request('/api/projects/p1/git/worktrees', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseRef: 'main', branch: 'feature/test' }),
      })
      expect(duplicate.status).toBe(400)
      db.prepare(
        "INSERT INTO sessions (id, project_id, harness, title, cwd, kind, status, auto_resume, created_at, last_activity_at) VALUES ('s1', 'p1', 'test', 'test', ?, 'chat', 'idle', 0, 1, 1)",
      ).run(created.path)
      db.prepare(
        "INSERT INTO sessions (id, project_id, harness, title, cwd, kind, status, auto_resume, created_at, last_activity_at) VALUES ('s2', 'p1', 'test', 'test', ?, 'chat', 'idle', 0, 1, 1)",
      ).run(created.path)
      const blocked = await app.request('/api/projects/p1/git/worktrees', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: created.path }),
      })
      expect(blocked.status).toBe(409)
      db.prepare(
        "UPDATE sessions SET status = 'archived' WHERE id IN ('s1', 's2')",
      ).run()
      expect(
        (
          await app.request('/api/projects/p1/git/worktrees', {
            method: 'DELETE',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: created.path }),
          })
        ).status,
      ).toBe(200)
      expect(
        await (await app.request('/api/projects/p1/git/worktrees')).json(),
      ).toEqual({ worktrees: [] })
      expect(
        (
          await runGit(
            projectPath,
            ['show-ref', '--verify', 'refs/heads/feature/test'],
            false,
          )
        ).code,
      ).toBe(0)
      expect(
        (await app.request('/api/projects/missing/git/worktrees')).status,
      ).toBe(404)
    } finally {
      await rm(projectPath, { recursive: true, force: true })
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  test('does not remove a dirty temporary worktree or its branch', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const projectPath = await mkdtemp(`${tmpdir()}/forge-project-dirty-`)
    const dataDir = await mkdtemp(`${tmpdir()}/forge-data-dirty-`)
    try {
      await runGit(projectPath, ['init', '-b', 'main'])
      await runGit(projectPath, ['config', 'user.email', 'forge@example.test'])
      await runGit(projectPath, ['config', 'user.name', 'Forge'])
      await writeFile(`${projectPath}/README`, 'test')
      await runGit(projectPath, ['add', '.'])
      await runGit(projectPath, ['commit', '-m', 'initial'])
      db.prepare(
        'INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)',
      ).run('p1', 'Project', projectPath, 1)
      const app = createApp(new UploadStore(db, { dataDir }))
      const created = await app.request('/api/projects/p1/git/worktrees', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseRef: 'main' }),
      })
      const worktree = (await created.json()) as {
        path: string
        branch: string
      }
      await writeFile(`${worktree.path}/dirty.txt`, 'keep me')
      const removed = await app.request('/api/projects/p1/git/worktrees', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: worktree.path }),
      })
      expect(removed.status).toBe(400)
      expect(
        (
          await runGit(
            projectPath,
            ['show-ref', '--verify', `refs/heads/${worktree.branch}`],
            false,
          )
        ).code,
      ).toBe(0)
    } finally {
      await rm(projectPath, { recursive: true, force: true })
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  test('returns 409 when concurrent provisioning reaches the project cap', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const projectPath = await mkdtemp(`${tmpdir()}/forge-project-cap-`)
    const dataDir = await mkdtemp(`${tmpdir()}/forge-data-cap-`)
    try {
      await runGit(projectPath, ['init', '-b', 'main'])
      await runGit(projectPath, ['config', 'user.email', 'forge@example.test'])
      await runGit(projectPath, ['config', 'user.name', 'Forge'])
      await writeFile(`${projectPath}/README`, 'test')
      await runGit(projectPath, ['add', '.'])
      await runGit(projectPath, ['commit', '-m', 'initial'])
      db.prepare(
        'INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)',
      ).run('p1', 'Project', projectPath, 1)
      const app = createApp(new UploadStore(db, { dataDir }))
      for (let index = 0; index < 15; index++) {
        const response = await app.request('/api/projects/p1/git/worktrees', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            baseRef: 'main',
            branch: `feature/cap-${index}`,
          }),
        })
        expect(response.status).toBe(201)
      }
      const responses = await Promise.all([
        app.request('/api/projects/p1/git/worktrees', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ baseRef: 'main', branch: 'feature/race-a' }),
        }),
        app.request('/api/projects/p1/git/worktrees', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ baseRef: 'main', branch: 'feature/race-b' }),
        }),
      ])
      expect(responses.map((response) => response.status).sort()).toEqual([
        201, 409,
      ])
      const rejected = responses.find((response) => response.status === 409)
      expect(await rejected?.json()).toMatchObject({
        error: expect.stringContaining('16 session worktrees'),
      })
    } finally {
      await rm(projectPath, { recursive: true, force: true })
      await rm(dataDir, { recursive: true, force: true })
    }
  })
})

test('session Git routes retain exact workspace authority', async () => {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  const cwd = await mkdtemp(`${tmpdir()}/forge-session-git-`)
  const outside = await mkdtemp(`${tmpdir()}/forge-session-git-foreign-`)
  try {
    for (const [path, name] of [
      [cwd, 'owned'],
      [outside, 'foreign'],
    ] as const) {
      await runGit(path, ['init', '-b', name])
      await runGit(path, ['config', 'user.email', 'fixture@example.invalid'])
      await runGit(path, ['config', 'user.name', 'Fixture'])
      await writeFile(`${path}/${name}.txt`, `${name} original\n`)
      await runGit(path, ['add', '.'])
      await runGit(path, ['commit', '-m', `${name} commit`])
    }
    await writeFile(`${cwd}/owned.txt`, 'owned changed\n')
    db.prepare(
      'INSERT INTO projects (id,name,path,created_at) VALUES (?,?,?,?)',
    ).run('owned', 'owned', cwd, 1)
    const session = createSession(db, {
      projectId: 'owned',
      harness: 'mock',
      title: 'session workspace',
      cwd,
    })
    const targets = new WorkspaceTargets(db)
    const app = gitRoutes({ db, dataDir: cwd, targets })
    // Query params naming foreign roots must not redirect a session route.
    const misleading = `?cwd=${encodeURIComponent(outside)}&sessionId=foreign&projectId=foreign`
    const expected = await targets.resolve({
      kind: 'session',
      sessionId: session.id,
    })
    const identity = {
      workspaceId: expected.workspaceId,
      workspaceRevision: expected.workspaceRevision,
    }
    const status = await app.request(
      `/api/sessions/${session.id}/git/status${misleading}`,
    )
    expect(status.status).toBe(200)
    expect(await status.json()).toMatchObject({
      isRepo: true,
      branch: 'owned',
      dirty: true,
      workspace: identity,
    })
    const branches = await app.request(
      `/api/sessions/${session.id}/git/branches${misleading}`,
    )
    expect(branches.status).toBe(200)
    const refs = (await branches.json()) as {
      workspace: unknown
      refs: Array<{ name: string }>
    }
    expect(refs.workspace).toEqual(identity)
    expect(refs.refs.some((ref) => ref.name.includes('owned'))).toBe(true)
    expect(refs.refs.some((ref) => ref.name.includes('foreign'))).toBe(false)
    const history = await app.request(
      `/api/sessions/${session.id}/git/history${misleading}`,
    )
    expect(history.status).toBe(200)
    const page = (await history.json()) as {
      workspace: unknown
      commits: Array<{ subject: string }>
    }
    expect(page.workspace).toEqual(identity)
    expect(page.commits.map((commit) => commit.subject)).toEqual([
      'owned commit',
    ])
    const diff = await app.request(
      `/api/sessions/${session.id}/git/diff${misleading}`,
    )
    expect(diff.status).toBe(200)
    const body = (await diff.json()) as {
      workspace: unknown
      files: Array<{ newPath: string }>
    }
    expect(body.workspace).toEqual(identity)
    expect(body.files.map((file) => file.newPath)).toEqual(['owned.txt'])
    db.prepare(
      'INSERT INTO projects (id,name,path,created_at) VALUES (?,?,?,?)',
    ).run('foreign', 'foreign', outside, 1)
    expect(
      (
        await app.request(
          `/api/projects/foreign/git/diff?sessionId=${session.id}`,
        )
      ).status,
    ).toBe(400)
    db.prepare('UPDATE sessions SET deleted_at=1 WHERE id=?').run(session.id)
    for (const operation of ['status', 'branches', 'diff', 'history']) {
      expect(
        (
          await app.request(
            `/api/sessions/${session.id}/git/${operation}${misleading}`,
          )
        ).status,
      ).toBe(404)
      expect(
        (await app.request(`/api/sessions/missing/git/${operation}`)).status,
      ).toBe(404)
    }
  } finally {
    db.close()
    await rm(cwd, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})
