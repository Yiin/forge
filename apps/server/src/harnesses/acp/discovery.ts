import { startNativeProcess } from '../process.js'
import { diagnosticError } from '../diagnostics.js'
import {
  captureLaunch,
  parseDevinModels,
  resolveExecutable,
  type AcpLaunch,
  type AcpProfile,
} from './profiles.js'

export type AcpAvailability = {
  status:
    'missing' | 'unverified' | 'available' | 'missing-acp-extra' | 'failed'
  authentication: 'unknown'
  executable: string | null
  models: Array<{ id: string; displayName: string; description?: string }>
  error?: string
}

async function probe(
  launch: AcpLaunch,
  command: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
) {
  let failure: Error | undefined
  let count = 0
  const chunks: Buffer[] = []
  const started = await startNativeProcess(
    {
      command,
      args,
      cwd,
      env: launch.env,
      inheritEnv: false,
      secrets: launch.secrets,
      signal,
    },
    async (runtime) => {
      const closed = new Promise<number | null>((resolve) =>
        runtime.child.once('close', (code) => resolve(code)),
      )
      runtime.child.stdout.on('data', (chunk: Buffer) => {
        count += chunk.length
        if (count > 1024 * 1024) {
          failure ??= new Error('ACP discovery output exceeds limit')
          void runtime.close(failure).catch((error) => {
            failure = error
          })
        } else chunks.push(Buffer.from(chunk))
      })
      runtime.child.stdin.end()
      return { closed }
    },
  )
  const timeout = setTimeout(() => {
    failure ??= new Error('ACP discovery timed out')
    void started.process.close(failure).catch((error) => {
      failure = error
    })
  }, 10000)
  try {
    const code = await started.value.closed
    await started.process.close()
    if (failure) throw failure
    return {
      code,
      stdout: Buffer.concat(chunks).toString('utf8'),
      stderr: started.process.diagnostics,
    }
  } finally {
    clearTimeout(timeout)
    await started.process.close()
  }
}

export function createAcpDiscovery(profile: AcpProfile, input: AcpLaunch) {
  const launch = captureLaunch(profile, input)
  let overlapping: Promise<AcpAvailability> | undefined
  return {
    refresh(cwd: string): Promise<AcpAvailability> {
      const existing = overlapping
      if (existing) return existing
      const operation = (async (): Promise<AcpAvailability> => {
        const executable = await resolveExecutable(launch)
        if (!executable)
          return {
            status: 'missing',
            authentication: 'unknown',
            executable: null,
            models: [],
          }
        if (profile !== 'devin' && profile !== 'hermes')
          return {
            status: 'unverified',
            authentication: 'unknown',
            executable,
            models: [],
          }
        try {
          const result = await probe(
            launch,
            executable,
            profile === 'devin'
              ? ['models', 'list', '--format', 'json']
              : ['acp', '--check'],
            cwd,
          )
          if (result.code !== 0) {
            const missing =
              profile === 'hermes' &&
              /No module named ['"]acp['"]|ACP dependencies.*not installed|ACP extra/i.test(
                result.stderr,
              )
            return {
              status: missing ? 'missing-acp-extra' : 'failed',
              authentication: 'unknown',
              executable,
              models: [],
              error: result.stderr || 'ACP discovery failed',
            }
          }
          return {
            status: profile === 'hermes' ? 'available' : 'unverified',
            authentication: 'unknown',
            executable,
            models:
              profile === 'devin'
                ? parseDevinModels(JSON.parse(result.stdout))
                : [],
          }
        } catch (error) {
          return {
            status: 'failed',
            authentication: 'unknown',
            executable,
            models: [],
            error: diagnosticError(error, launch.secrets).message,
          }
        }
      })()
      overlapping = operation
      void operation
        .finally(() => {
          overlapping = undefined
        })
        .catch(() => {})
      return operation
    },
  }
}
