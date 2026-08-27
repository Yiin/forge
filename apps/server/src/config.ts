import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { parse, stringify } from 'smol-toml'
import { z } from 'zod'
import {
  forgeConfigSchema,
  harnessConfigSchema,
  type ForgeConfig,
  type HarnessConfig,
} from '@forge/protocol/config'
import { epicRunConfig, type EpicRunConfig } from '@forge/protocol/rolePolicy'
import { join } from 'node:path'

type SqliteDb = {
  exec(sql: string): unknown
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    get(...params: unknown[]): unknown
  }
}

type CapabilityRow = {
  harness_key: string
  capabilities: string
  agent_name: string | null
  updated_at: number
}

export type ConfigProvenance = Record<string, 'input' | 'repo' | 'default'>
export type ResolvedRunConfig = EpicRunConfig & { provenance: ConfigProvenance }
export type ConfigState = { current: ForgeConfig; path?: string }

export const defaultRolePolicy = {
  roles: {
    'iteration-worker': 'default',
    'triage-control': 'default',
    'title-generation': 'default',
  },
  tiers: { default: [{ harness: 'claude-code-acp' }] },
}

let activeConfig: ForgeConfig | undefined

const defaultEntry = (
  name: string,
  command: string,
  args: string[],
  protocol: HarnessConfig['protocol'] = 'acp',
): HarnessConfig => ({
  name,
  command,
  args,
  env: {},
  protocol,
  quietPeriodMs: 2000,
  maxTurnMs: 30 * 60 * 1000,
  enabled: commandAvailable(command),
})

function commandAvailable(command: string) {
  if (command.includes('/') || command.startsWith('.'))
    return existsSync(command)
  try {
    execFileSync('sh', ['-c', `command -v "$1"`, '--', command], {
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

export function defaultConfig(
  dev = process.env.NODE_ENV !== 'production',
): ForgeConfig {
  const harness: Record<string, HarnessConfig> = {
    'claude-code-acp': defaultEntry('Claude Code ACP', 'npx', [
      '@zed-industries/claude-code-acp',
    ]),
    'codex-acp': defaultEntry('Codex ACP', 'npx', [
      '@zed-industries/codex-acp',
    ]),
    kimi: defaultEntry('Kimi', 'kimi', ['acp']),
    gemini: defaultEntry('Gemini', 'gemini', ['--experimental-acp']),
    grok: defaultEntry('Grok', 'grok', ['agent', 'stdio']),
    pi: defaultEntry('Pi', 'npx', ['-y', 'pi-acp']),
  }
  if (dev)
    harness.mock = {
      name: 'Mock ACP agent',
      command: 'bun',
      args: [
        resolve(
          dirname(fileURLToPath(import.meta.url)),
          '../test/fixtures/acp-mock-agent.ts',
        ),
      ],
      env: {},
      protocol: 'acp',
      enabled: true,
    }
  return {
    dataDir: resolve(process.cwd(), 'data'),
    port: 3900,
    harness,
    settings: {
      titleGeneration: true,
      keybindings: {},
      epicDefaults: {
        workerCount: 3,
        mode: 'pool',
        rolePolicy: defaultRolePolicy,
      },
    },
  }
}

function isStockShell(entry: HarnessConfig) {
  return (
    entry.name === 'Shell PTY' &&
    entry.command === 'bash' &&
    JSON.stringify(entry.args) === JSON.stringify(['-i']) &&
    entry.protocol === 'pty'
  )
}

function isStockMock(entry: HarnessConfig) {
  return (
    entry.name === 'Mock ACP agent' &&
    entry.command === 'bun' &&
    entry.args.length === 1 &&
    basename(entry.args[0] ?? '') === 'acp-mock-agent.ts' &&
    entry.protocol === 'acp'
  )
}

function mockIsUnavailable(entry: HarnessConfig) {
  return (
    !commandAvailable(entry.command) ||
    entry.args.some((arg) => arg.endsWith('.ts') && !existsSync(arg))
  )
}

export function reconcileConfig(
  config: ForgeConfig,
  defaults = defaultConfig(),
): ForgeConfig {
  const harness = { ...config.harness }

  if (harness.shell && isStockShell(harness.shell)) delete harness.shell

  const mock = harness.mock
  if (
    mock &&
    isStockMock(mock) &&
    (!defaults.harness.mock || mockIsUnavailable(mock))
  )
    delete harness.mock

  for (const [key, entry] of Object.entries(defaults.harness)) {
    if (!harness[key]) harness[key] = entry
  }

  return { ...config, harness }
}

/** Resolve input over repo config over server defaults. */
export async function resolveRunConfig(
  repoPath: string,
  input: unknown,
  defaults: EpicRunConfig = {
    workerCount: 3,
    mode: 'pool',
    rolePolicy: defaultRolePolicy,
  },
): Promise<ResolvedRunConfig> {
  const parsedInput = epicRunConfig.parse(input ?? {})
  let repo: EpicRunConfig = {}
  const file = join(repoPath, '.forge', 'epic-run.json')
  try {
    repo = epicRunConfig.parse(JSON.parse(await readFile(file, 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const config = { ...defaults, ...repo, ...parsedInput }
  const provenance: ConfigProvenance = {}
  for (const key of Object.keys(config))
    provenance[key] =
      key in parsedInput ? 'input' : key in repo ? 'repo' : 'default'
  return { ...config, provenance }
}

function formatIssue(
  file: string,
  entry: string,
  field: string,
  message: string,
) {
  return `${file}: harness.${entry}.${field}: ${message}`
}

export function getHarness(config: ForgeConfig, key: string): HarnessConfig
export function getHarness(key: string): HarnessConfig
export function getHarness(
  configOrKey: ForgeConfig | string,
  maybeKey?: string,
): HarnessConfig {
  const config = typeof configOrKey === 'string' ? activeConfig : configOrKey
  const key = typeof configOrKey === 'string' ? configOrKey : maybeKey
  if (!config) throw new Error('Config is not loaded')
  if (!key) throw new Error('Harness key is required')
  const value = config.harness[key]
  if (!value) throw new Error(`Unknown harness entry: ${key}`)
  return value
}

export function loadConfigSync(path?: string): ForgeConfig {
  const file = resolve(
    path ?? process.env.FORGE_CONFIG ?? resolve(homedir(), '.forge/forge.toml'),
  )
  let source: string
  try {
    source = readFileSync(file, 'utf8')
  } catch (error) {
    const wrapped = new Error(
      `${file}: unable to read config: ${error instanceof Error ? error.message : String(error)}`,
    )
    ;(wrapped as NodeJS.ErrnoException).code = (
      error as NodeJS.ErrnoException
    ).code
    throw wrapped
  }
  let parsed: unknown
  try {
    parsed = parse(source)
  } catch (error) {
    throw new Error(
      `${file}: invalid TOML: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const document = parsed as {
    dataDir?: unknown
    port?: unknown
    harness?: Record<string, unknown>
    settings?: Record<string, unknown>
  }
  const entries = document.harness
  if (!entries || typeof entries !== 'object')
    throw new Error(`${file}: missing harness table`)
  const result: Record<string, HarnessConfig> = {}
  for (const [key, value] of Object.entries(entries)) {
    const checked = harnessConfigSchema.safeParse(value)
    if (!checked.success) {
      const issue = checked.error.issues[0]
      const field = issue?.path[0]
        ? String(issue.path[0])
        : ((issue as { keys?: string[] }).keys?.[0] ?? 'entry')
      throw new Error(
        formatIssue(file, key, field, issue?.message ?? 'invalid value'),
      )
    }
    result[key] = {
      ...checked.data,
      enabled: commandAvailable(checked.data.command),
    }
  }
  const checked = forgeConfigSchema.safeParse({
    dataDir: document.dataDir ?? resolve(dirname(file), 'data'),
    port: document.port ?? 3900,
    harness: result,
    settings: document.settings,
  })
  if (!checked.success)
    throw new Error(
      `${basename(file)}: invalid config: ${checked.error.message}`,
    )
  activeConfig = checked.data
  return activeConfig
}

export async function loadConfig(path?: string): Promise<ForgeConfig> {
  return loadConfigSync(path)
}

const configBody = (config: ForgeConfig) => ({
  dataDir: config.dataDir,
  port: config.port,
  harness: config.harness,
  settings: config.settings,
})

export async function saveConfig(path: string, config: ForgeConfig) {
  const file = resolve(path)
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  await mkdir(dirname(file), { recursive: true })
  await writeFile(temporary, stringify(stripUndefined(configBody(config))))
  await rename(temporary, file)
}

export function saveConfigSync(path: string, config: ForgeConfig) {
  const file = resolve(path)
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(temporary, stringify(stripUndefined(configBody(config))))
  renameSync(temporary, file)
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, stripUndefined(entry)]),
  )
}

export function upsertHarnessCapabilities(
  db: SqliteDb,
  key: string,
  capabilities: unknown,
  agentName?: string,
  now = Date.now(),
) {
  const value = zCapabilities.parse(capabilities)
  db.prepare(
    `
    INSERT INTO harness_capabilities (harness_key, capabilities, agent_name, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(harness_key) DO UPDATE SET
      capabilities = excluded.capabilities,
      agent_name = excluded.agent_name,
      updated_at = excluded.updated_at
  `,
  ).run(key, JSON.stringify(value), agentName ?? null, now)
}

const zCapabilities = z.record(z.string(), z.unknown())

export function getHarnessCapabilities(db: SqliteDb, key: string) {
  const row = db
    .prepare('SELECT * FROM harness_capabilities WHERE harness_key = ?')
    .get(key) as CapabilityRow | undefined
  if (!row) return undefined
  return {
    harnessKey: row.harness_key,
    capabilities: zCapabilities.parse(JSON.parse(row.capabilities)),
    agentName: row.agent_name,
    updatedAt: row.updated_at,
  }
}
