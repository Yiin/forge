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
import { closeAcpDiscovery, createAcpDiscovery } from './discovery.js'
import { AcpResourceHost } from './limits.js'
import { NativeProcess } from '../process.js'
import * as native from '../process.js'
import * as profiles from './profiles.js'
import { deferred } from '../transport-test-helpers.js'
import { expectStopped } from '../transport-test-helpers.js'

const paths: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
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
if(process.env.FIXTURE_MODE==='held')setInterval(()=>{},1000);
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
function discoveryDeadline() {
  const original = globalThis.setTimeout
  let expire: (() => void) | undefined
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    callback: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    if (ms === 15000 && !expire) {
      expire = () => callback(...args)
      return original(() => {}, ms)
    }
    return original(callback, ms, ...args)
  }) as typeof setTimeout)
  return () => {
    expect(expire).toBeDefined()
    expire!()
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
      discovery = createAcpDiscovery('devin', f.input, new AcpResourceHost())
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
    const discovery = createAcpDiscovery(
      'devin',
      f.input,
      new AcpResourceHost(),
    )
    vi.stubEnv('FORGE_ACP_CAPTURE_SENTINEL', 'later-secret')
    expect((await discovery.refresh(f.cwd)).status).toBe('unverified')
    for (const call of await f.calls()) {
      expect(call.sentinel).toBeUndefined()
      await expectStopped(call.pid)
    }
  })
  it('shares one fingerprint across constructors and bounds pending callers at 32', async () => {
    const f = await fixture('normal'),
      host = new AcpResourceHost()
    const first = createAcpDiscovery('devin', f.input, host).refresh(f.cwd)
    for (let i = 1; i < 32; i++)
      expect(createAcpDiscovery('devin', f.input, host).refresh(tmpdir())).toBe(
        first,
      )
    await expect(
      createAcpDiscovery('devin', f.input, host).refresh(f.cwd),
    ).rejects.toThrow('waiter limit')
    await first
    await createAcpDiscovery('devin', f.input, host).refresh(f.cwd)
    expect(await f.calls()).toHaveLength(2)
    for (const call of await f.calls()) await expectStopped(call.pid)
  })
  it('bounds distinct discovery owners at four per instance and eight per host', async () => {
    const f = await fixture('normal'),
      host = new AcpResourceHost()
    const discovery = (instance: string, id: string) =>
      createAcpDiscovery(
        'devin',
        {
          ...f.input,
          providerInstanceId: instance,
          account: { kind: 'native-default', configurationId: id },
        },
        host,
      )
    const pending = Array.from({ length: 8 }, (_, i) =>
      discovery(i < 4 ? 'a' : 'b', String(i)).refresh(f.cwd),
    )
    expect((await discovery('a', 'over-instance').refresh(f.cwd)).status).toBe(
      'failed',
    )
    expect((await discovery('c', 'over-host').refresh(f.cwd)).status).toBe(
      'failed',
    )
    expect(
      (await Promise.all(pending)).every(
        (value) => value.status === 'unverified',
      ),
    ).toBe(true)
    expect(await f.calls()).toHaveLength(8)
    for (const call of await f.calls()) await expectStopped(call.pid)
    await discovery('a', 'later').refresh(f.cwd)
    expect(await f.calls()).toHaveLength(9)
    for (const call of await f.calls()) await expectStopped(call.pid)
  })
  it.each(['instance', 'host'])(
    'shares the %s process budget with runtime owners',
    async (scope) => {
      const f = await fixture('normal'),
        host = new AcpResourceHost()
      const releases =
        scope === 'instance'
          ? [host.reserve('instance', 'processes', 8)]
          : ['a', 'b', 'c', 'd'].map((id) => host.reserve(id, 'processes', 8))
      const discovery = createAcpDiscovery('devin', f.input, host)
      expect((await discovery.refresh(f.cwd)).status).toBe('failed')
      await expect(f.calls()).rejects.toMatchObject({ code: 'ENOENT' })
      for (const release of releases) release()
      expect((await discovery.refresh(f.cwd)).status).toBe('unverified')
      expect(await f.calls()).toHaveLength(1)
      for (const call of await f.calls()) await expectStopped(call.pid)
    },
  )
  it('holds discovery and process leases through the original cleanup settlement', async () => {
    const f = await fixture('normal'),
      host = new AcpResourceHost()
    const held = deferred<void>(),
      closing = deferred<void>()
    const original = NativeProcess.prototype.close
    vi.spyOn(NativeProcess.prototype, 'close').mockImplementation(function (
      this: NativeProcess,
      reason,
    ) {
      return original.call(this, reason).then(() => {
        closing.resolve()
        return held.promise
      })
    })
    const discovery = createAcpDiscovery('devin', f.input, host)
    const pending = discovery.refresh(f.cwd)
    try {
      await closing.promise
      expect(createAcpDiscovery('devin', f.input, host).refresh(tmpdir())).toBe(
        pending,
      )
      expect(() => host.reserve('instance', 'processes', 8)).toThrow(
        'resource limit',
      )
      expect(() => host.reserve('instance', 'discovery', 4)).toThrow(
        'resource limit',
      )
    } finally {
      held.resolve()
    }
    await pending
    host.reserve('instance', 'processes', 8)()
    host.reserve('instance', 'discovery', 4)()
    for (const call of await f.calls()) await expectStopped(call.pid)
  })
  it('fences replacement after cleanup refusal without accumulating completed waiters', async () => {
    const f = await fixture('normal'),
      host = new AcpResourceHost()
    const original = NativeProcess.prototype.close
    vi.spyOn(NativeProcess.prototype, 'close').mockImplementation(function (
      this: NativeProcess,
      reason,
    ) {
      return original.call(this, reason).then(() => {
        throw Error('fixture cleanup refused')
      })
    })
    const discovery = createAcpDiscovery('devin', f.input, host)
    const first = discovery.refresh(f.cwd)
    expect((await first).status).toBe('failed')
    for (let i = 0; i < 40; i++) expect(discovery.refresh(tmpdir())).toBe(first)
    expect(() => host.reserve('instance', 'processes', 8)).toThrow(
      'resource limit',
    )
    expect(() => host.reserve('instance', 'discovery', 4)).toThrow(
      'resource limit',
    )
    expect(await f.calls()).toHaveLength(1)
    for (const call of await f.calls()) await expectStopped(call.pid)
  })
  it.each(['resolution', 'startup'] as const)(
    'bounds the whole discovery admission during held %s',
    async (phase) => {
      const f = await fixture('normal'),
        host = new AcpResourceHost()
      const held = deferred<string | null>(),
        entered = deferred<void>()
      const expire = discoveryDeadline()
      const start = native.startNativeProcess
      if (phase === 'resolution')
        vi.spyOn(profiles, 'resolveExecutable').mockImplementationOnce(() => {
          entered.resolve()
          return held.promise
        })
      else
        vi.spyOn(native, 'startNativeProcess').mockImplementation(
          async (options, initialize) => {
            entered.resolve()
            await held.promise
            return start(options, initialize)
          },
        )
      const discovery = createAcpDiscovery('devin', f.input, host)
      const pending = discovery.refresh(f.cwd)
      await entered.promise
      expire()
      expect(await pending).toMatchObject({
        status: 'failed',
        error: 'ACP discovery timed out',
      })
      expect(discovery.refresh(tmpdir())).toBe(pending)
      expect(() => host.reserve('instance', 'discovery', 4)).toThrow('limit')
      await expect(f.calls()).rejects.toMatchObject({ code: 'ENOENT' })
      held.resolve(f.input.command)
      await vi.waitFor(() => {
        host.reserve('instance', 'discovery', 4)()
      })
      await expect(f.calls()).rejects.toMatchObject({ code: 'ENOENT' })
      host.reserve('instance', 'processes', 8)()
    },
  )
  it('settles all waiters at the deadline when original child cleanup refuses before close', async () => {
    const f = await fixture('held'),
      host = new AcpResourceHost()
    const expire = discoveryDeadline(),
      original = NativeProcess.prototype.close
    const owners = new Set<NativeProcess>()
    const refusal = vi
      .spyOn(NativeProcess.prototype, 'close')
      .mockImplementation(function (this: NativeProcess) {
        owners.add(this)
        return Promise.reject(Error('held cleanup refused'))
      })
    const discovery = createAcpDiscovery('devin', f.input, host)
    const first = discovery.refresh(f.cwd),
      second = discovery.refresh(tmpdir())
    try {
      await vi.waitFor(async () => expect(await f.calls()).toHaveLength(1))
      expire()
      expect(first).toBe(second)
      expect((await first).status).toBe('failed')
      await vi.waitFor(() => expect(owners.size).toBe(1))
      expect(discovery.refresh(tmpdir())).toBe(first)
      expect(() => host.reserve('instance', 'discovery', 4)).toThrow('limit')
      expect(() => host.reserve('instance', 'processes', 8)).toThrow('limit')
    } finally {
      refusal.mockRestore()
      for (const owner of owners) await original.call(owner)
    }
    for (const call of await f.calls()) await expectStopped(call.pid)
  })
  it('settles logically at the deadline while original cleanup remains physically pending', async () => {
    const f = await fixture('normal'),
      host = new AcpResourceHost()
    const held = deferred<void>(),
      closing = deferred<void>(),
      expire = discoveryDeadline()
    const original = NativeProcess.prototype.close
    vi.spyOn(NativeProcess.prototype, 'close').mockImplementation(function (
      this: NativeProcess,
      reason,
    ) {
      return original.call(this, reason).then(() => {
        closing.resolve()
        return held.promise
      })
    })
    const discovery = createAcpDiscovery('devin', f.input, host)
    const first = discovery.refresh(f.cwd)
    try {
      await closing.promise
      expire()
      expect((await first).status).toBe('failed')
      expect(discovery.refresh(tmpdir())).toBe(first)
      expect(() => host.reserve('instance', 'processes', 8)).toThrow('limit')
    } finally {
      held.resolve()
    }
    await vi.waitFor(() => {
      host.reserve('instance', 'processes', 8)()
    })
    for (const call of await f.calls()) await expectStopped(call.pid)
  })
  it('releases a failed startup only after its original owner proves cleanup', async () => {
    const f = await fixture('normal'),
      host = new AcpResourceHost()
    const discovery = createAcpDiscovery('devin', f.input, host)
    expect((await discovery.refresh(join(f.cwd, 'absent'))).status).toBe(
      'failed',
    )
    host.reserve('instance', 'processes', 8)()
    host.reserve('instance', 'discovery', 4)()
    expect((await discovery.refresh(f.cwd)).status).toBe('unverified')
    for (const call of await f.calls()) await expectStopped(call.pid)
  })
  it.each(['normal', 'missing-extra', 'invalid'])(
    'classifies Hermes or discovery failure %s without authentication',
    async (mode) => {
      const f = await fixture(mode)
      const profile = mode === 'invalid' ? 'devin' : 'hermes'
      const result = await createAcpDiscovery(
        profile,
        f.input,
        new AcpResourceHost(),
      ).refresh(f.cwd)
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

it('fences a held original resolver and joins it without launching a process', async () => {
  const f = await fixture('normal'),
    host = new AcpResourceHost()
  const entered = deferred<void>(),
    held = deferred<string>()
  vi.spyOn(profiles, 'resolveExecutable').mockImplementation(async () => {
    entered.resolve()
    return held.promise
  })
  const discovery = createAcpDiscovery('hermes', f.input, host)
  const result = discovery.refresh(f.cwd)
  await entered.promise
  const closing = closeAcpDiscovery(host)
  expect(closeAcpDiscovery(host)).toBe(closing)
  let settled = false
  void closing.then(() => {
    settled = true
  })
  try {
    await expect(discovery.refresh(f.cwd)).rejects.toThrow(
      'discovery is closed',
    )
    expect((await result).status).toBe('failed')
    expect(settled).toBe(false)
    expect(() => host.reserve('instance', 'discovery', 4)).toThrow('limit')
  } finally {
    held.resolve(f.input.command)
    await closing
  }
  expect(closeAcpDiscovery(host)).toBe(closing)
  host.reserve('instance', 'discovery', 4)()
  await expect(f.calls()).rejects.toMatchObject({ code: 'ENOENT' })
})

it('retains failed live probe cleanup and retries only the original process', async () => {
  const f = await fixture('held'),
    host = new AcpResourceHost()
  const original = NativeProcess.prototype.close
  const owners = new Set<NativeProcess>()
  const close = vi
    .spyOn(NativeProcess.prototype, 'close')
    .mockImplementation(function (this: NativeProcess) {
      owners.add(this)
      return Promise.reject(Error('original close refused'))
    })
  const discovery = createAcpDiscovery('hermes', f.input, host)
  const result = discovery.refresh(f.cwd)
  try {
    await vi.waitFor(async () => expect(await f.calls()).toHaveLength(1))
    await expect(closeAcpDiscovery(host)).rejects.toThrow(
      'discovery cleanup failed',
    )
    expect((await result).status).toBe('failed')
    expect(owners.size).toBe(1)
    expect(() => host.reserve('instance', 'processes', 8)).toThrow('limit')
    await expect(discovery.refresh(f.cwd)).rejects.toThrow(
      'discovery is closed',
    )
  } finally {
    close.mockImplementation(original)
    await closeAcpDiscovery(host)
  }
  expect(await f.calls()).toHaveLength(1)
  host.reserve('instance', 'processes', 8)()
  host.reserve('instance', 'discovery', 4)()
  for (const call of await f.calls()) await expectStopped(call.pid)
})
