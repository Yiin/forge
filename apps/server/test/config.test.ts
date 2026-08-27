import { DatabaseSync } from 'node:sqlite'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getHarness,
  getHarnessCapabilities,
  loadConfig,
  saveConfig,
  upsertHarnessCapabilities,
  defaultConfig,
} from '../src/config.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  )
})

async function configFile(text: string) {
  const dir = `/tmp/forge-config-${crypto.randomUUID()}`
  dirs.push(dir)
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'forge.toml')
  await writeFile(file, text)
  return file
}

describe('forge config', () => {
  it('loads a typed harness entry', async () => {
    const config = await loadConfig(
      await configFile(`
[harness.mock]
name = "Mock"
command = "bun"
args = ["agent.ts"]
env = { FORGE_TEST = "1" }
protocol = "acp"
enabled = true
`),
    )
    expect(getHarness(config, 'mock')).toMatchObject({
      protocol: 'acp',
      enabled: true,
    })
  })

  it('reports file, entry, and field for invalid values', async () => {
    const file = await configFile(`
[harness.mock]
name = "Mock"
command = "bun"
args = []
env = {}
protocol = "telnet"
`)
    await expect(loadConfig(file)).rejects.toThrow(
      `${file}: harness.mock.protocol`,
    )
  })

  it('rejects unknown fields with the entry key', async () => {
    const file = await configFile(`
[harness.mock]
name = "Mock"
command = "bun"
args = []
env = {}
protocol = "acp"
wat = true
`)
    await expect(loadConfig(file)).rejects.toThrow(`${file}: harness.mock.wat`)
  })

  it('round-trips capability cache values', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE harness_capabilities (
      harness_key TEXT PRIMARY KEY, capabilities TEXT NOT NULL,
      agent_name TEXT, updated_at INTEGER NOT NULL
    )`)
    upsertHarnessCapabilities(db, 'mock', { loadSession: true }, 'Mock', 42)
    expect(getHarnessCapabilities(db, 'mock')).toEqual({
      harnessKey: 'mock',
      capabilities: { loadSession: true },
      agentName: 'Mock',
      updatedAt: 42,
    })
  })

  it('creates parent directories and omits undefined optional values when saving', async () => {
    const dir = `/tmp/forge-config-save-${crypto.randomUUID()}`
    dirs.push(dir)
    const file = join(dir, 'nested', 'forge.toml')
    const config = defaultConfig(true)
    config.settings.epicDefaults.gateCommand = undefined
    await saveConfig(file, config)
    const source = await readFile(file, 'utf8')
    expect(source).toContain('[harness.shell]')
    expect(source).not.toContain('gateCommand')
  })
})
