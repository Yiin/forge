import type { HarnessEvent } from '../types.js'
import { immutableData, immutableNumericData } from './data.js'
import { declaredInteger, type NumericCapture } from './numbers.js'

type Snapshot = Extract<HarnessEvent, { type: 'usage_snapshot' }>
export type AcpUsagePatch = Pick<
  Snapshot,
  'context' | 'tokens' | 'cost' | 'tokenScope' | 'costScope' | 'inputTokenBasis'
>
export type AcpUsageKind =
  'standard' | 'context' | 'grok_prompt' | 'grok_response'
const standard = {
  inputTokens: 'inputTokens',
  outputTokens: 'outputTokens',
  totalTokens: 'totalTokens',
  cachedReadTokens: 'cachedInputTokens',
  cachedWriteTokens: 'cacheWriteInputTokens',
  thoughtTokens: 'reasoningOutputTokens',
} as const
const grokPrompt = {
  inputTokens: 'inputTokens',
  outputTokens: 'outputTokens',
  totalTokens: 'totalTokens',
  cachedReadTokens: 'cachedInputTokens',
  cacheCreationTokens: 'cacheWriteInputTokens',
  reasoningTokens: 'reasoningOutputTokens',
} as const
const grokResponse = {
  input_tokens: 'inputTokens',
  output_tokens: 'outputTokens',
  cache_read_input_tokens: 'cachedInputTokens',
  cache_creation_input_tokens: 'cacheWriteInputTokens',
  reasoning_tokens: 'reasoningOutputTokens',
} as const

/** Projects supplied measurements only. Exact numeric source remains a required sidecar. */
export function projectAcpUsage(
  input: unknown,
  kind: AcpUsageKind,
  capture: NumericCapture,
  path: string,
): {
  patch: AcpUsagePatch | null
  source: unknown
} {
  const captured = immutableData(capture)
  const tokens = new Map(
    captured.numbers
      .filter((token) => token.path.startsWith(path + '/'))
      .map((token) => [token.path, token]),
  )
  const fields =
    kind === 'context'
      ? { used: 'used', size: 'capacity' }
      : kind === 'grok_prompt'
        ? grokPrompt
        : kind === 'grok_response'
          ? grokResponse
          : standard
  const declared = (tokenPath: string) => {
    const key = tokenPath.slice(path.length + 1)
    if (Object.hasOwn(fields, key))
      return kind.startsWith('grok_') ? 'u64' : 'number'
    if (kind === 'grok_prompt' && key === 'costUsdTicks') return 'i64'
    return undefined
  }
  input = immutableNumericData(input, (localPath, value) => {
    const token = tokens.get(path + localPath)
    if (!token || !Object.is(Number(token.text), value))
      throw Error('ACP usage lost numeric source')
    return token.text
  })
  const source = immutableData({
    kind,
    ...(kind === 'grok_prompt'
      ? { costScale: { ticksPerUnit: '10000000000', currency: 'USD' } }
      : {}),
    value: input,
    numbers: [...tokens.values()].map((token) => ({
      ...token,
      declaredType: declared(token.path),
    })),
  })
  const scope =
    kind === 'grok_prompt'
      ? 'prompt'
      : kind === 'grok_response'
        ? 'call'
        : 'unspecified'
  const basis =
    kind === 'grok_prompt'
      ? 'includes_cache_reads'
      : kind === 'grok_response'
        ? 'excludes_cache_reads'
        : 'unspecified'
  if (input === undefined) return { patch: null, source }
  if (input === null)
    return {
      patch:
        kind === 'context'
          ? { context: null }
          : { tokens: null, tokenScope: scope, inputTokenBasis: basis },
      source,
    }
  if (typeof input !== 'object' || Array.isArray(input))
    throw Error('Invalid ACP usage')
  const value = input as Record<string, unknown>
  if (kind === 'grok_prompt')
    for (const flag of ['usageIsIncomplete', 'costIsPartial']) {
      if (value[flag] !== undefined && typeof value[flag] !== 'boolean')
        throw Error('Invalid ACP cost completeness flag')
    }
  const count = (key: string): number | null | undefined => {
    if (value[key] === undefined) return undefined
    if (value[key] === null) return null
    const token = tokens.get(`${path}/${key}`)
    if (!token || value[key] !== token.text)
      throw Error('ACP usage lost numeric source')
    try {
      return declaredInteger(token, 'u64').safeCount
    } catch {
      // Invalid declared integers remain exact source data, without a rounded projection.
      return undefined
    }
  }
  const patch: AcpUsagePatch = {}
  if (kind === 'context') {
    const used = count('used'),
      capacity = count('size')
    if (used !== undefined || capacity !== undefined)
      patch.context = {
        ...(used !== undefined ? { used } : {}),
        ...(capacity !== undefined ? { capacity } : {}),
      }
    if (value.cost === null) {
      patch.cost = null
      patch.costScope = 'session'
    } else if (value.cost !== undefined) {
      if (
        !value.cost ||
        typeof value.cost !== 'object' ||
        Array.isArray(value.cost)
      )
        throw Error('Invalid ACP usage cost')
      const cost = value.cost as Record<string, unknown>
      if (
        typeof cost.currency !== 'string' ||
        !cost.currency ||
        Buffer.byteLength(cost.currency) > 16
      )
        throw Error('Invalid ACP usage currency')
      if (cost.amount === null)
        patch.cost = { amount: null, currency: cost.currency }
      else if (
        typeof cost.amount === 'string' &&
        Number.isFinite(Number(cost.amount)) &&
        Number(cost.amount) >= 0 &&
        tokens.has(`${path}/cost/amount`)
      )
        patch.cost = { amount: Number(cost.amount), currency: cost.currency }
      else throw Error('Invalid ACP usage amount')
      patch.costScope = 'session'
    }
  } else {
    const fields =
      kind === 'grok_prompt'
        ? grokPrompt
        : kind === 'grok_response'
          ? grokResponse
          : standard
    const measurement: NonNullable<Snapshot['tokens']> = {}
    for (const [native, neutral] of Object.entries(fields)) {
      const result = count(native)
      if (result !== undefined) measurement[neutral] = result
    }
    if (Object.keys(measurement).length) {
      patch.tokens = measurement
      patch.tokenScope = scope
      patch.inputTokenBasis = basis
    }
    if (kind === 'grok_prompt' && value.costUsdTicks !== undefined) {
      patch.costScope = 'prompt'
      if (value.costUsdTicks === null) patch.cost = null
      else {
        const token = tokens.get(`${path}/costUsdTicks`)
        if (!token || value.costUsdTicks !== token.text)
          throw Error('ACP usage lost cost source')
        try {
          const exact = declaredInteger(token, 'i64')
          if (
            exact.safeCount !== undefined &&
            value.usageIsIncomplete !== true &&
            value.costIsPartial !== true
          )
            patch.cost = {
              amount: exact.safeCount / 10_000_000_000,
              currency: 'USD',
            }
        } catch {
          /* Exact invalid cost stays in the source sidecar. */
        }
      }
      if (patch.cost === undefined) delete patch.costScope
    }
  }
  return {
    patch: Object.keys(patch).length ? immutableData(patch) : null,
    source,
  }
}
