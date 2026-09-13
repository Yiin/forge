import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { HarnessSession, ConfirmedNativeBinding } from '../types.js'
import {
  KimiError,
  boundedString,
  jsonBytes,
  type KimiLimits,
} from './limits.js'
import type { KimiLaunchAuthority } from './types.js'

export const kimiModelOverrides = Object.freeze([
  'KIMI_MODEL_NAME',
  'KIMI_MODEL_API_KEY',
  'KIMI_MODEL_PROVIDER_TYPE',
  'KIMI_MODEL_BASE_URL',
  'KIMI_MODEL_MAX_CONTEXT_SIZE',
  'KIMI_MODEL_CAPABILITIES',
  'KIMI_MODEL_DISPLAY_NAME',
  'KIMI_MODEL_MAX_OUTPUT_SIZE',
  'KIMI_MODEL_REASONING_KEY',
  'KIMI_MODEL_ADAPTIVE_THINKING',
  'KIMI_MODEL_THINKING_EFFORT',
  'KIMI_MODEL_TEMPERATURE',
  'KIMI_MODEL_TOP_P',
  'KIMI_MODEL_THINKING_KEEP',
  'KIMI_MODEL_MAX_COMPLETION_TOKENS',
  'KIMI_MODEL_MAX_TOKENS',
])
export type FileIdentity = Readonly<{ path: string; dev: number; ino: number }>
export type EffectiveAuthority = Readonly<{
  selected: KimiLaunchAuthority
  home: FileIdentity
  executable: FileIdentity
  environment: Readonly<NodeJS.ProcessEnv>
  bootstrapCwd: string
}>

export function captureAuthority(
  input: KimiLaunchAuthority,
  limits: Readonly<KimiLimits>,
): KimiLaunchAuthority {
  jsonBytes(input, limits, limits.stateReadBytes)
  const captured = structuredClone(input)
  if (
    !captured.account ||
    !captured.harness ||
    captured.credentialPolicy !== 'configured-native'
  )
    throw new KimiError('kimi_invalid_authority')
  const { account, harness, provider } = captured
  boundedString(provider, limits.forgeIdBytes)
  boundedString(account.id, limits.forgeIdBytes)
  if (
    account.kind !== 'kimi' ||
    account.harnessKey !== provider ||
    account.disabledAt !== null ||
    account.adapterKind !== 'native' ||
    harness.adapterKind !== 'native' ||
    harness.enabled !== true
  )
    throw new KimiError('kimi_invalid_authority')
  if (!Array.isArray(harness.args) || harness.args.length)
    throw new KimiError('kimi_unsupported_arguments')
  if (!harness.command || /[\0\r\n]/.test(harness.command))
    throw new KimiError('kimi_invalid_executable')
  if (!captured.environment || typeof captured.environment !== 'object')
    throw new KimiError('kimi_invalid_environment')
  return captured
}

export async function directoryIdentity(
  path: string,
  privateHome = false,
): Promise<FileIdentity> {
  if (!path) throw new KimiError('kimi_missing_workspace')
  const canonical = await realpath(path)
  const info = await stat(canonical)
  if (
    !info.isDirectory() ||
    (privateHome &&
      (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700))
  )
    throw new KimiError('kimi_unsafe_directory')
  return Object.freeze({ path: canonical, dev: info.dev, ino: info.ino })
}

export async function assertIdentity(identity: FileIdentity) {
  const canonical = await realpath(identity.path)
  const current = await stat(canonical)
  if (
    canonical !== identity.path ||
    current.dev !== identity.dev ||
    current.ino !== identity.ino
  )
    throw new KimiError('kimi_identity_changed')
}

export async function effectiveAuthority(
  selected: KimiLaunchAuthority,
): Promise<EffectiveAuthority> {
  const home = await directoryIdentity(selected.account.homePath, true)
  const configured = selected.harness.env
  if (
    configured.KIMI_CODE_HOME &&
    (await realpath(configured.KIMI_CODE_HOME)) !== home.path
  )
    throw new KimiError('kimi_conflicting_home')
  for (const key of kimiModelOverrides) {
    if (selected.environment[key] && !Object.hasOwn(configured, key))
      throw new KimiError('kimi_unowned_model_override')
  }
  const environment: NodeJS.ProcessEnv = {
    ...selected.environment,
    ...configured,
  }
  // Explicit removals follow configured entries. Keep them through NativeProcess's inherited merge.
  for (const key of Object.keys(selected.environment))
    if (selected.environment[key] === undefined) environment[key] = undefined
  // Freeze the complete environment, including removal of ambient values added after capture.
  for (const key of Object.keys(process.env))
    if (!Object.hasOwn(environment, key)) environment[key] = undefined
  environment.KIMI_CODE_HOME = home.path
  environment.KIMI_DISABLE_TELEMETRY = '1'
  const command = selected.harness.command
  let path: string | undefined
  if (isAbsolute(command)) path = await realpath(command)
  else if (!command.includes('/')) {
    for (const part of (environment.PATH ?? '').split(':')) {
      if (!isAbsolute(part)) continue
      try {
        const candidate = await realpath(join(part, command))
        await access(candidate, constants.X_OK)
        path = candidate
        break
      } catch {
        /* Try the next explicit PATH entry. */
      }
    }
  }
  if (!path || /\/(?:ba|da|z|fi|c|k)?sh$/.test(path))
    throw new KimiError('kimi_invalid_executable')
  await access(path, constants.X_OK)
  const info = await stat(path)
  if (!info.isFile()) throw new KimiError('kimi_invalid_executable')
  return Object.freeze({
    selected,
    home,
    executable: Object.freeze({ path, dev: info.dev, ino: info.ino }),
    environment: Object.freeze(environment),
    bootstrapCwd: home.path,
  })
}

export function sameAuthority(
  a: EffectiveAuthority,
  b: EffectiveAuthority,
): boolean {
  const normalized = (value: EffectiveAuthority) => ({
    ...value,
    selected: {
      ...value.selected,
      environment: undefined,
      account: { ...value.selected.account, homePath: value.home.path },
      harness: { ...value.selected.harness, env: undefined },
    },
  })
  return isDeepStrictEqual(normalized(a), normalized(b))
}

export async function validateSession(
  session: HarnessSession,
  authority: EffectiveAuthority,
  load: boolean,
  limits: Readonly<KimiLimits>,
): Promise<{
  session: HarnessSession
  cwd: string
  binding?: ConfirmedNativeBinding
}> {
  jsonBytes(session, limits, limits.stateReadBytes)
  const copy = structuredClone(session)
  boundedString(copy.id, limits.forgeIdBytes)
  if (
    copy.provider !== authority.selected.provider ||
    copy.accountId !== authority.selected.account.id
  )
    throw new KimiError('kimi_binding_mismatch')
  const cwd = (await directoryIdentity(copy.cwd)).path
  if (!load) {
    if (copy.binding?.providerSessionId)
      throw new KimiError('kimi_load_required')
    return { session: copy, cwd }
  }
  const binding = copy.binding
  if (
    !binding?.providerSessionId ||
    binding.provider !== copy.provider ||
    binding.accountId !== copy.accountId ||
    binding.cwd !== cwd
  )
    throw new KimiError('kimi_resume_binding_mismatch')
  boundedString(binding.providerSessionId, limits.nativeIdBytes)
  return {
    session: copy,
    cwd,
    binding: Object.freeze({
      ...binding,
      cwd,
      providerSessionId: binding.providerSessionId,
    }),
  }
}
