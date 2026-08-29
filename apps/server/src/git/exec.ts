import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

declare const Bun: {
  spawn(
    command: string[],
    options: { cwd: string; stdout: 'pipe'; stderr: 'pipe' },
  ): {
    stdout: ReadableStream<Uint8Array>
    stderr: ReadableStream<Uint8Array>
    exited: Promise<number>
  }
}

const nodeExec = promisify(execFile)

export async function runGit(
  cwd: string,
  args: string[],
  check = true,
): Promise<{ output: string; code: number }> {
  const bun = (globalThis as typeof globalThis & { Bun?: typeof Bun }).Bun
  if (!bun) {
    try {
      const result = await nodeExec('git', args, { cwd })
      return { output: result.stdout + result.stderr, code: 0 }
    } catch (error) {
      const failure = error as {
        stdout?: string
        stderr?: string
        code?: number
      }
      const output = (failure.stdout ?? '') + (failure.stderr ?? '')
      if (check)
        throw new Error(
          `git ${args.join(' ')} failed (${failure.code ?? 1}): ${output}`,
        )
      return { output, code: failure.code ?? 1 }
    }
  }
  const proc = bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const output = stdout + stderr
  if (check && code !== 0)
    throw new Error(`git ${args.join(' ')} failed (${code}): ${output}`)
  return { output, code }
}
