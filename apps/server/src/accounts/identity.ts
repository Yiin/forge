import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export type AccountIdentity = {
  status: 'authenticated' | 'unauthenticated' | 'unknown'
  email?: string
  displayName?: string
  plan?: string
  accountUuid?: string
  userId?: string
  providers?: string[]
  label?: string
  type?: string
  expiresAt?: number
}

const object = (value: unknown): Record<string, any> | null =>
  value && typeof value === 'object' ? (value as Record<string, any>) : null
const readJson = (path: string): Record<string, any> | null => {
  try {
    return object(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}
const string = (value: unknown) =>
  typeof value === 'string' && value ? value : undefined

function claude(home: string): AccountIdentity {
  const credentials = readJson(join(home, '.credentials.json'))
  const oauth = object(credentials?.claudeAiOauth)
  const profile = readJson(join(home, '.claude.json'))
  const account = object(profile?.oauthAccount)
  if (!oauth?.accessToken || typeof oauth.accessToken !== 'string')
    return { status: 'unauthenticated' }
  return {
    status: 'authenticated',
    email: string(account?.emailAddress),
    displayName: string(account?.displayName),
    plan:
      string(oauth.subscriptionType) ??
      string(oauth.rateLimitTier) ??
      string(account?.organizationRateLimitTier),
    accountUuid: string(account?.accountUuid),
    expiresAt:
      typeof oauth.expiresAt === 'number' ? oauth.expiresAt : undefined,
  }
}

function decodeJwt(token: string): Record<string, any> | null {
  try {
    const part = token.split('.')[1]
    if (!part) return null
    return object(JSON.parse(Buffer.from(part, 'base64url').toString('utf8')))
  } catch {
    return null
  }
}

function codex(home: string): AccountIdentity {
  const auth = readJson(join(home, 'auth.json'))
  const tokens = object(auth?.tokens)
  const claims = string(tokens?.id_token) ? decodeJwt(tokens!.id_token) : null
  if (!claims && !tokens?.access_token) return { status: 'unauthenticated' }
  const authClaims = object(claims?.['https://api.openai.com/auth'])
  const organizations = Array.isArray(authClaims?.organizations)
    ? authClaims.organizations
    : []
  return {
    status: 'authenticated',
    email: string(claims?.email),
    displayName: string(claims?.name),
    plan: string(authClaims?.chatgpt_plan_type),
    accountUuid:
      string(authClaims?.chatgpt_account_id) ?? string(tokens?.account_id),
    providers: organizations
      .map((item: unknown) => string(object(item)?.name))
      .filter((item): item is string => Boolean(item)),
  }
}

function kimi(home: string): AccountIdentity {
  const auth = readJson(join(home, 'credentials/kimi-code.json'))
  const token = string(auth?.access_token) ?? string(auth?.refresh_token)
  if (!token) return { status: 'unauthenticated' }
  const accessToken = string(auth?.access_token)
  const claims = accessToken ? decodeJwt(accessToken) : null
  return {
    status: 'authenticated',
    userId: string(claims?.user_id),
    label: 'Kimi',
    type: 'oauth',
    expiresAt:
      typeof auth?.expires_at === 'number' ? auth.expires_at : undefined,
  }
}

function providers(home: string, file: string): AccountIdentity {
  const auth = readJson(join(home, file))
  if (!auth) return { status: 'unknown' }
  const names = Object.keys(auth).sort()
  if (!names.length) return { status: 'unauthenticated' }
  return { status: 'authenticated', providers: names, label: names.join(', ') }
}

export function readAccountIdentity(
  kind: string,
  homePath: string,
): AccountIdentity {
  try {
    switch (kind) {
      case 'claude':
        return claude(homePath)
      case 'codex':
        return codex(homePath)
      case 'kimi':
        return kimi(homePath)
      case 'opencode':
        return providers(homePath, 'opencode/auth.json')
      case 'pi':
        return providers(homePath, 'auth.json')
      default:
        return { status: 'unknown' }
    }
  } catch {
    return { status: 'unknown' }
  }
}
