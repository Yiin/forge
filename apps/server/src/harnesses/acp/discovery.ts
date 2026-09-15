import { startNativeProcess, type NativeProcess } from '../process.js'
import { diagnosticError } from '../diagnostics.js'
import { digest, immutableData } from './data.js'
import type { AcpResourceHost } from './limits.js'
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
  onCreated: (runtime: NativeProcess) => void,
  signal: AbortSignal,
  onFailure: (error: Error) => void,
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
      onCreated,
    },
    async (runtime) => {
      const closed = new Promise<number | null>((resolve) =>
        runtime.child.once('close', (code) => resolve(code)),
      )
      runtime.child.stdout.on('data', (chunk: Buffer) => {
        count += chunk.length
        if (count > 1024 * 1024) {
          failure ??= new Error('ACP discovery output exceeds limit')
          onFailure(failure)
        } else chunks.push(Buffer.from(chunk))
      })
      runtime.child.stdin.end()
      return { closed }
    },
  )
  const code = await started.value.closed
  if (failure) throw failure
  return {
    code,
    stdout: Buffer.concat(chunks).toString('utf8'),
    stderr: started.process.diagnostics,
  }
}

type SharedProbe = {
  promise: Promise<AcpAvailability>
  waiters: number
  settled: boolean
  owner?: NativeProcess
}
const probes = new WeakMap<AcpResourceHost, Map<string, SharedProbe>>()

export function createAcpDiscovery(
  profile: AcpProfile,
  input: AcpLaunch,
  host: AcpResourceHost,
) {
  const launch = captureLaunch(profile, input)
  const key = digest({ profile, launch })
  let shared = probes.get(host)
  if (!shared) probes.set(host, (shared = new Map()))
  const operations = shared
  return {
    refresh(cwd: string): Promise<AcpAvailability> {
      const existing = operations.get(key)
      if (existing) {
        if (existing.settled) return existing.promise
        if (existing.waiters >= 32)
          return Promise.reject(new Error('ACP discovery waiter limit'))
        existing.waiters++
        return existing.promise
      }
      const failed = (
        error: unknown,
        executable: string | null = null,
      ): AcpAvailability => ({
        status: 'failed',
        authentication: 'unknown',
        executable,
        models: [],
        error: diagnosticError(error, launch.secrets).message,
      })
      let releaseDiscovery: () => void
      try {
        releaseDiscovery = host.reserve(launch.providerInstanceId, 'discovery')
      } catch (error) {
        return Promise.resolve(immutableData(failed(error)))
      }
      let resolve!: (value: AcpAvailability) => void
      const entry: SharedProbe = {
        promise: new Promise((done) => {
          resolve = done
        }),
        waiters: 1,
        settled: false,
      }
      // Publish the owner before executable resolution or native startup can reenter.
      operations.set(key, entry)
      let cleanupFailed = false
      let executable: string | null = null
      let cleanup: Promise<void> | undefined
      const controller = new AbortController()
      const settle = (value: AcpAvailability) => {
        if (entry.settled) return
        try {
          resolve(immutableData(value))
        } catch (error) {
          resolve(failed(error))
        }
        entry.waiters = 0
        entry.settled = true
      }
      const closeOwner = () => {
        if (!entry.owner) return Promise.resolve()
        if (!cleanup) {
          // Register cleanup before an external close callback can reenter.
          cleanup = Promise.resolve().then(() => entry.owner!.close())
          void cleanup.catch((error) => {
            cleanupFailed = true
            settle(failed(error, executable))
          })
        }
        return cleanup
      }
      const fail = (error: Error) => {
        settle(failed(error, executable))
        controller.abort()
        void closeOwner().catch(() => {})
      }
      const timeout = setTimeout(
        () => fail(new Error('ACP discovery timed out')),
        15000,
      )
      const operation = (async (): Promise<AcpAvailability> => {
        let releaseProcess: (() => void) | undefined
        try {
          executable = await resolveExecutable(launch)
          if (controller.signal.aborted) throw Error('ACP discovery timed out')
          if (!executable)
            return {
              status: 'missing',
              authentication: 'unknown',
              executable,
              models: [],
            }
          if (profile !== 'devin' && profile !== 'hermes')
            return {
              status: 'unverified',
              authentication: 'unknown',
              executable,
              models: [],
            }
          releaseProcess = host.reserve(launch.providerInstanceId, 'processes')
          const result = await probe(
            launch,
            executable,
            profile === 'devin'
              ? ['models', 'list', '--format', 'json']
              : ['acp', '--check'],
            cwd,
            (runtime) => {
              entry.owner = runtime
              if (controller.signal.aborted) void closeOwner().catch(() => {})
            },
            controller.signal,
            fail,
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
        } finally {
          if (entry.owner) {
            try {
              await closeOwner()
            } catch {
              cleanupFailed = true
            }
          }
          clearTimeout(timeout)
          if (!cleanupFailed) {
            releaseProcess?.()
            releaseDiscovery()
            entry.owner = undefined
            operations.delete(key)
          }
          // A refused cleanup keeps the exact operation and its physical leases.
          // It must not admit a replacement process under the same fingerprint.
        }
      })()
      void operation.then(settle, (error) => settle(failed(error)))
      return entry.promise
    },
  }
}
