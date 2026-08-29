import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ContextWindowUsage } from '@forge/protocol/events'

const FULL_SCAN_LIMIT = 5 * 1024 * 1024
const TAIL_SCAN_SIZE = 1024 * 1024

type Input = {
  homePath: string
  cwd: string
  providerSessionId: string
  model?: string | null
}

type Counters = {
  inputTokens: number
  cacheCreationInputTokens: number
  cachedInputTokens: number
  outputTokens: number
}

function counters(value: unknown): Counters | undefined {
  if (!value || typeof value !== 'object') return undefined
  const usage = value as Record<string, unknown>
  const inputTokens = usage.input_tokens
  const cacheCreationInputTokens = usage.cache_creation_input_tokens
  const cachedInputTokens = usage.cache_read_input_tokens
  const outputTokens = usage.output_tokens
  const readCounter = (counter: unknown): number | undefined => {
    if (counter === undefined) return 0
    if (
      typeof counter !== 'number' ||
      !Number.isInteger(counter) ||
      !Number.isFinite(counter) ||
      counter < 0
    )
      return undefined
    return counter
  }
  const parsed = [
    readCounter(inputTokens),
    readCounter(cacheCreationInputTokens),
    readCounter(cachedInputTokens),
    readCounter(outputTokens),
  ]
  if (parsed.some((counter) => counter === undefined)) return undefined
  const [input, creation, cached, output] = parsed as [
    number,
    number,
    number,
    number,
  ]
  return {
    inputTokens: input,
    cacheCreationInputTokens: creation,
    cachedInputTokens: cached,
    outputTokens: output,
  }
}

function messageUsage(line: string): Counters | undefined {
  try {
    const message = (JSON.parse(line) as { message?: unknown }).message
    if (!message || typeof message !== 'object') return undefined
    const value = message as { role?: unknown; usage?: unknown }
    return value.role === 'assistant' ? counters(value.usage) : undefined
  } catch {
    return undefined
  }
}

function modelLimit(model: string | null | undefined) {
  if (!model) return undefined
  if (/opus-(?:4-8|4-7|5)/i.test(model)) return 1_000_000
  if (/(?:sonnet|haiku|claude-[23])/i.test(model)) return 200_000
  return undefined
}

export function readClaudeContextUsage(
  input: Input,
): ContextWindowUsage | undefined {
  const directory = input.cwd.replace(/[^a-zA-Z0-9]/g, '-')
  const file = join(
    input.homePath,
    'projects',
    directory,
    `${input.providerSessionId}.jsonl`,
  )
  let content: string
  let fullScan = true
  try {
    const size = statSync(file).size
    if (size > FULL_SCAN_LIMIT) {
      fullScan = false
      const bytes = readFileSync(file)
      content = bytes
        .subarray(Math.max(0, bytes.length - TAIL_SCAN_SIZE))
        .toString()
    } else content = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }

  const lines = content.split('\n')
  let latest: Counters | undefined
  let totalProcessedTokens = 0
  for (const line of lines) {
    const usage = messageUsage(line)
    if (!usage) continue
    latest = usage
    totalProcessedTokens +=
      usage.inputTokens +
      usage.cacheCreationInputTokens +
      usage.cachedInputTokens +
      usage.outputTokens
  }
  if (!latest) return undefined
  const usedTokens =
    latest.inputTokens +
    latest.cacheCreationInputTokens +
    latest.cachedInputTokens +
    latest.outputTokens
  if (usedTokens === 0) return undefined

  const result: ContextWindowUsage = {
    usedTokens,
    inputTokens: latest.inputTokens,
    cachedInputTokens: latest.cachedInputTokens,
    outputTokens: latest.outputTokens,
    compactsAutomatically: true,
    source: 'claude.transcript',
    observedAt: Date.now(),
  }
  const maxTokens = modelLimit(input.model)
  if (maxTokens !== undefined) result.maxTokens = maxTokens
  if (fullScan && totalProcessedTokens > usedTokens)
    result.totalProcessedTokens = totalProcessedTokens
  return result
}
