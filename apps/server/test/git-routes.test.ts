import { describe, expect, test } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createApp } from '../src/index.js'
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
        "INSERT INTO sessions (id, project_id, harness, title, cwd, kind, status, auto_resume, created_at, last_activity_at) VALUES ('s1', 'p1', 'test', 'test', ?, 'chat', 'running', 0, 1, 1)",
      ).run(created.path)
      const blocked = await app.request('/api/projects/p1/git/worktrees', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: created.path }),
      })
      expect(blocked.status).toBe(409)
      db.prepare("UPDATE sessions SET status = 'idle' WHERE id = 's1'").run()
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
        (await app.request('/api/projects/missing/git/worktrees')).status,
      ).toBe(404)
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
