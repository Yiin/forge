import { describe, expect, test } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { gitStatus, listRefs } from './repo.js'

const exec = promisify(execFile)
async function git(cwd: string, ...args: string[]) {
  await exec('git', args, { cwd })
}

describe('git repo readers', () => {
  test('reads status, worktrees, filters, and pages refs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-git-'))
    const worktree = `${root}-worktree`
    try {
      await git(root, 'init', '-b', 'main')
      await git(root, 'config', 'user.email', 'test@example.com')
      await git(root, 'config', 'user.name', 'Test')
      await writeFile(join(root, 'file'), 'one')
      await git(root, 'add', '.')
      await git(root, 'commit', '-m', 'first')
      await git(root, 'branch', 'feature/demo')
      await git(root, 'worktree', 'add', worktree, 'feature/demo')
      const status = await gitStatus(root)
      expect(status).toMatchObject({ isRepo: true, branch: 'main', detached: false })
      const page = await listRefs(root, { limit: 1 })
      expect(page.totalCount).toBe(2)
      expect(page.nextCursor).toBe(1)
      expect(page.refs[0]?.name).toBe('main')
      expect((await listRefs(root, { query: 'FEATURE' })).refs[0]?.worktreePath).toBe(worktree)
      expect(await gitStatus(join(root, 'missing'))).toMatchObject({ isRepo: false })
    } finally {
      await rm(worktree, { recursive: true, force: true })
      await rm(root, { recursive: true, force: true })
    }
  })
})
