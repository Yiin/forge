import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { runGit } from './exec.js'
import { groupHasRunningMember } from '../harnesses/process-group.js'

async function waitPid(path: string) {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const id = Number(await readFile(path, 'utf8').catch(() => ''))
    if (id) return id
    await delay(5)
  }
  throw new Error('Git alias did not start')
}

describe('owned Git process cleanup', () => {
  it.each(['timeout', 'abort', 'output', 'leader exit'])(
    'bounds %s with a descendant that retains the output pipes',
    async (mode) => {
      const dir = await mkdtemp(join(tmpdir(), 'forge-git-cleanup-'))
      const pidPath = join(dir, 'child.pid')
      const controller = new AbortController()
      let pid: number | undefined
      let group: number | undefined
      let pending: Promise<unknown> | undefined
      try {
        // Command-local alias only. The child ignores TERM to exercise group KILL.
        const alias = `!sh -c 'trap "" TERM; echo $$ > "${pidPath}"; sleep 30' & ${mode === 'leader exit' ? 'sleep 0.15; exit 0' : mode === 'output' ? 'sleep 0.1; yes overflow' : 'wait'}`
        const start = performance.now()
        pending = runGit(
          dir,
          ['-c', `alias.fixture=${alias}`, 'fixture'],
          true,
          {
            signal: controller.signal,
            timeoutMs: mode === 'timeout' ? 300 : 3000,
            maxOutputBytes: mode === 'output' ? 1024 : undefined,
          },
        ).then(
          (value) => value,
          (error) => error,
        )
        pid = await waitPid(pidPath)
        const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
        group = Number(fields[2])
        if (mode === 'abort') controller.abort()
        const result = await pending
        expect(performance.now() - start).toBeLessThan(2200)
        if (mode === 'leader exit') expect(result).toMatchObject({ code: 0 })
        else expect(result).toBeInstanceOf(Error)
        expect(
          await groupHasRunningMember(group, performance.now() + 1000),
        ).toBe(false)
      } finally {
        controller.abort()
        if (group) {
          try {
            process.kill(-group, 'SIGKILL')
          } catch {
            /* Owned group already exited. */
          }
        } else if (pid) {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            /* Owned child already exited. */
          }
        }
        await pending
        await rm(dir, { recursive: true, force: true })
      }
    },
    6000,
  )
  it('keeps checked and unchecked failures, final output, and input/output bounds', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-git-results-'))
    try {
      expect(
        await runGit(join(dir, 'missing'), ['status'], false),
      ).toMatchObject({ code: 1 })
      await expect(
        runGit(join(dir, 'missing'), ['status']),
      ).rejects.toBeInstanceOf(Error)
      expect(
        await runGit(dir, ['rev-parse', '--git-dir'], false),
      ).toMatchObject({ code: 128 })
      await expect(
        runGit(dir, ['rev-parse', '--git-dir']),
      ).rejects.toBeInstanceOf(Error)
      await expect(
        runGit(dir, ['--version'], true, {
          stdin: 'oversized',
          maxOutputBytes: 1,
        }),
      ).rejects.toThrow('Git input limit exceeded')
      const result = await runGit(dir, [
        '-c',
        'alias.last=!printf final; printf diagnostic >&2',
        'last',
      ])
      expect(result).toMatchObject({
        stdout: 'final',
        stderr: 'diagnostic',
        code: 0,
      })
      const large = await runGit(dir, [
        '-c',
        'alias.large=!head -c 500000 /dev/zero',
        'large',
      ])
      expect(large.stdout.length).toBe(500000)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
