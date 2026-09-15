import { access, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { immutableData } from './data.js'

export const acpProviderDescriptors = Object.freeze({
  grok: Object.freeze({
    name: 'Grok',
    command: 'grok',
    args: Object.freeze([
      '--no-auto-update',
      '--permission-mode',
      'ask',
      'agent',
      '--no-leader',
      'stdio',
    ]),
    install: 'Install Grok and sign in before use.',
    load: true,
    questions: true,
  }),
  gemini: Object.freeze({
    name: 'Gemini CLI',
    command: 'gemini',
    args: Object.freeze(['--experimental-acp']),
    install: 'Install Gemini CLI and sign in before use.',
    load: false,
    questions: false,
  }),
  devin: Object.freeze({
    name: 'Devin',
    command: 'devin',
    args: Object.freeze(['acp']),
    install: 'Install Devin CLI and sign in before use.',
    load: true,
    questions: false,
  }),
  hermes: Object.freeze({
    name: 'Hermes',
    command: 'hermes',
    args: Object.freeze(['acp']),
    install: "Install Hermes with its ACP extra: uv pip install -e '.[acp]'.",
    load: true,
    questions: false,
  }),
  'custom-acp': Object.freeze({
    name: 'Custom ACP',
    command: '',
    args: Object.freeze([] as string[]),
    install: 'Configure an explicit ACP executable.',
    load: true,
    questions: false,
  }),
})
export type AcpProfile = keyof typeof acpProviderDescriptors
export type AcpAccountScope = Readonly<
  | { kind: 'native-default'; configurationId: string }
  | { kind: 'selected-account'; accountId: string; home: string }
>
export type AcpLaunch = Readonly<{
  providerInstanceId: string
  account: AcpAccountScope
  command: string
  args: readonly string[]
  env: Readonly<Record<string, string | undefined>>
  secrets?: readonly string[]
}>

const credentialKeys = [
  'XAI_API_KEY',
  'GROK_CODE_XAI_API_KEY',
  'GROK_HOME',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GEMINI_CLI_HOME',
  'HERMES_HOME',
  'HERMES_INFERENCE_PROVIDER',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'DEVIN_API_KEY',
]
export function captureLaunch(
  profile: AcpProfile,
  value: AcpLaunch,
): AcpLaunch {
  const input = immutableData(value)
  if (!input.providerInstanceId.trim() || !input.command.trim())
    throw Error('ACP launch identity is required')
  if (input.args.length > 128 || Object.keys(input.env).length > 512)
    throw Error('ACP launch exceeds limits')
  if (input.account.kind === 'selected-account') {
    if (profile === 'devin' || profile === 'custom-acp')
      throw Error(
        'ACP selected account isolation is unsupported for this profile',
      )
    if (!input.account.accountId.trim() || !isAbsolute(input.account.home))
      throw Error('ACP account requires identity and absolute home')
  } else if (!input.account.configurationId.trim())
    throw Error('ACP native configuration identity is required')
  const env: Record<string, string | undefined> = { ...process.env }
  if (input.account.kind === 'selected-account')
    for (const key of credentialKeys) env[key] = undefined
  Object.assign(env, input.env)
  if (input.account.kind === 'selected-account') {
    const key =
      profile === 'grok'
        ? 'GROK_HOME'
        : profile === 'gemini'
          ? 'GEMINI_CLI_HOME'
          : 'HERMES_HOME'
    if (env[key] !== undefined && env[key] !== input.account.home)
      throw Error('ACP account home conflicts with selected environment')
    env[key] = input.account.home
  }
  const args = [...input.args]
  if (profile === 'grok') args.splice(0, args.length, ...grokArgs(args))

  return Object.freeze({
    ...input,
    args: Object.freeze(args),
    env: Object.freeze(env),
    account: Object.freeze({ ...input.account }),
    secrets: Object.freeze([...(input.secrets ?? [])]),
  })
}

function grokArgs(input: readonly string[]) {
  const agent = input.indexOf('agent')
  if (agent < 0 || input.at(-1) !== 'stdio')
    throw Error('Grok ACP requires agent stdio')
  const outer = input.slice(0, agent)
  for (let index = 0; index < outer.length; index++) {
    if (outer[index] === '--no-auto-update') continue
    if (outer[index] === '--permission-mode' && outer[index + 1] === 'ask') {
      index++
      continue
    }
    throw Error('Grok outer arguments conflict with owned startup settings')
  }
  const result = [
    '--no-auto-update',
    '--permission-mode',
    'ask',
    'agent',
    '--no-leader',
  ]
  const values = new Set([
    '--model',
    '-m',
    '--reasoning-effort',
    '--effort',
    '--agent-profile',
    '--plugin-dir',
    '--cli-chat-proxy-base-url',
    '--xai-api-base-url',
  ])
  for (let index = agent + 1; index < input.length - 1; index++) {
    const arg = input[index]!
    if (arg === '--no-leader') continue
    const equal = arg.indexOf('=')
    const flag = equal < 0 ? arg : arg.slice(0, equal)
    if (!values.has(flag))
      throw Error('Grok agent arguments conflict with owned startup settings')
    if (equal >= 0) {
      if (!arg.slice(equal + 1)) throw Error('Grok argument value is required')
      result.push(arg)
    } else {
      const value = input[++index]
      if (!value || index >= input.length - 1)
        throw Error('Grok argument value is required')
      result.push(arg, value)
    }
  }
  return [...result, 'stdio']
}

export async function resolveExecutable(
  launch: AcpLaunch,
): Promise<string | null> {
  const candidates =
    isAbsolute(launch.command) || launch.command.includes('/')
      ? [launch.command]
      : (launch.env.PATH ?? '')
          .split(delimiter)
          .filter(Boolean)
          .slice(0, 128)
          .map((path) => join(path, launch.command))
  for (const path of candidates) {
    try {
      await access(path, constants.X_OK)
      if ((await stat(path)).isFile()) return await realpath(path)
    } catch (error) {
      if (
        !['ENOENT', 'ENOTDIR', 'EACCES'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        throw error
    }
  }
  return null
}

const variant = z.object({
  model_uid: z
    .string()
    .min(1)
    .max(1024)
    .refine((value) => value.trim() === value),
  label: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => value.trim().length > 0),
  cost_summary: z.string().max(4096).optional(),
})
const devinCatalog = z.object({
  families: z
    .array(z.object({ variants: z.array(variant).max(1024) }))
    .max(128),
})
export function parseDevinModels(value: unknown) {
  const catalog = devinCatalog.parse(immutableData(value))
  const models = new Map<
    string,
    { id: string; displayName: string; description?: string }
  >()
  for (const family of catalog.families)
    for (const item of family.variants) {
      if (!models.has(item.model_uid))
        models.set(item.model_uid, {
          id: item.model_uid,
          displayName: item.label,
          ...(item.cost_summary === undefined
            ? {}
            : { description: item.cost_summary }),
        })
      if (models.size > 1024) throw Error('Devin model catalog exceeds limit')
    }
  if (!models.size) throw Error('Devin returned an empty model catalog')
  return [...models.values()]
}
