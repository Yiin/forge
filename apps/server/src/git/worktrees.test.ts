import { describe, expect, test } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  listWorktrees,
  provisionWorktree,
  removeWorktree,
  worktreePathFor,
  MAX_SESSION_WORKTREES_PER_PROJECT,
  WorktreeLimitError,
} from './worktrees.js'
import { runGit } from './exec.js'

describe('git worktrees', () => {
  test('provisions, lists, and removes worktrees outside the repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-worktrees-'))
    const repo = join(root, 'repo')
    const dataDir = join(root, 'data')
    await mkdir(repo)
    try {
      await runGit(repo, ['init', '-b', 'main'])
      await runGit(repo, ['config', 'user.email', 'forge@example.test'])
      await runGit(repo, ['config', 'user.name', 'Forge'])
      await writeFile(join(repo, 'README'), 'test')
      await runGit(repo, ['add', '.'])
      await runGit(repo, ['commit', '-m', 'initial'])

      expect(worktreePathFor(dataDir, 'project', 'feature/demo')).toBe(
        join(dataDir, 'worktrees', 'project', 'feature-demo'),
      )
      expect(
        worktreePathFor(dataDir, 'project', 'feature/demo').startsWith(repo),
      ).toBe(false)
      const created = await provisionWorktree({
        repoPath: repo,
        dataDir,
        projectId: 'project',
        baseRef: 'main',
      })
      expect(created.branch).toMatch(/^forge\/[a-f0-9]{8}$/)
      expect(created.path).toContain(join(dataDir, 'worktrees', 'project'))
      expect(
        (await listWorktrees(repo)).find(
          (worktree) => worktree.path === created.path,
        ),
      ).toMatchObject({ branch: created.branch, detached: false })
      await expect(
        provisionWorktree({
          repoPath: repo,
          dataDir,
          projectId: 'project',
          baseRef: 'main',
          branch: created.branch,
        }),
      ).rejects.toThrow(`Worktree target already exists: ${created.path}`)

      await runGit(repo, ['branch', 'existing'])
      const existing = await provisionWorktree({
        repoPath: repo,
        dataDir,
        projectId: 'project',
        baseRef: 'main',
        branch: 'existing',
      })
      expect(existing.branch).toBe('existing')
      await removeWorktree(repo, existing.path)
      expect(
        (await listWorktrees(repo)).some(
          (worktree) => worktree.path === existing.path,
        ),
      ).toBe(false)
      await removeWorktree(repo, created.path)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('caps session worktrees per project and restores capacity after removal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-worktree-cap-'))
    const repo = join(root, 'repo')
    const dataDir = join(root, 'data')
    await mkdir(repo)
    try {
      await runGit(repo, ['init', '-b', 'main'])
      await runGit(repo, ['config', 'user.email', 'forge@example.test'])
      await runGit(repo, ['config', 'user.name', 'Forge'])
      await writeFile(join(repo, 'README'), 'test')
      await runGit(repo, ['add', '.'])
      await runGit(repo, ['commit', '-m', 'initial'])

      const created = []
      for (let index = 0; index < MAX_SESSION_WORKTREES_PER_PROJECT; index++)
        created.push(
          await provisionWorktree({
            repoPath: repo,
            dataDir,
            projectId: 'project',
            baseRef: 'main',
            branch: `feature/${index}`,
          }),
        )
      await expect(
        provisionWorktree({
          repoPath: repo,
          dataDir,
          projectId: 'project',
          baseRef: 'main',
          branch: 'feature/17',
        }),
      ).rejects.toBeInstanceOf(WorktreeLimitError)

      await removeWorktree(repo, created[0].path)
      await expect(
        provisionWorktree({
          repoPath: repo,
          dataDir,
          projectId: 'project',
          baseRef: 'main',
          branch: 'feature/reused',
        }),
      ).resolves.toMatchObject({ branch: 'feature/reused' })
      for (const worktree of created.slice(1))
        await removeWorktree(repo, worktree.path)
      await removeWorktree(
        repo,
        worktreePathFor(dataDir, 'project', 'feature/reused'),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
