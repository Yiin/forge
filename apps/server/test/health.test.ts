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
      expect(Object.keys(await response.json())).toEqual(['custom'])
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
      expect(Object.keys(await response.json())).toContain('shell')
      expect(await readFile(configPath, 'utf8')).toBe(source)
    } finally {
      if (previousConfig === undefined) delete process.env.FORGE_CONFIG
      else process.env.FORGE_CONFIG = previousConfig
      await rm(dir, { recursive: true, force: true })
    }
  })
})
