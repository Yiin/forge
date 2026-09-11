import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { z } from 'zod'
import type { HarnessAccount } from '@forge/protocol/accounts'
import type { HarnessConfig } from '@forge/protocol/config'
import {
  byteSize,
  fail,
  idSchema,
  pathSchema,
  bounded,
  record,
} from './wire.js'

export type CodexNativeLaunchAuthority = {
  credentials: 'native-configured-sources'
  provider: string
  canonicalCwd: string
  account: Pick<
    HarnessAccount,
    'id' | 'harnessKey' | 'kind' | 'adapterKind' | 'homePath' | 'disabledAt'
  >
  harness: Pick<
    HarnessConfig,
    'command' | 'args' | 'env' | 'adapterKind' | 'enabled'
  >
}
export type CodexAccountContext =
  | { accountId: null; env?: NodeJS.ProcessEnv; expectedCodexHome?: string }
  | {
      accountId: string
      env: NodeJS.ProcessEnv & { CODEX_HOME: string }
      expectedCodexHome: string
      nativeLaunch: CodexNativeLaunchAuthority
    }
export type CodexLaunchOptions = CodexAccountContext & {
  provider: string
  command?: string
  args?: string[]
}

// These keys select managed credentials, headers, or state roots in the pinned native profile.
export const selectedRemovalKeys = [
  'CODEX_HOME',
  'CODEX_ACCESS_TOKEN',
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_FEDERATION_RULE_ID',
  'OPENAI_IDENTITY_TOKEN_FILE',
  'OPENAI_WORKLOAD_IDENTITY_CONTEXT',
  'OPENAI_ORGANIZATION',
  'OPENAI_PROJECT',
  'CODEX_SQLITE_HOME',
] as const
const ownedConfig = new Set([
  'model',
  'model_reasoning_effort',
  'service_tier',
  'approval_policy',
  'approvals_reviewer',
  'sandbox_mode',
  'sandbox_workspace_write',
  'cwd',
  'ephemeral',
])
const ownedFlags = new Set([
  '-m',
  '--model',
  '-a',
  '--ask-for-approval',
  '--approval-policy',
  '--approvals-reviewer',
  '-s',
  '--sandbox',
  '-C',
  '--cd',
  '--cwd',
  '--full-auto',
  '--yolo',
  '--dangerously-bypass-approvals-and-sandbox',
  '--ephemeral',
  '--resume',
  '--continue',
  '--last',
  '--remote',
  '--remote-auth-token-env',
  '--remote-control',
  '--listen',
  '--auth',
  '--auth-token',
  '--auth-token-env',
  '--websocket-auth-token',
  '--port',
  '--host',
])

/** Preserve configured arguments. Reject arguments that compete with adapter-owned state. */
export function normalizeCodexArgs(args: readonly string[] = []): string[] {
  bounded(args, 128, 64 * 1024, 'ARGUMENT')
  const out: string[] = []
  let appServer = false
  let stdio = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (typeof arg !== 'string' || arg.includes('\0')) fail('ARGUMENT')
    if (arg === 'app-server') {
      if (appServer) fail('ARGUMENT')
      appServer = true
      continue
    }
    if (arg === '--stdio') {
      if (stdio) fail('ARGUMENT')
      stdio = true
      continue
    }
    const flag = arg.split('=')[0]!
    if (
      ownedFlags.has(flag) ||
      ['-m', '-a', '-s', '-C'].some(
        (short) => arg.startsWith(short) && arg !== short,
      )
    )
      fail('ARGUMENT_OWNED')
    if (
      arg === '--' ||
      ['resume', 'exec', 'fork', 'login', 'logout', 'daemon', 'proxy'].includes(
        arg,
      )
    )
      fail('ARGUMENT_OWNED')
    let config: string | undefined
    if (arg === '-c' || arg === '--config') {
      config = args[++i]
      out.push(arg)
    } else if (arg.startsWith('--config=')) config = arg.slice(9)
    else if (arg.startsWith('-c') && arg.length > 2) config = arg.slice(2)
    if (config !== undefined) {
      let parsed: Record<string, unknown>
      try {
        parsed = parseToml(config)
      } catch {
        return fail('ARGUMENT_CONFIG')
      }
      if (Object.keys(parsed).some((key) => ownedConfig.has(key)))
        fail('ARGUMENT_OWNED')
      out.push(arg === '-c' || arg === '--config' ? config : arg)
    } else {
      if (arg === '-c' || arg === '--config') fail('ARGUMENT_CONFIG')
      out.push(arg)
    }
  }
  return [...out, 'app-server', '--stdio']
}

export async function canonicalDirectory(value: string): Promise<string> {
  pathSchema.parse(value)
  const canonical = await realpath(value)
  if (!(await stat(canonical)).isDirectory()) fail('DIRECTORY')
  return pathSchema.parse(canonical)
}

/** Snapshot caller configuration once. Never retain the full account record. */
export function copyLaunchOptions(
  options: CodexLaunchOptions,
): CodexLaunchOptions {
  idSchema.parse(options.provider)
  if (options.accountId !== null) idSchema.parse(options.accountId)
  const authority = 'nativeLaunch' in options ? options.nativeLaunch : undefined
  if (options.accountId !== null) {
    if (!authority || !record(authority))
      fail('ACCOUNT_LAUNCH_AUTHORITY_REQUIRED')
    if (authority.credentials !== 'native-configured-sources')
      fail('ACCOUNT_AUTH_SOURCE_UNSUPPORTED')
    if (!record(authority.account) || !record(authority.harness))
      fail('ACCOUNT_LAUNCH_SCOPE_MISMATCH')
  }
  const env: NodeJS.ProcessEnv = { ...authority?.harness.env, ...options.env }
  const keys = Object.keys(env)
  bounded(keys, 512, 256 * 1024, 'ENVIRONMENT')
  for (const key of keys) {
    idSchema.parse(key)
    if (
      key.includes('=') ||
      key.includes('\0') ||
      (env[key] !== undefined &&
        (typeof env[key] !== 'string' || env[key]!.includes('\0')))
    )
      fail('ENVIRONMENT')
  }
  if (byteSize(env) > 256 * 1024) fail('ENVIRONMENT_LIMIT')
  const args = normalizeCodexArgs(options.args ?? authority?.harness.args ?? [])
  const command = pathSchema.parse(
    options.command ?? authority?.harness.command ?? 'codex',
  )
  if (!command.trim() || command.includes('\0')) fail('COMMAND')
  if (authority) {
    const account = authority.account
    if (
      authority.provider !== options.provider ||
      account.id !== options.accountId ||
      account.harnessKey !== options.provider ||
      account.kind !== 'codex' ||
      account.disabledAt !== null ||
      (account.adapterKind !== undefined && account.adapterKind !== 'native') ||
      authority.harness.adapterKind !== 'native' ||
      authority.harness.enabled !== true ||
      authority.harness.command !== command ||
      JSON.stringify(normalizeCodexArgs(authority.harness.args)) !==
        JSON.stringify(args)
    )
      fail('ACCOUNT_LAUNCH_SCOPE_MISMATCH')
    idSchema.parse(account.id)
    pathSchema.parse(account.homePath)
    pathSchema.parse(authority.canonicalCwd)
    // Only bounded provenance and one merged environment survive construction.
    return {
      ...options,
      command,
      args,
      env,
      nativeLaunch: {
        credentials: authority.credentials,
        provider: authority.provider,
        canonicalCwd: authority.canonicalCwd,
        account: {
          id: account.id,
          harnessKey: account.harnessKey,
          kind: account.kind,
          adapterKind: account.adapterKind,
          homePath: account.homePath,
          disabledAt: account.disabledAt,
        },
        harness: {
          command,
          args,
          env: {},
          adapterKind: 'native',
          enabled: true,
        },
      },
    } as CodexLaunchOptions
  }
  return {
    accountId: null,
    provider: options.provider,
    expectedCodexHome: options.expectedCodexHome,
    command,
    args,
    env,
  }
}

export async function prepareCodexEnvironment(
  options: CodexLaunchOptions,
  cwd: string,
) {
  options = copyLaunchOptions(options)
  const selected = options.accountId !== null
  let expectedHome: string | undefined
  if (options.expectedCodexHome !== undefined) {
    expectedHome = await canonicalDirectory(options.expectedCodexHome)
    if (expectedHome !== options.expectedCodexHome) fail('ACCOUNT_HOME')
  }
  const explicit = options.env ?? {}
  if (
    selected &&
    (!expectedHome ||
      !Object.hasOwn(explicit, 'CODEX_HOME') ||
      typeof explicit.CODEX_HOME !== 'string' ||
      !explicit.CODEX_HOME)
  )
    fail('ACCOUNT_HOME')
  if (explicit.CODEX_HOME !== undefined) {
    const home = await canonicalDirectory(explicit.CODEX_HOME)
    if (expectedHome && expectedHome !== home) fail('ACCOUNT_HOME')
  }
  if (options.accountId !== null) {
    const authority = options.nativeLaunch
    if (!authority) fail('ACCOUNT_LAUNCH_AUTHORITY_REQUIRED')
    if (
      authority.canonicalCwd !== cwd ||
      (await canonicalDirectory(authority.account.homePath)) !== expectedHome ||
      authority.account.homePath !== expectedHome
    )
      fail('ACCOUNT_LAUNCH_SCOPE_MISMATCH')
    const rule = explicit.OPENAI_FEDERATION_RULE_ID
    const token = explicit.OPENAI_IDENTITY_TOKEN_FILE
    const context = explicit.OPENAI_WORKLOAD_IDENTITY_CONTEXT
    if (rule !== undefined || token !== undefined || context !== undefined) {
      if (
        !rule?.trim() ||
        !token ||
        !isAbsolute(token) ||
        !Object.hasOwn(explicit, 'OPENAI_FEDERATION_RULE_ID') ||
        !Object.hasOwn(explicit, 'OPENAI_IDENTITY_TOKEN_FILE') ||
        !!explicit.CODEX_ACCESS_TOKEN
      )
        fail('ACCOUNT_AUTH_SELECTOR')
      pathSchema.parse(token)
    }
    if (
      explicit.CODEX_SQLITE_HOME !== undefined &&
      (await canonicalDirectory(explicit.CODEX_SQLITE_HOME)) !==
        explicit.CODEX_SQLITE_HOME
    )
      fail('ACCOUNT_STATE_HOME')
  }
  // No await between constructing fixed removals and returning the launch overrides.
  const env: NodeJS.ProcessEnv = { ...explicit }
  if (selected)
    for (const key of selectedRemovalKeys)
      env[key] = Object.hasOwn(explicit, key) ? explicit[key] : undefined
  if (expectedHome) env.CODEX_HOME = expectedHome
  return { env, expectedHome, accountId: options.accountId, canonicalCwd: cwd }
}

const optionalText = z.string().nullable().optional()
const stringMap = z.record(z.string(), z.string()).nullable().optional()
const unsigned = z.number().int().nonnegative().nullable().optional()
const authCommandFields = {
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  timeout_ms: z.number().int().positive().optional(),
}
const commandAuth = z.strictObject({
  ...authCommandFields,
  refresh_interval_ms: z.number().int().nonnegative().optional(),
  cwd: pathSchema.refine(isAbsolute).optional(),
})
const aws = z.strictObject({
  profile: optionalText,
  region: optionalText,
  auth_refresh: z.strictObject(authCommandFields).nullish(),
})
const providerSchema = z.strictObject({
  name: z.string().optional(),
  base_url: optionalText,
  env_key: optionalText,
  env_key_instructions: optionalText,
  experimental_bearer_token: optionalText,
  auth: commandAuth.nullish(),
  aws: aws.nullish(),
  wire_api: z.literal('responses').optional(),
  query_params: stringMap,
  http_headers: stringMap,
  env_http_headers: stringMap,
  request_max_retries: unsigned,
  stream_max_retries: unsigned,
  stream_idle_timeout_ms: unsigned,
  websocket_connect_timeout_ms: unsigned,
  requires_openai_auth: z.boolean().optional(),
  supports_websockets: z.boolean().optional(),
  supports_standalone_web_search: z.boolean().optional(),
})
export type CodexProviderProvenance = {
  accountId: string | null
  verifiedHomeScope: string | null
  selectedProviderId: string
  credentialPolicy: 'native-configured-sources' | 'native-environment'
  sourceClasses: string[]
  effectiveCredentialIdentity: 'unverified'
  accountObservation: 'account/read'
}

/** Native has already loaded config. This validates only the active supported provider shape. */
export function admitCodexConfiguration(
  value: unknown,
  scope: { accountId: string | null; expectedHome?: string },
) {
  if (byteSize(value) > 8 * 1024 * 1024) fail('CONFIG_LIMIT')
  if (!record(value) || !record(value.config) || !record(value.origins))
    fail('CONFIG_SHAPE')
  const config = value.config
  const selected = idSchema.parse(config.model_provider ?? 'openai')
  const providers = config.model_providers ?? {}
  if (!record(providers) || Object.keys(providers).length > 256)
    fail('CONFIG_PROVIDERS')
  const sourceClasses: string[] = []
  if (selected === 'openai')
    sourceClasses.push('native-account', 'built-in-environment-headers')
  else if (selected === 'ollama' || selected === 'lmstudio')
    sourceClasses.push('local-provider')
  else {
    const bedrock =
      selected === 'amazon-bedrock' || selected === 'amazon-bedrock-runtime'
    const raw = providers[selected]
    if (!bedrock && !record(raw)) fail('CONFIG_PROVIDER_MISSING')
    const parsed = providerSchema.safeParse(raw ?? {})
    if (!parsed.success) fail('CONFIG_PROVIDER_SHAPE')
    const provider = parsed.data
    if (bedrock) {
      for (const [key, val] of Object.entries(provider)) {
        if (['base_url', 'auth', 'aws', 'http_headers'].includes(key)) continue
        if (
          val === null ||
          val === undefined ||
          (key === 'name' && val === '') ||
          (key === 'wire_api' && val === 'responses') ||
          ([
            'requires_openai_auth',
            'supports_websockets',
            'supports_standalone_web_search',
          ].includes(key) &&
            val === false)
        )
          continue
        fail('CONFIG_BEDROCK_OVERRIDE')
      }
      // Native always retains the built-in AWS object unless an override replaces it.
      sourceClasses.push('aws')
    }
    if (provider.aws) {
      if (
        provider.auth ||
        provider.env_key != null ||
        provider.experimental_bearer_token != null ||
        provider.requires_openai_auth ||
        provider.supports_websockets
      )
        fail('CONFIG_PROVIDER_AUTH_CONFLICT')
      if (
        provider.aws.auth_refresh &&
        provider.aws.auth_refresh.command !== 'aws'
      )
        fail('CONFIG_PROVIDER_AWS_REFRESH')
      if (!bedrock) sourceClasses.push('aws')
    }
    if (provider.auth) {
      if (
        !provider.auth.command.trim() ||
        provider.env_key != null ||
        provider.experimental_bearer_token != null ||
        provider.requires_openai_auth
      )
        fail('CONFIG_PROVIDER_AUTH_CONFLICT')
      sourceClasses.push('command')
    }
    if (provider.env_key != null) {
      idSchema.parse(provider.env_key)
      sourceClasses.push('environment-key')
    }
    if (provider.experimental_bearer_token != null)
      sourceClasses.push('configured-bearer')
    if (provider.http_headers && Object.keys(provider.http_headers).length)
      sourceClasses.push('configured-headers')
    if (
      provider.env_http_headers &&
      Object.keys(provider.env_http_headers).length
    ) {
      Object.values(provider.env_http_headers).forEach((key) =>
        idSchema.parse(key),
      )
      sourceClasses.push('environment-headers')
    }
    if (provider.requires_openai_auth) sourceClasses.push('native-account')
  }
  const provenance: CodexProviderProvenance = {
    accountId: scope.accountId,
    verifiedHomeScope: scope.expectedHome ?? null,
    selectedProviderId: selected,
    credentialPolicy:
      scope.accountId === null
        ? 'native-environment'
        : 'native-configured-sources',
    sourceClasses,
    effectiveCredentialIdentity: 'unverified',
    accountObservation: 'account/read',
  }
  const baseline = Object.fromEntries(
    [
      'model',
      'model_reasoning_effort',
      'service_tier',
      'approval_policy',
      'sandbox_mode',
      'sandbox_workspace_write',
    ]
      .filter((key) => Object.hasOwn(config, key))
      .map((key) => [key, config[key]]),
  )
  if (byteSize({ baseline, provenance }) > 256 * 1024)
    fail('CONFIG_METADATA_LIMIT')
  return { baseline, provenance }
}
