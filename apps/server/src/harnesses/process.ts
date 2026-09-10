import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { redactSecrets } from './jsonl.js'

export type NativeProcessOptions = {
  command: string
  args?: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  secrets?: readonly string[]
  stderrLimit?: number
}

/** Owns a native provider process and its process group. */
export class NativeProcess {
  readonly child!: ChildProcess
  readonly stderr: Promise<string>
  private closing?: Promise<void>
  private stderrText = ''

  constructor(options: NativeProcessOptions) {
    this.child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    const limit = options.stderrLimit ?? 64 * 1024
    const secrets = options.secrets ?? []
    this.stderr = (async () => {
      if (!this.child.stderr) return ''
      for await (const chunk of this.child.stderr) {
        this.stderrText = (this.stderrText + String(chunk)).slice(-limit)
      }
      return redactSecrets(this.stderrText, secrets)
    })()
  }

  async close(graceMs = 500) {
    if (this.closing) return this.closing
    this.closing = (async () => {
      if (this.child.exitCode == null && this.child.signalCode == null) {
        const pid = this.child.pid
        try {
          if (pid)
            process.kill(process.platform === 'win32' ? pid : -pid, 'SIGTERM')
        } catch {
          // The child can exit between the status check and the signal.
        }
        const exited = once(this.child, 'exit')
        try {
          await Promise.race([
            exited,
            new Promise((resolve) => setTimeout(resolve, graceMs)),
          ])
        } catch {
          /* already exited */
        }
      }
      if (this.child.exitCode == null && this.child.signalCode == null) {
        const pid = this.child.pid
        try {
          if (pid)
            process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL')
        } catch {
          // The graceful signal may have reaped the process already.
        }
        await once(this.child, 'exit').catch(() => undefined)
      }
    })()
    return this.closing
  }
}

export function spawnNativeProcess(options: NativeProcessOptions) {
  return new NativeProcess(options)
}
