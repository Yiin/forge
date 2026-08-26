import { Hono } from 'hono'
import { spawn as spawnNode } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { stringify } from 'smol-toml'
import { defaultConfig, loadConfig } from '../config.js'
import { spawnAcpClient } from '../acp/client.js'
import type { ForgeConfig, HarnessConfig } from '@forge/protocol/config'

export type ConfigRoutesOptions = {
  config?: ForgeConfig
  configPath?: string
  db?: { prepare(sql: string): { run(...values: unknown[]): unknown } }
}

const configBody = (config: ForgeConfig) => ({
  dataDir: config.dataDir,
  port: config.port,
  harness: config.harness,
  settings: config.settings,
})

export function harnessRoutes(options: ConfigRoutesOptions = {}) {
  let config = options.config ?? defaultConfig()
  const app = new Hono()
  const save = async (next: ForgeConfig) => {
    config = next
    if (options.configPath)
      await writeFile(options.configPath, stringify(configBody(config)))
  }
  app.get('/api/settings', (c) => c.json(config.settings))
  app.put('/api/settings', async (c) => {
    const body = (await c.req.json()) as Partial<ForgeConfig['settings']>
    const settings = { ...config.settings, ...body }
    await save({ ...config, settings })
    return c.json(settings)
  })
  app.get('/api/harnesses', (c) => c.json(config.harness))
  app.put('/api/harnesses', async (c) => {
    const body = (await c.req.json()) as {
      harness: Record<string, HarnessConfig>
    }
    const next = { ...config, harness: body.harness }
    await save(next)
    return c.json(next.harness)
  })
  app.post('/api/harnesses/test', async (c) => {
    const body = (await c.req.json()) as { name?: string }
    const entry = body.name ? config.harness[body.name] : undefined
    if (!entry) return c.json({ ok: false, stderrTail: 'Unknown harness' }, 404)
    if (entry.protocol === 'pty') return testPty(entry, c)
    try {
      const client = await spawnAcpClient(
        entry,
        options.db && body.name
          ? {
              capabilityStore: { db: options.db, harnessKey: body.name },
            }
          : {},
      )
      const result = {
        ok: true,
        agentName:
          (client.capabilities.agent as { name?: string }).name ?? null,
        protocolVersion: null,
        capabilities: {
          loadSession: client.capabilities.loadSession,
          ...client.capabilities.agent,
        },
      }
      await client.kill()
      return c.json(result)
    } catch (error) {
      return c.json(
        {
          ok: false,
          stderrTail: error instanceof Error ? error.message : String(error),
        },
        422,
      )
    }
  })
  return app
}

async function testPty(
  entry: HarnessConfig,
  c: {
    json: (value: unknown, status?: number) => Response | Promise<Response>
  },
) {
  return new Promise<Response>((resolve) => {
    const child = spawnNode(entry.command, entry.args, {
      env: { ...process.env, ...entry.env },
    })
    let output = ''
    let error = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      resolve(
        c.json(
          { ok: false, stderrTail: error || 'No output before timeout' },
          422,
        ) as Response,
      )
    }, 15_000)
    child.stdout?.on('data', (chunk) => {
      output += String(chunk)
      if (output.trim())
        finish({
          ok: true,
          agentName: null,
          protocolVersion: null,
          capabilities: { loadSession: false },
        })
    })
    child.stderr?.on('data', (chunk) => {
      error = (error + String(chunk)).slice(-4096)
    })
    child.once('error', (cause) =>
      finish({ ok: false, stderrTail: cause.message }),
    )
    child.once('exit', (code) => {
      if (code !== 0)
        finish({ ok: false, stderrTail: error || `Exited with code ${code}` })
    })
    const finish = (value: unknown) => {
      clearTimeout(timer)
      child.kill('SIGTERM')
      resolve(c.json(value) as Response)
    }
  })
}

export async function loadSettingsConfig(path?: string) {
  return loadConfig(path)
}
