import { spawn as spawnProcess } from 'node:child_process'
import { recordLimit, type LimitCategory } from '../limits.js'
import type { UsageProbe, UsageProbeResult } from '../usagePoller.js'

type Child = {
  stdin: { write(data: string): void; end(): void }
  stdout: AsyncIterable<Uint8Array | string>
  kill(signal?: string): void
  exited: Promise<number>
}

type Spawn = (command: string[], options: Record<string, unknown>) => Child
export type CodexProbeChild = Child
export type CodexProbeSpawn = Spawn

const defaultSpawn: Spawn = (command, options) =>
  (() => {
    const process = spawnProcess(command[0]!, command.slice(1), {
      env: options.env as Record<string, string>,
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    return {
      stdin: process.stdin,
      stdout: process.stdout,
      kill: (signal?: string) =>
        process.kill(signal as NodeJS.Signals | undefined),
      exited: new Promise<number>((resolve) =>
        process.once('exit', (code) => resolve(code ?? 1)),
      ),
    }
  })()

const source = 'codex.app_server.read'
const timeoutError = (method: string) =>
  new Error(`Timed out waiting for ${method}`)

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  method: string,
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(timeoutError(method)), milliseconds)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function readReply(
  lines: AsyncIterator<Uint8Array | string>,
  id: number,
  milliseconds: number,
) {
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const next = await withTimeout(
      lines.next(),
      milliseconds,
      `RPC request ${id}`,
    )
    if (next.done)
      throw new Error(`Codex app-server exited before RPC request ${id}`)
    buffer +=
      typeof next.value === 'string' ? next.value : decoder.decode(next.value)
    const chunks = buffer.split('\n')
    buffer = chunks.pop() ?? ''
    for (const line of chunks) {
      try {
        const message = JSON.parse(line) as {
          id?: number
          result?: unknown
          error?: unknown
        }
        if (message.id !== id) continue
        if (message.error)
          throw new Error(`Codex RPC error: ${JSON.stringify(message.error)}`)
        return message.result as Record<string, any>
      } catch (error) {
        if (error instanceof SyntaxError) continue
        throw error
      }
    }
  }
}

function windowLabel(minutes: number) {
  if (minutes === 10080) return { key: 'weekly-7d', label: 'Weekly (7-day)' }
  if (minutes % 60 === 0) {
    const hours = minutes / 60
    return { key: `${hours}h`, label: `${hours}h window` }
  }
  return { key: `${minutes}m`, label: `${minutes}m window` }
}

function classifyLimits(
  type: unknown,
  spendControlReached: unknown,
): LimitCategory[] {
  const categories: LimitCategory[] = []
  if (typeof type === 'string') {
    const normalized = type.toLowerCase().replaceAll('-', '_')
    if (normalized.includes('credit') || normalized.includes('spend'))
      categories.push('spend-limit')
    else if (normalized.includes('rate_limit') || normalized.includes('usage'))
      categories.push('usage-limit')
  }
  if (spendControlReached === true && !categories.includes('spend-limit'))
    categories.push('spend-limit')
  return categories
}

export function makeCodexUsageProbe(spawn: Spawn = defaultSpawn): UsageProbe {
  return async ({
    accountId,
    harnessKey,
    homePath,
    env,
    db,
  }): Promise<UsageProbeResult> => {
    let child: Child | undefined
    try {
      child = spawn(
        ['codex', '-s', 'read-only', '-a', 'untrusted', 'app-server'],
        {
          env: { ...process.env, ...env, CODEX_HOME: homePath },
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'ignore',
        },
      )
      const activeChild = child
      const lines = activeChild.stdout[Symbol.asyncIterator]()
      const send = (
        id: number,
        method: string,
        params?: Record<string, unknown>,
      ) => {
        child!.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`,
        )
        return readReply(lines, id, id === 1 ? 8000 : 4000)
      }
      await send(1, 'initialize', {
        clientInfo: { name: 'forge-usage', version: '1' },
      })
      activeChild.stdin.write(
        '{"jsonrpc":"2.0","method":"initialized","params":{}}\n',
      )
      const account = await send(2, 'account/read')
      const rateLimits = await send(3, 'account/rateLimits/read')
      const limits = rateLimits.rateLimits ?? rateLimits
      const windows = [limits.primary, limits.secondary]
        .filter(
          (window): window is Record<string, any> =>
            Boolean(window) && window.usedPercent != null,
        )
        .map((window) => {
          const duration = Number(window.windowDurationMins)
          const label = windowLabel(duration)
          return {
            windowKey: label.key,
            label: label.label,
            percent:
              Math.max(0, Math.min(100, Number(window.usedPercent))) / 100,
            resetsAt:
              typeof window.resetsAt === 'number'
                ? window.resetsAt * 1000
                : null,
            source,
          }
        })
      const categories = classifyLimits(
        limits.rateLimitReachedType,
        limits.spendControlReached,
      )
      for (const category of categories) {
        recordLimit(db, {
          accountId,
          kind: category,
          harnessKey,
          detectedAt: Date.now(),
          source,
          detail: String(
            limits.rateLimitReachedType ?? 'spend control reached',
          ),
        })
      }
      const accountData = account.account ?? account
      return {
        status: 'ok',
        tierLabel: limits.planType ?? accountData.planType ?? accountData.type,
        windows,
      }
    } catch (error) {
      return {
        status: 'unavailable',
        windows: [],
        detail: error instanceof Error ? error.message : String(error),
        retryAdvised: false,
      }
    } finally {
      if (child) {
        child.stdin.end()
        child.kill('SIGTERM')
        await Promise.race([
          child.exited,
          new Promise((resolve) => setTimeout(resolve, 1000)),
        ])
        child.kill('SIGKILL')
      }
    }
  }
}

export const codexUsageProbe = makeCodexUsageProbe()
