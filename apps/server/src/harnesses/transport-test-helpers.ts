import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, expect } from 'vitest'
import {
  startNativeProcess,
  type NativeProcess,
  type NativeProcessOptions,
} from './process.js'

export const fixture = fileURLToPath(
  new URL('./fixtures/native-child.mjs', import.meta.url),
)
const owned = new Set<NativeProcess>()
afterEach(async () => {
  const failures: unknown[] = []
  for (const runtime of owned) {
    try {
      await runtime.close()
      owned.delete(runtime)
    } catch (error) {
      // Keep failed owners registered. The next cleanup pass can retry them,
      // and the failure remains visible instead of being silently discarded.
      failures.push(error)
    }
  }
  if (failures.length)
    throw new AggregateError(failures, 'Native process cleanup failed')
})

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

export function startFixture<T>(
  mode: string,
  initialize: (runtime: NativeProcess) => Promise<T>,
  options: Partial<NativeProcessOptions> = {},
  payload = '',
) {
  return startNativeProcess(
    {
      command: process.execPath,
      args: [fixture, mode, payload],
      killGraceMs: 40,
      startupTimeoutMs: 2000,
      ...options,
    },
    async (runtime) => {
      owned.add(runtime)
      return initialize(runtime)
    },
  )
}

export const bytePayload = (chunks: Buffer[], end = true) =>
  JSON.stringify({
    chunks: chunks.map((chunk) => chunk.toString('base64')),
    end,
  })

export async function running(pid: number): Promise<boolean> {
  try {
    if (process.platform === 'linux') {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z'
    }
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function expectStopped(pid: number) {
  for (let attempt = 0; attempt < 100 && (await running(pid)); attempt++)
    await delay(10)
  expect(await running(pid)).toBe(false)
}
