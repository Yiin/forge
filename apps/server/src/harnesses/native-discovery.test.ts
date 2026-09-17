import {
  mkdtemp,
  writeFile,
  readFile,
  chmod,
  rm,
  readdir,
  access,
} from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeProcess } from './process.js'
import { NativeCleanupError } from './native-cleanup.js'
import { discoverClaude } from './claude/index.js'
import { discoverPi, type PiLaunchOptions } from './pi/discovery.js'
import { fixture as piFixture } from './pi/fixtures/test-support.js'
import { discoverOpenCode } from './opencode.js'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})
async function temporary() {
  const directory = await mkdtemp('/tmp/forge-native-discovery-')
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  return directory
}
async function json(path: string) {
  return JSON.parse(await readFile(path, 'utf8'))
}
async function gone(pid: number) {
  await expect(access(`/proc/${pid}`)).rejects.toMatchObject({ code: 'ENOENT' })
}

it.each([false, true])(
  'Claude catalog-only discovery joins original process; cancel=%s',
  async (cancel) => {
    const directory = await temporary(),
      controller = new AbortController()
    await writeFile(
      join(directory, 'scenario.json'),
      JSON.stringify({ discovery: true, manualInitialize: cancel }),
    )
    const work = discoverClaude(
      {
        command: process.execPath,
        args: [
          fileURLToPath(
            new URL('./claude/fixtures/fake-claude.mjs', import.meta.url),
          ),
        ],
        env: { FORGE_CLAUDE_FIXTURE: directory },
      },
      { cwd: directory, signal: controller.signal },
    )
    const observed = work.then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
    await vi.waitFor(async () =>
      expect((await json(join(directory, 'launch.json'))).pid).toBeGreaterThan(
        0,
      ),
    )
    if (cancel) controller.abort()
    const result = await observed
    const launch = await json(join(directory, 'launch.json'))
    expect(launch.argv).toContain('--no-session-persistence')
    expect(launch.session).toBeUndefined()
    if (cancel) expect(result).toHaveProperty('error')
    else {
      expect(result).toHaveProperty('value.models')
      const wire = (await readFile(join(directory, 'stdin.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(wire.map((frame) => frame.request?.subtype)).toEqual([
        'initialize',
      ])
    }
    await gone(launch.pid)
  },
)
it.each([false, true])(
  'Pi catalog-only discovery has no durable sinks or session; cancel=%s',
  async (cancel) => {
    const f = await piFixture(cancel ? { hold: ['get_available_models'] } : {})
    cleanup.push(() => f.close())
    const { providerId, launch, executable, args, env } = f.options
    const options: PiLaunchOptions = {
      providerId,
      launch,
      executable,
      args,
      env,
    }
    const controller = new AbortController()
    const work = discoverPi(options, { cwd: f.cwd, signal: controller.signal })
    const observed = work.then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
    let earlyError: unknown
    void observed.then((result) => {
      if ('error' in result) earlyError = result.error
    })
    await vi.waitFor(async () => {
      if (earlyError) throw earlyError
      expect(
        (await json(join(f.directory, 'started.json'))).pid,
      ).toBeGreaterThan(0)
    })
    if (cancel) controller.abort()
    const result = await observed,
      started = await json(join(f.directory, 'started.json'))
    expect(started.args).toContain('--no-session')
    expect(started.args).not.toContain('--session-dir')
    expect(f.records).toEqual([])
    expect(f.pages).toEqual([])
    expect(f.events).toEqual([])
    expect(await readdir(join(f.directory, 'ephemeral'))).toEqual([])
    if (cancel) expect(result).toHaveProperty('error')
    else {
      expect(result).toHaveProperty(
        'value.models.0.catalogId',
        JSON.stringify(['fake', 'model/one']),
      )
      expect((await f.wire()).map((frame) => frame.type)).toEqual([
        'get_available_models',
        'get_available_thinking_levels',
        'get_commands',
      ])
    }
    await gone(started.pid)
  },
)
it.each([false, true])(
  'OpenCode catalog discovery never creates a conversation and joins cleanup; cancel=%s',
  async (cancel) => {
    const directory = await temporary(),
      executable = join(directory, 'opencode.mjs'),
      report = join(directory, 'report.json'),
      config = join(directory, 'config.json')
    await writeFile(
      executable,
      `#!/usr/bin/env node\nimport ${JSON.stringify(new URL('./fixtures/opencode-server.mjs', import.meta.url).href)}\n`,
    )
    await chmod(executable, 0o755)
    await writeFile(
      config,
      JSON.stringify({ report, mode: cancel ? 'park-health' : undefined }),
    )
    const controller = new AbortController()
    const work = discoverOpenCode(
      {
        provider: 'opencode',
        accountId: null,
        server: {
          mode: 'owned',
          executable,
          env: { FORGE_OPENCODE_FIXTURE_CONFIG: config },
        },
      },
      { cwd: directory, signal: controller.signal },
    )
    const observed = work.then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
    await vi.waitFor(async () =>
      expect((await json(report)).requests.length).toBeGreaterThan(0),
    )
    if (cancel) controller.abort()
    const result = await observed,
      trace = await json(report)
    if (cancel) expect(result).toHaveProperty('error')
    else {
      expect(result).toHaveProperty('value.0.providerID')
      expect(trace.requests.map((r: { path: string }) => r.path)).toEqual([
        '/global/health',
        '/provider',
      ])
    }
    expect(
      trace.requests.every((r: { method: string }) => r.method === 'GET'),
    ).toBe(true)
    await gone(trace.pid)
  },
)

it('Claude discovery retains its original failed cleanup callback', async () => {
  const directory = await temporary()
  await writeFile(
    join(directory, 'scenario.json'),
    JSON.stringify({ discovery: true }),
  )
  const original = NativeProcess.prototype.close
  let refused = true
  const close = vi
    .spyOn(NativeProcess.prototype, 'close')
    .mockImplementation(async function (this: NativeProcess, reason?: Error) {
      await original.call(this, reason)
      if (refused) throw Error('secret-token')
    })
  try {
    const error = await discoverClaude(
      {
        command: process.execPath,
        args: [
          fileURLToPath(
            new URL('./claude/fixtures/fake-claude.mjs', import.meta.url),
          ),
        ],
        env: { FORGE_CLAUDE_FIXTURE: directory },
      },
      { cwd: directory, signal: new AbortController().signal },
    ).catch((error) => error)
    expect(error).toBeInstanceOf(NativeCleanupError)
    expect(error.message).toBe('Native cleanup failed')
    expect(error.cause).toBeUndefined()
    const calls = close.mock.calls.length
    refused = false
    await error.retryCleanup()
    expect(close).toHaveBeenCalledTimes(calls + 1)
    await gone((await json(join(directory, 'launch.json'))).pid)
  } finally {
    close.mockRestore()
  }
})
