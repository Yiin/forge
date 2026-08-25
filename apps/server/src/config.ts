import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { parse } from 'smol-toml'
import { z } from 'zod'
import {
  forgeConfigSchema,
  harnessConfigSchema,
  type ForgeConfig,
  type HarnessConfig,
} from '@forge/protocol/config'

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
  }
  if (dev)
    harness.mock = {
      name: 'Mock ACP agent',
      command: 'bun',
      args: [
        resolve(process.cwd(), 'apps/server/test/fixtures/acp-mock-agent.ts'),
      ],
      env: {},
      protocol: 'acp',
      enabled: true,
    }
  return { harness }
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

export async function loadConfig(path = 'forge.toml'): Promise<ForgeConfig> {
  const file = resolve(path)
  let source: string
  try {
    source = await readFile(file, 'utf8')
  } catch (error) {
    throw new Error(
      `${file}: unable to read config: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  let parsed: unknown
  try {
    parsed = parse(source)
  } catch (error) {
    throw new Error(
      `${file}: invalid TOML: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const entries = (parsed as { harness?: Record<string, unknown> }).harness
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
    result[key] = checked.data
  }
  const checked = forgeConfigSchema.safeParse({ harness: result })
  if (!checked.success)
    throw new Error(
      `${basename(file)}: invalid config: ${checked.error.message}`,
    )
  activeConfig = checked.data
  return activeConfig
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
