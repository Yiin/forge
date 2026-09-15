import { Hono } from 'hono'
import { spawn as spawnNode } from 'node:child_process'
import {
  defaultConfig,
  loadConfig,
  saveConfig,
  type ConfigState,
} from '../config.js'
import { createAcpDiscovery } from '../harnesses/acp/discovery.js'
import { AcpResourceHost } from '../harnesses/acp/limits.js'
import { productionAcpProfile } from '../sessions/acp-factory.js'
import { harnessTransport } from '../sessions/native-factory.js'
import {
  settingsPatchSchema,
  settingsSchema,
  harnessConfigSchema,
  type ForgeConfig,
  type HarnessConfig,
} from '@forge/protocol/config'

export type ConfigRoutesOptions = {
  config?: ForgeConfig
  configState?: ConfigState
  configPath?: string
  host?: AcpResourceHost
}

export function harnessRoutes(options: ConfigRoutesOptions = {}) {
  const state = options.configState ?? {
    current: options.config ?? defaultConfig(),
  }
  const app = new Hono()
  const host = options.host ?? new AcpResourceHost()
  const save = async (next: ForgeConfig) => {
    state.current = next
    if (options.configPath ?? state.path)
      await saveConfig(options.configPath ?? state.path!, next)
  }
  app.get('/api/settings', (c) => c.json(state.current.settings))
  app.put('/api/settings', async (c) => {
    const parsed = settingsPatchSchema.parse(await c.req.json())
    const settings = settingsSchema.parse({
      ...state.current.settings,
      ...parsed,
    })
    await save({ ...state.current, settings })
    return c.json(settings)
  })
  app.get('/api/harnesses', (c) => c.json(state.current.harness))
  app.put('/api/harnesses', async (c) => {
    const body = (await c.req.json()) as {
      harness: Record<string, HarnessConfig>
    }
    const next = { ...state.current, harness: body.harness }
    await save(next)
    return c.json(next.harness)
  })
  app.post('/api/harnesses/test', async (c) => {
    const body = (await c.req.json()) as { name?: string; harness?: unknown }
    const parsedDraft = body.harness
      ? harnessConfigSchema.safeParse(body.harness)
      : null
    const entry = parsedDraft?.success
      ? parsedDraft.data
      : body.name
        ? state.current.harness[body.name]
        : undefined
    if (!entry) return c.json({ ok: false, stderrTail: 'Unknown harness' }, 404)
    const transport = harnessTransport(body.name ?? 'custom-acp', entry)
    if (transport === 'pty') return testPty(entry, c)
    if (transport === 'native')
      return c.json({
        ok: false,
        status: 'unverified',
        authentication: 'unknown',
        stderrTail:
          'Select an account and refresh its models to test native discovery.',
      })
    try {
      const key = body.name ?? 'custom-acp'
      const result = await createAcpDiscovery(
        productionAcpProfile(key, entry),
        {
          providerInstanceId: key,
          account: { kind: 'native-default', configurationId: key },
          command: entry.command,
          args: entry.args,
          env: entry.env,
        },
        host,
      ).refresh(process.cwd())
      return c.json(
        {
          ok: result.status === 'available',
          status: result.status,
          authentication: result.authentication,
          models: result.models,
          stderrTail:
            result.error ??
            (result.status === 'unverified'
              ? 'Executable found. ACP support and authentication are unverified.'
              : result.status === 'missing'
                ? 'Executable is unavailable.'
                : undefined),
        },
        result.status === 'missing' ||
          result.status === 'failed' ||
          result.status === 'missing-acp-extra'
          ? 422
          : 200,
      )
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
