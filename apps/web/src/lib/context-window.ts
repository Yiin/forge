import type { ContextWindowUsage } from '@forge/protocol/events'

export type ContextWindowView = ContextWindowUsage & {
  remainingTokens: number | null
  usedPercentage: number | null
  remainingPercentage: number | null
}

export function formatContextWindowTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '0'
  if (value < 1_000) return `${Math.round(value)}`
  if (value < 10_000)
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`
}

export function deriveContextWindowView(
  usage: ContextWindowUsage,
): ContextWindowView {
  const usedPercentage =
    usage.maxTokens && usage.maxTokens > 0
      ? Math.min(100, (usage.usedTokens / usage.maxTokens) * 100)
      : null
  return {
    ...usage,
    remainingTokens:
      usage.maxTokens === undefined
        ? null
        : Math.max(0, Math.round(usage.maxTokens - usage.usedTokens)),
    usedPercentage,
    remainingPercentage:
      usedPercentage === null ? null : Math.max(0, 100 - usedPercentage),
  }
}
