import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ContextWindowUsage } from '@forge/protocol/events'

export type RawCodexRateLimits = {
  primary?: RawCodexRateLimit | null
  secondary?: RawCodexRateLimit | null
}

type RawCodexRateLimit = {
  used_percent?: unknown
  window_minutes?: unknown
  resets_at?: unknown
}

type Input = {
  homePath: string
  cwd: string
  providerSessionId: string | null
}

type Result = {
  usage?: ContextWindowUsage
  rateLimits?: RawCodexRateLimits
}

function filesIn(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name)
      return entry.isDirectory() ? filesIn(path) : [path]
    })
  } catch {
    return []
  }
}

function sessionMetaCwd(line: string): string | undefined {
  try {
    const value = JSON.parse(line) as {
      type?: unknown
      payload?: { type?: unknown; cwd?: unknown; payload?: { cwd?: unknown } }
      cwd?: unknown
    }
    if (value.type !== 'session_meta' && value.payload?.type !== 'session_meta')
      return undefined
    const payload = value.payload
    const cwd = payload?.cwd ?? payload?.payload?.cwd ?? value.cwd
    return typeof cwd === 'string' ? cwd : undefined
  } catch {
    return undefined
  }
}

function tokenCount(line: string) {
  try {
    const value = JSON.parse(line) as {
      type?: unknown
      payload?: {
        type?: unknown
        info?: Record<string, unknown>
        rate_limits?: unknown
      }
    }
    const payload = value.payload
    if (value.type !== 'event_msg' || payload?.type !== 'token_count')
      return undefined
    return { info: payload.info, rateLimits: payload.rate_limits }
  } catch {
    return undefined
  }
}

function findRollout(input: Input): string | undefined {
  const directory = join(input.homePath, 'sessions')
  const files = filesIn(directory).filter((file) => file.endsWith('.jsonl'))
  const suffix = input.providerSessionId
    ? `-${input.providerSessionId}.jsonl`
    : undefined
  if (suffix) {
    const exact = files.find((file) => file.endsWith(suffix))
    if (exact) {
      console.debug('codex rollout: provider session filename match', exact)
      return exact
    }
  }
  const matching = files
    .map((file) => {
      try {
        const firstLine = readFileSync(file, 'utf8').split('\n', 1)[0] ?? ''
        return sessionMetaCwd(firstLine) === input.cwd
          ? { file, mtime: statSync(file).mtimeMs }
          : undefined
      } catch {
        return undefined
      }
    })
    .filter(
      (value): value is { file: string; mtime: number } => value !== undefined,
    )
    .sort((a, b) => b.mtime - a.mtime)[0]
  if (matching) {
    console.debug('codex rollout: cwd session_meta match', matching.file)
    return matching.file
  }
  console.debug('codex rollout: no matching file', input.cwd)
  return undefined
}

function usageFrom(
  info: Record<string, unknown> | undefined,
): ContextWindowUsage | undefined {
  if (!info) return undefined
  const last = info.last_token_usage
  const total = info.total_token_usage
  if (!last || typeof last !== 'object') return undefined
  const usedTokens = (last as { total_tokens?: unknown }).total_tokens
  if (
    typeof usedTokens !== 'number' ||
    !Number.isInteger(usedTokens) ||
    usedTokens <= 0
  )
    return undefined
  const result: ContextWindowUsage = {
    usedTokens,
    compactsAutomatically: true,
    source: 'codex.rollout',
    observedAt: Date.now(),
  }
  const fields = [
    ['inputTokens', 'input_tokens'],
    ['cachedInputTokens', 'cached_input_tokens'],
    ['outputTokens', 'output_tokens'],
    ['reasoningOutputTokens', 'reasoning_output_tokens'],
  ] as const
  for (const [target, source] of fields) {
    const value = (last as Record<string, unknown>)[source]
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0)
      result[target] = value
  }
  const maxTokens = info.model_context_window
  if (
    typeof maxTokens === 'number' &&
    Number.isInteger(maxTokens) &&
    maxTokens > 0
  )
    result.maxTokens = maxTokens
  const totalTokens =
    total && typeof total === 'object'
      ? (total as { total_tokens?: unknown }).total_tokens
      : undefined
  if (typeof totalTokens === 'number' && totalTokens > usedTokens)
    result.totalProcessedTokens = totalTokens
  return result
}

function parseRateLimits(value: unknown): RawCodexRateLimits | undefined {
  if (!value || typeof value !== 'object') return undefined
  return value as RawCodexRateLimits
}

export function readCodexRollout(input: Input): Result | undefined {
  const file = findRollout(input)
  if (!file) return undefined
  let lines: string[]
  try {
    lines = readFileSync(file, 'utf8').trimEnd().split('\n')
  } catch {
    return undefined
  }
  for (let index = lines.length - 1; index >= 0; index--) {
    const event = tokenCount(lines[index]!)
    if (!event) continue
    const usage = usageFrom(event.info)
    if (!usage) return undefined
    const rateLimits = parseRateLimits(event.rateLimits)
    return rateLimits ? { usage, rateLimits } : { usage }
  }
  return undefined
}
