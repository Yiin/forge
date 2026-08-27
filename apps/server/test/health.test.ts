import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { startServer } from '../src/index.js'

const servers: ReturnType<typeof startServer>[] = []

afterEach(() => {
  for (const server of servers.splice(0)) server.close()
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

  it('uses the data directory for the default database path', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'forge-server-'))
    const previousDataDir = process.env.FORGE_DATA_DIR
    const previousDb = process.env.FORGE_DB
    process.env.FORGE_DATA_DIR = dataDir
    delete process.env.FORGE_DB
    try {
      const first = startServer(0)
      first.close()
      expect(existsSync(join(dataDir, 'forge.db'))).toBe(true)

      const second = startServer(0)
      second.close()
    } finally {
      if (previousDataDir === undefined) delete process.env.FORGE_DATA_DIR
      else process.env.FORGE_DATA_DIR = previousDataDir
      if (previousDb === undefined) delete process.env.FORGE_DB
      else process.env.FORGE_DB = previousDb
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('loads harnesses from FORGE_CONFIG during boot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-config-boot-'))
    const configPath = join(dir, 'forge.toml')
    const dataDir = join(dir, 'data')
    await writeFile(
      configPath,
      `dataDir = "${dataDir}"\n[harness.custom]\nname = "Custom"\ncommand = "sh"\nargs = ["-i"]\nenv = {}\nprotocol = "pty"\nenabled = true\n`,
    )
    const previousConfig = process.env.FORGE_CONFIG
    process.env.FORGE_CONFIG = configPath
    try {
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
        'gemini',
        'grok',
        'mock',
      ])
    } finally {
      if (previousConfig === undefined) delete process.env.FORGE_CONFIG
      else process.env.FORGE_CONFIG = previousConfig
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps malformed config files unchanged and serves defaults', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-config-invalid-'))
    const configPath = join(dir, 'forge.toml')
    const source = '[harness.custom]\nname = "broken"\n'
    await writeFile(configPath, source)
    const previousConfig = process.env.FORGE_CONFIG
    process.env.FORGE_CONFIG = configPath
    try {
      const server = startServer(0)
      servers.push(server)
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('no address')
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/harnesses`,
      )
      expect(Object.keys(await response.json())).not.toContain('shell')
      expect(await readFile(configPath, 'utf8')).toBe(source)
    } finally {
      if (previousConfig === undefined) delete process.env.FORGE_CONFIG
      else process.env.FORGE_CONFIG = previousConfig
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reconciles stock entries on boot and remains byte-stable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-config-reconcile-'))
    const configPath = join(dir, 'forge.toml')
    const dataDir = join(dir, 'data')
    await writeFile(
      configPath,
      `dataDir = "${dataDir}"\n[harness.shell]\nname = "Shell PTY"\ncommand = "bash"\nargs = ["-i"]\nenv = {}\nprotocol = "pty"\nenabled = true\n[harness.mock]\nname = "Mock ACP agent"\ncommand = "bun"\nargs = ["/missing/acp-mock-agent.ts"]\nenv = {}\nprotocol = "acp"\nenabled = false\n`,
    )
    const previousConfig = process.env.FORGE_CONFIG
    const previousNodeEnv = process.env.NODE_ENV
    process.env.FORGE_CONFIG = configPath
    process.env.NODE_ENV = 'production'
    try {
      const first = startServer(0)
      first.close()
      const reconciled = await readFile(configPath, 'utf8')
      expect(reconciled).not.toContain('[harness.shell]')
      expect(reconciled).not.toContain('[harness.mock]')

      const second = startServer(0)
      second.close()
      expect(await readFile(configPath, 'utf8')).toBe(reconciled)
    } finally {
      if (previousConfig === undefined) delete process.env.FORGE_CONFIG
      else process.env.FORGE_CONFIG = previousConfig
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = previousNodeEnv
      await rm(dir, { recursive: true, force: true })
    }
  })
})
