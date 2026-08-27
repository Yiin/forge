import { readFile } from 'node:fs/promises'
import type { UsageProbe, UsageProbeResult } from '../usagePoller.js'
import type { UsageWindow } from '../usage.js'

const source = 'claude.oauth.usage'
const usageUrl = 'https://api.anthropic.com/api/oauth/usage'
const betaHeader = 'oauth-2025-04-20'

type Fetcher = typeof fetch
type Credentials = {
  claudeAiOauth?: {
    accessToken?: unknown
    expiresAt?: unknown
    rateLimitTier?: unknown
    subscriptionType?: unknown
  }
}

type RawWindow = {
  utilization?: unknown
  resets_at?: unknown
}

type RawModelLimit = RawWindow & {
  percent?: unknown
  kind?: unknown
  window?: unknown
  name?: unknown
  scope?: { model?: unknown }
}

const numberValue = (value: unknown) => {
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function resetTime(value: unknown): number | null {
  const numeric = numberValue(value)
  if (numeric !== undefined) return numeric < 1e12 ? numeric * 1000 : numeric
  if (typeof value !== 'string') return null
  const parsed = Date.parse(
    value.endsWith('Z') ? `${value.slice(0, -1)}+00:00` : value,
  )
  return Number.isNaN(parsed) ? null : parsed
}

function windowWord(kind: unknown) {
  const value = typeof kind === 'string' ? kind.toLowerCase() : ''
  if (value.includes('month')) return 'Monthly'
  if (value.includes('week') || value.includes('day')) return 'Weekly'
  if (value.includes('hour') || value.includes('session')) return 'Session'
  return 'Usage'
}

function modelDetails(model: unknown) {
  if (typeof model === 'string') return { id: model, displayName: model }
  if (!model || typeof model !== 'object') return undefined
  const value = model as {
    id?: unknown
    display_name?: unknown
    displayName?: unknown
  }
  const id = typeof value.id === 'string' ? value.id : undefined
  const displayName =
    typeof value.display_name === 'string'
      ? value.display_name
      : typeof value.displayName === 'string'
        ? value.displayName
        : undefined
  if (!id && !displayName) return undefined
  return { id: id ?? displayName!, displayName: displayName ?? id! }
}

function scaleValues(values: unknown[]) {
  const numbers = values
    .map(numberValue)
    .filter((value): value is number => value !== undefined)
  return (
    numbers.some((value) => value > 1) ||
    numbers.filter((value) => value >= 1).length > 1
  )
}

function slug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function fraction(value: unknown, percentScaled: boolean) {
  const numeric = numberValue(value)
  if (numeric === undefined) return undefined
  return Math.max(0, Math.min(1, percentScaled ? numeric / 100 : numeric))
}

function tierLabel(oauth: NonNullable<Credentials['claudeAiOauth']>) {
  if (typeof oauth.rateLimitTier === 'string') {
    const match = oauth.rateLimitTier.match(/max_(\d+x)/i)
    if (match) return `Max ${match[1]!.toLowerCase()}`
  }
  if (typeof oauth.subscriptionType !== 'string' || !oauth.subscriptionType)
    return undefined
  return (
    oauth.subscriptionType[0]!.toUpperCase() + oauth.subscriptionType.slice(1)
  )
}

export function makeClaudeUsageProbe(fetcher: Fetcher = fetch): UsageProbe {
  return async ({ homePath }): Promise<UsageProbeResult> => {
    let credentials: Credentials
    try {
      credentials = JSON.parse(
        await readFile(`${homePath}/.credentials.json`, 'utf8'),
      ) as Credentials
    } catch {
      return { status: 'auth', detail: 'Waiting for auth', windows: [] }
    }
    const oauth = credentials.claudeAiOauth
    const token =
      typeof oauth?.accessToken === 'string' ? oauth.accessToken : ''
    if (!token)
      return { status: 'auth', detail: 'Waiting for auth', windows: [] }
    const expiresAt = numberValue(oauth?.expiresAt)
    if (expiresAt !== undefined && expiresAt > 0 && expiresAt <= Date.now())
      return { status: 'auth', detail: 'Sign-in expired', windows: [] }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    try {
      const response = await fetcher(usageUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': betaHeader,
          Accept: 'application/json',
        },
        signal: controller.signal,
      })
      if (response.status === 429)
        return {
          status: 'unavailable',
          detail: response.headers.get('retry-after') ?? 'unknown',
          windows: [],
        }
      if (!response.ok)
        return {
          status: 'unavailable',
          detail: String(response.status),
          windows: [],
        }

      const payload = (await response.json()) as {
        five_hour?: RawWindow
        seven_day_oauth_apps?: RawWindow
        seven_day?: RawWindow
        limits?: RawModelLimit[]
      }
      const limits = Array.isArray(payload.limits) ? payload.limits : []
      const values = [
        payload.five_hour?.utilization,
        (payload.seven_day_oauth_apps ?? payload.seven_day)?.utilization,
        ...limits.map((limit) => limit.percent ?? limit.utilization),
      ]
      const percentScaled = scaleValues(values)
      const windows: UsageWindow[] = []
      const fiveHour = payload.five_hour
      const weekly = payload.seven_day_oauth_apps ?? payload.seven_day
      const add = (
        windowKey: string,
        label: string,
        window?: RawWindow,
        raw?: unknown,
      ) => {
        const percent = fraction(raw ?? window?.utilization, percentScaled)
        if (percent === undefined) return
        windows.push({
          windowKey,
          label,
          percent,
          resetsAt: resetTime(window?.resets_at),
          source,
        })
      }
      add('session-5h', 'Session (5-hour)', fiveHour)
      add('weekly-7d', 'Weekly (7-day)', weekly)
      const seen = new Set<string>()
      for (const limit of limits) {
        const model = modelDetails(limit.scope?.model)
        if (!model) continue
        const kind =
          typeof limit.kind === 'string'
            ? limit.kind
            : typeof limit.window === 'string'
              ? limit.window
              : ''
        const name = model.displayName || model.id
        const dedupeKey = `${name}:${kind}`
        if (seen.has(dedupeKey)) continue
        seen.add(dedupeKey)
        const word = windowWord(kind)
        add(
          `model:${slug(name)}:${kind}`,
          `${name} ${word}`,
          limit,
          limit.percent ?? limit.utilization,
        )
      }
      return { status: 'ok', tierLabel: tierLabel(oauth!), windows }
    } catch {
      return {
        status: 'unavailable',
        detail: 'Network request failed',
        retryAdvised: true,
        windows: [],
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

export const claudeUsageProbe = makeClaudeUsageProbe()
