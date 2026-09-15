import { spawn } from 'node:child_process'
import {
  signalProcessGroup,
  waitForProcessGroupExit,
} from '../harnesses/process-group.js'

export type GitOptions = {
  stdin?: string
  signal?: AbortSignal
  timeoutMs?: number
  maxOutputBytes?: number
  readOnly?: boolean
  env?: NodeJS.ProcessEnv
}

/** Bounded streams stay separate for machine output. `output` preserves existing callers. */
export async function runGit(
  cwd: string,
  args: string[],
  check = true,
  options: GitOptions = {},
): Promise<{ output: string; stdout: string; stderr: string; code: number }> {
  const limit = options.maxOutputBytes ?? 16 * 1024 * 1024
  if (Buffer.byteLength(options.stdin ?? '') > limit)
    throw new Error('Git input limit exceeded')
  options.signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const group = process.platform !== 'win32'
    const child = spawn('git', args, {
      cwd,
      detached: group,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(options.readOnly ? { GIT_OPTIONAL_LOCKS: '0' } : {}),
        ...options.env,
      },
    })
    const stdout: Buffer[] = [],
      stderr: Buffer[] = []
    let size = 0,
      code = 1,
      closed = false,
      settled = false
    let failure: Error | undefined
    let spawnFailure = false
    let cleanup: Promise<void> | undefined
    let drainTimer: ReturnType<typeof setTimeout> | undefined
    const terminate = () =>
      (cleanup ??= Promise.resolve().then(async () => {
        if (!child.pid) return
        if (group) {
          signalProcessGroup(child.pid, 'SIGKILL')
          await waitForProcessGroupExit(child.pid, performance.now() + 1000)
        } else child.kill('SIGKILL')
      }))
    const finish = async () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(drainTimer)
      options.signal?.removeEventListener('abort', abort)
      try {
        await terminate()
      } catch (error) {
        failure ??= error as Error
      }
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
      const out = Buffer.concat(stdout).toString('utf8'),
        err = Buffer.concat(stderr).toString('utf8')
      if (failure && spawnFailure && !check)
        resolve({ output: out + err, stdout: out, stderr: err, code: 1 })
      else if (failure) reject(failure)
      else if (check && code !== 0)
        reject(
          new Error(`git ${args.join(' ')} failed (${code}): ${out}${err}`),
        )
      else resolve({ output: out + err, stdout: out, stderr: err, code })
    }
    const stop = (error: Error) => {
      failure ??= error
      void finish()
    }
    const abort = () => stop(new Error('Git operation interrupted'))
    options.signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(
      () => stop(new Error('Git operation timed out')),
      options.timeoutMs ?? (options.readOnly ? 6000 : 60_000),
    )
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > limit) stop(new Error('Git output limit exceeded'))
      else chunks.push(chunk)
    }
    child.stdout.on('data', collect(stdout))
    child.stderr.on('data', collect(stderr))
    child.stdout.on('error', stop)
    child.stderr.on('error', stop)
    child.on('error', (error) => {
      spawnFailure = !failure
      stop(error)
    })
    child.stdin.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EPIPE') stop(error)
    })
    child.on('exit', (exitCode) => {
      code = exitCode ?? 1
      if (settled) return
      // The leader can exit while a hook or helper still retains its output pipes.
      void terminate().catch(stop)
      if (!closed)
        drainTimer = setTimeout(
          () => stop(new Error('Git output did not close')),
          1000,
        )
    })
    child.on('close', (exitCode) => {
      closed = true
      code = exitCode ?? 1
      void finish()
    })
    if (options.signal?.aborted) abort()
    if (!settled) child.stdin.end(options.stdin)
  })
}
