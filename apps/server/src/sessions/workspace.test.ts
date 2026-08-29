import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrate } from '../db/migrate.js'
import { createProject } from '../db/queries.js'
import { runGit } from '../git/exec.js'
import { EventBus } from '../events/bus.js'
import { SessionManager } from './manager.js'
import type { HarnessHandle } from './harness.js'

const paths: string[] = []
afterEach(async () => {
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true })
})

describe('session workspaces', () => {
  it('resolves a worktree outside the repository and keeps local sessions in place', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-workspace-'))
    paths.push(root)
    const dataDir = join(root, 'data')
    await runGit(root, ['init', '-b', 'main'])
    await writeFile(join(root, '.gitignore'), '')
    await runGit(root, ['add', '.gitignore'])
    await runGit(root, ['config', 'user.email', 'forge@example.test'])
    await runGit(root, ['config', 'user.name', 'Forge'])
    await runGit(root, ['commit', '-m', 'initial'])

    const db = new DatabaseSync(':memory:')
    migrate(db)
    const project = createProject(db, { name: 'Forge', path: root })
    const manager = new SessionManager(
      db,
      new EventBus(),
      () =>
        ({
          spawn: async (): Promise<HarnessHandle> => ({
            prompt: async () => undefined,
            cancel: async () => undefined,
            kill: async () => undefined,
          }),
        }) as never,
      undefined,
      () => false,
      dataDir,
    )

    const local = await manager.resolveWorkspace(project.id, root, { mode: 'local' })
    expect(local).toEqual({ cwd: root, worktreePath: null, branch: 'main' })
    const worktree = await manager.resolveWorkspace(project.id, root, {
      mode: 'worktree',
      branch: 'feature/session-workspace',
      baseRef: 'main',
    })
    expect(worktree.cwd).toBe(worktree.worktreePath)
    expect(worktree.cwd).toBe(join(dataDir, 'worktrees', project.id, 'feature-session-workspace'))
    expect(worktree.branch).toBe('feature/session-workspace')
    expect(worktree.cwd).not.toBe(root)
    db.close()
  })
})
