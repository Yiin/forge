import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { gitHistory } from './history.js'
const exec = promisify(execFile)
it('pins pages to the original ref and filters real commit subjects', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'forge-history-'))
  const git = (...args: string[]) => exec('git', args, { cwd })
  try {
    await git('init', '-b', 'main')
    await git('config', 'user.name', 'Fixture')
    await git('config', 'user.email', 'fixture@example.invalid')
    const commit = async (name: string) => {
      await writeFile(join(cwd, 'file'), name)
      await git('add', 'file')
      await git('commit', '-m', name)
    }
    await commit('first needle')
    await commit('second')
    await commit('third needle')
    const first = await gitHistory({ cwd, limit: 1 })
    expect(first.commits).toHaveLength(1)
    expect(first.nextCursor).not.toBeNull()
    expect(first.commits[0]!.sha).toMatch(/^[a-f0-9]{40}$/)
    await commit('new moving head')
    const second = await gitHistory({
      cwd,
      limit: 1,
      cursor: first.nextCursor!,
    })
    expect(second.revision).toBe(first.revision)
    expect(second.commits[0]!.subject).toBe('second')
    expect(second.commits[0]!.sha).not.toBe(first.commits[0]!.sha)
    expect(
      (await gitHistory({ cwd, query: 'needle' })).commits.map(
        (commit) => commit.subject,
      ),
    ).toEqual(['third needle', 'first needle'])
    await expect(
      gitHistory({ cwd, cursor: first.nextCursor!, query: 'different' }),
    ).rejects.toThrow('filters changed')
    await expect(gitHistory({ cwd, cursor: 'invalid' })).rejects.toThrow(
      'Invalid history cursor',
    )
    const missing = Buffer.from(
      JSON.stringify({
        version: 1,
        tip: 'f'.repeat(40),
        offset: 1,
        ref: 'HEAD',
        query: '',
      }),
    ).toString('base64url')
    await expect(gitHistory({ cwd, cursor: missing })).rejects.toThrow()
    await expect(gitHistory({ cwd, ref: '--all' })).rejects.toThrow(
      'Invalid history filter',
    )
    await git('branch', 'older', second.commits[0]!.sha)
    expect((await gitHistory({ cwd, ref: 'older' })).commits[0]!.subject).toBe(
      'second',
    )
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
