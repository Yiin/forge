import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  captureLaunch,
  parseDevinModels,
  resolveExecutable,
  type AcpLaunch,
} from './profiles.js'
import { createAcpDiscovery } from './discovery.js'
import { expectStopped } from '../transport-test-helpers.js'

const paths: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(
    paths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})
const launch = (overrides: Partial<AcpLaunch> = {}): AcpLaunch => ({
  providerInstanceId: 'instance',
  account: { kind: 'native-default', configurationId: 'configuration' },
  command: 'fixture',
  args: [],
  env: {},
  ...overrides,
})
async function fixture(mode: string) {
  const cwd = await mkdtemp(join(tmpdir(), 'forge-acp-discovery-'))
  paths.push(cwd)
  const command = join(cwd, 'fake'),
    report = join(cwd, 'calls.jsonl')
  await writeFile(
    command,
    `#!/usr/bin/env node
const fs=require('node:fs');fs.appendFileSync(process.env.FIXTURE_REPORT,JSON.stringify({pid:process.pid,args:process.argv.slice(2),sentinel:process.env.FORGE_ACP_CAPTURE_SENTINEL})+'\\n');
if(process.env.FIXTURE_MODE==='missing-extra'){process.stderr.write("ModuleNotFoundError: No module named 'acp'");process.exitCode=1}
else if(process.env.FIXTURE_MODE==='invalid'){process.stdout.write('invalid')}
else if(process.argv[2]==='models')process.stdout.write(JSON.stringify({families:[{variants:[{model_uid:'model-high-fast',label:'High fast',cost_summary:'Account pricing'}]}]}));
else process.stdout.write('Hermes ACP check OK');
`,
  )
  await chmod(command, 0o700)
  const input = launch({
    command,
    args: ['acp'],
    env: { FIXTURE_REPORT: report, FIXTURE_MODE: mode },
  })
  return {
    cwd,
    input,
    async calls() {
      return (await readFile(report, 'utf8'))
        .trim()
        .split('\n')
        .map(
          (line) =>
            JSON.parse(line) as {
              pid: number
              args: string[]
              sentinel?: string
            },
        )
    },
  }
}
describe('dedicated ACP launch and discovery', () => {
  it('keeps safe Grok startup flags and provider arguments in their native positions', () => {
    const selected = captureLaunch(
      'grok',
      launch({
        args: [
          'agent',
          '--model',
          'grok-selected',
          '--plugin-dir',
          '/configured/plugin',
          '--reasoning-effort=high',
          'stdio',
        ],
      }),
    )
    expect(selected.args).toEqual([
      '--no-auto-update',
      '--permission-mode',
      'ask',
      'agent',
      '--no-leader',
      '--model',
      'grok-selected',
      '--plugin-dir',
      '/configured/plugin',
      '--reasoning-effort=high',
      'stdio',
    ])
  })
  it.each(['--leader', '--always-approve', '--reauth', '--yolo'])(
    'rejects conflicting Grok %s before process creation',
    (flag) => {
      expect(() =>
        captureLaunch('grok', launch({ args: ['agent', flag, 'stdio'] })),
      ).toThrow('conflict')
    },
  )
  it('captures native environment and removes inherited credentials for a selected account', () => {
    vi.stubEnv('XAI_API_KEY', 'ambient-secret')
    const env = {
      XAI_API_KEY: 'selected-secret',
      PLUGIN_DIR: '/native/plugins',
    }
    const account = {
      kind: 'selected-account' as const,
      accountId: 'account',
      home: '/selected/grok',
    }
    const input = launch({ args: ['agent', 'stdio'], env, account })
    const selected = captureLaunch('grok', input)
    env.XAI_API_KEY = 'changed'
    account.home = '/changed'
    expect(selected.env.XAI_API_KEY).toBe('selected-secret')
    expect(selected.env.GROK_HOME).toBe('/selected/grok')
    expect(selected.env.PLUGIN_DIR).toBe('/native/plugins')
    expect(process.env.XAI_API_KEY).toBe('ambient-secret')
    expect(
      captureLaunch(
        'grok',
        launch({
          args: ['agent', 'stdio'],
          account: {
            kind: 'selected-account',
            accountId: 'other',
            home: '/other',
          },
        }),
      ).env.XAI_API_KEY,
    ).toBeUndefined()
    expect(Object.isFrozen(selected.env)).toBe(true)
  })
  it('does not execute accessors while capturing launch authority', () => {
    const input = launch()
    let reads = 0
    Object.defineProperty(input, 'env', {
      get() {
        reads++
        return {}
      },
    })
    expect(() => captureLaunch('custom-acp', input)).toThrow('accessors')
    expect(reads).toBe(0)
  })
  it('rejects unverified selected Devin isolation', () => {
    expect(() =>
      captureLaunch(
        'devin',
        launch({
          account: {
            kind: 'selected-account',
            accountId: 'a',
            home: '/native',
          },
        }),
      ),
    ).toThrow('isolation')
  })
  it('keeps exact Devin effort variants and rejects empty, unsafe, and invalid catalogs', () => {
    expect(
      parseDevinModels({
        families: [
          {
            aliases: ['family'],
            variants: [
              {
                model_uid: 'model-high-fast',
                label: 'High',
                cost_summary: 'Price',
              },
              { model_uid: 'model-high-fast', label: 'Duplicate' },
            ],
          },
        ],
      }),
    ).toEqual([
      { id: 'model-high-fast', displayName: 'High', description: 'Price' },
    ])
    for (const value of [
      {},
      { families: [] },
      { families: [{ variants: [{ model_uid: ' model ', label: 'Bad' }] }] },
    ])
      expect(() => parseDevinModels(value)).toThrow()
  })
  it('requires executable permission, not file existence', async () => {
    const f = await fixture('normal')
    await chmod(f.input.command, 0o600)
    expect(await resolveExecutable(captureLaunch('devin', f.input))).toBeNull()
  })
  it('coalesces only overlapping Devin probes and owns every exited process', async () => {
    const f = await fixture('normal'),
      discovery = createAcpDiscovery('devin', f.input)
    const first = discovery.refresh(f.cwd),
      second = discovery.refresh(tmpdir())
    expect(first).toBe(second)
    expect(await first).toMatchObject({
      status: 'unverified',
      authentication: 'unknown',
      models: [{ id: 'model-high-fast' }],
    })
    await discovery.refresh(f.cwd)
    const calls = await f.calls()
    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(call.args).toEqual(['models', 'list', '--format', 'json'])
      await expectStopped(call.pid)
    }
  })
  it('does not inherit environment values added after launch capture', async () => {
    vi.stubEnv('FORGE_ACP_CAPTURE_SENTINEL', undefined)
    const f = await fixture('normal')
    const discovery = createAcpDiscovery('devin', f.input)
    vi.stubEnv('FORGE_ACP_CAPTURE_SENTINEL', 'later-secret')
    expect((await discovery.refresh(f.cwd)).status).toBe('unverified')
    for (const call of await f.calls()) {
      expect(call.sentinel).toBeUndefined()
      await expectStopped(call.pid)
    }
  })
  it.each(['normal', 'missing-extra', 'invalid'])(
    'classifies Hermes or discovery failure %s without authentication',
    async (mode) => {
      const f = await fixture(mode)
      const profile = mode === 'invalid' ? 'devin' : 'hermes'
      const result = await createAcpDiscovery(profile, f.input).refresh(f.cwd)
      expect(result.status).toBe(
        mode === 'normal'
          ? 'available'
          : mode === 'missing-extra'
            ? 'missing-acp-extra'
            : 'failed',
      )
      expect(result.authentication).toBe('unknown')
      for (const call of await f.calls()) await expectStopped(call.pid)
    },
  )
})
