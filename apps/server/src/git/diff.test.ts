import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runGit } from './exec.js'
import { gitDiff } from './diff.js'
import { captureTurnSnapshot, latestTurnSnapshot } from './turnSnapshots.js'
import { migrate } from '../db/migrate.js'
import { createProject, createSession } from '../db/queries.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function repo() {
  const root = await mkdtemp(join('/tmp', 'forge-git-review-'))
  await runGit(root, ['init', '-b', 'main'])
  await runGit(root, ['config', 'user.email', 'test@example.test'])
  await runGit(root, ['config', 'user.name', 'Test'])
  await writeFile(join(root, 'tracked.txt'), 'one\n')
  await runGit(root, ['add', '--', 'tracked.txt'])
  await runGit(root, ['commit', '-m', 'initial'])
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

describe('Git review and turn snapshots', () => {
  it('reports staged, unstaged, deleted, and untracked files without external diff settings', async () => {
    const root = await repo()
    await writeFile(join(root, 'tracked.txt'), 'one\ntwo\n')
    await runGit(root, ['add', '--', 'tracked.txt'])
    await rm(join(root, 'tracked.txt'))
    await writeFile(join(root, 'new.txt'), 'new\n')
    const result = await gitDiff({ cwd: root, scope: 'working' })
    expect(result.files.map((file) => file.status).sort()).toEqual([
      'added',
      'deleted',
    ])
    expect(result.files.some((file) => file.newPath === 'new.txt')).toBe(true)
    expect(result.files.some((file) => file.oldPath === 'tracked.txt')).toBe(
      true,
    )
  })

  it('captures the checkout into an isolated index and keeps the real index unchanged', async () => {
    const root = await repo()
    await writeFile(join(root, 'before.txt'), 'before\n')
    const indexBefore = await readFile(join(root, '.git', 'index'))
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const project = createProject(db, { name: 'Review', path: root })
    const session = createSession(db, {
      projectId: project.id,
      cwd: root,
      harness: 'test',
      title: 'Review',
    })
    const snapshot = await captureTurnSnapshot({
      db,
      sessionId: session.id,
      turnId: 'turn-1',
    })
    expect(snapshot.state).toBe('ready')
    expect(snapshot.treeId).toMatch(/^[0-9a-f]{40}$/)
    expect(await readFile(join(root, '.git', 'index'))).toEqual(indexBefore)
    await writeFile(join(root, 'after.txt'), 'after\n')
    const result = await gitDiff({ cwd: root, scope: 'working' })
    expect(result.files.some((file) => file.newPath === 'after.txt')).toBe(true)
    expect(latestTurnSnapshot(db, session.id)?.treeId).toBe(snapshot.treeId)
    db.close()
  })
})
