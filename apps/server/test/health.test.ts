import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startServer } from '../src/index.js'

const servers: ReturnType<typeof startServer>[] = []

// Without these variables startServer reads ~/.forge/forge.toml, ./data, and
// ~/.forge/accounts. On a host with a real Forge install that config can set an
// explicit terminalAccess allowlist that 403s loopback requests, and boot can
// rewrite it. Every test gets a scratch home instead.
const forgeEnv = [
  'FORGE_CONFIG',
  'FORGE_DATA_DIR',
  'FORGE_DB',
  'FORGE_ACCOUNTS_DIR',
  'FORGE_PORT',
  'FORGE_VERSION',
  'FORGE_WEB_DIR',
] as const
const restoredEnv = [...forgeEnv, 'NODE_ENV'] as const
let savedEnv: Record<string, string | undefined> = {}
let scratch = ''
let configPath = ''
let dataDir = ''

beforeEach(async () => {
  savedEnv = Object.fromEntries(
    restoredEnv.map((key) => [key, process.env[key]]),
  )
  for (const key of forgeEnv) delete process.env[key]
  scratch = await mkdtemp(join(tmpdir(), 'forge-health-'))
  configPath = join(scratch, 'forge.toml')
  dataDir = join(scratch, 'data')
  process.env.FORGE_CONFIG = configPath
  process.env.FORGE_DATA_DIR = dataDir
  process.env.FORGE_ACCOUNTS_DIR = join(scratch, 'accounts')
})

afterEach(async () => {
  for (const server of servers.splice(0)) server.close()
  for (const key of restoredEnv) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(scratch, { recursive: true, force: true })
})

describe('health endpoint', () => {
  it('answers on an ephemeral port', async () => {
    const server = startServer(0)
    servers.push(server)
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('server did not expose a TCP address')

    const response = await fetch(`http://127.0.0.1:${address.port}/api/health`)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      version: '0.1.0',
      db: 'ok',
    })
  })

  it('uses the data directory for the default database path', () => {
    const first = startServer(0)
    first.close()
    expect(existsSync(join(dataDir, 'forge.db'))).toBe(true)

    const second = startServer(0)
    second.close()
  })

  it('loads harnesses from FORGE_CONFIG during boot', async () => {
    await writeFile(
      configPath,
      `dataDir = "${dataDir}"\n[harness.custom]\nname = "Custom"\ncommand = "sh"\nargs = ["-i"]\nenv = {}\nprotocol = "pty"\nenabled = true\n`,
    )
    const server = startServer(0)
    servers.push(server)
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('no address')
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/harnesses`,
    )
    expect(Object.keys(await response.json())).toEqual([
      'custom',
      'claude-code-acp',
      'codex-acp',
      'kimi',
      'opencode',
      'pi',
      'cursor',
      'gemini',
      'grok',
      'devin',
      'hermes',
      'mock',
    ])
  })

  const validHarness =
    '[harness.fixture]\nname = "Fixture"\ncommand = "/bin/false"\nargs = []\nenv = {}\nprotocol = "pty"\nenabled = false\n'
  it.each([
    [
      'harness',
      '[harness.custom]\nname = "broken"\n',
      'harness.custom.command',
    ],
    [
      'terminal access',
      '[terminalAccess]\nmode = "explicit"\n' + validHarness,
      'allowedOrigins',
    ],
    [
      'port',
      'port = 0\n' + validHarness,
      'Server port must be an integer from 0 through 65535',
    ],
  ])(
    'rejects invalid %s before allocating server resources',
    async (_name, source, expectedError) => {
      await writeFile(configPath, source)
      process.env.FORGE_DB = join(dataDir, 'forge.db')
      expect(() => startServer(_name === 'port' ? -1 : 0)).toThrow(
        expectedError,
      )
      expect(await readFile(configPath, 'utf8')).toBe(source)
      expect(existsSync(dataDir)).toBe(false)
    },
  )

  it('reconciles stock entries on boot and remains byte-stable', async () => {
    await writeFile(
      configPath,
      `dataDir = "${dataDir}"\n[harness.shell]\nname = "Shell PTY"\ncommand = "bash"\nargs = ["-i"]\nenv = {}\nprotocol = "pty"\nenabled = true\n[harness.mock]\nname = "Mock ACP agent"\ncommand = "bun"\nargs = ["/missing/acp-mock-agent.ts"]\nenv = {}\nprotocol = "acp"\nenabled = false\n`,
    )
    process.env.NODE_ENV = 'production'
    const first = startServer(0)
    first.close()
    const reconciled = await readFile(configPath, 'utf8')
    expect(reconciled).not.toContain('[harness.shell]')
    expect(reconciled).not.toContain('[harness.mock]')

    const second = startServer(0)
    second.close()
    expect(await readFile(configPath, 'utf8')).toBe(reconciled)
  })
})
