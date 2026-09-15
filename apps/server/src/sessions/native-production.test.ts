import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { connect } from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { accountEnv } from '../accounts/store.js'
import {
  captureAuthority,
  effectiveAuthority,
} from '../harnesses/kimi/authority.js'
import type { KimiReceipt } from '../harnesses/kimi/types.js'
import { KimiHostOwner } from '../harnesses/kimi/host.js'
import {
  fixtureEnvironment,
  finishFixtureHomes,
} from '../harnesses/kimi/__fixtures__/ownership.js'
import {
  createProductionNativeAdapter,
  createNativeResources,
  type ProductionNativeOptions,
} from './native-factory.js'
import { UploadStore } from '../uploads/store.js'
import * as nativeProcessModule from '../harnesses/process.js'
import { NativeCleanupError } from '../harnesses/native-cleanup.js'
import { createNativeAttachmentLoader } from '../uploads/native.js'
import {
  peer as codexPeer,
  turn,
  turnFrame,
} from '../harnesses/codex/test-helpers.js'
import type { ConfirmedPiBinding } from '../harnesses/pi/index.js'
import { fixture as piPeer } from '../harnesses/pi/fixtures/test-support.js'
import type { HarnessConfig } from '@forge/protocol/config'
import type {
  HarnessEvent,
  HarnessHandle,
  HarnessSession,
} from '../harnesses/types.js'
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  while (cleanups.length) {
    await cleanups[cleanups.length - 1]()
    cleanups.pop()
  }
})
async function context(
  provider: string,
  cwd: string,
  entry: HarnessConfig,
  account?: ProductionNativeOptions['account'],
) {
  const dataDir = await mkdtemp(join(tmpdir(), 'forge-native-composition-'))
  const db = new DatabaseSync(':memory:')
  db.exec(
    'CREATE TABLE sessions(id TEXT PRIMARY KEY, harness TEXT, account_id TEXT, cwd TEXT, deleted_at INTEGER, project_id TEXT); CREATE TABLE projects(id TEXT PRIMARY KEY, deleted_at INTEGER)',
  )
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, NULL, NULL)').run(
    'session',
    provider,
    account?.id ?? null,
    cwd,
  )
  db.exec(
    readFileSync(
      new URL(
        '../../drizzle/0027_native_provider_records.sql',
        import.meta.url,
      ),
      'utf8',
    ),
  )
  const uploads = new UploadStore(db, { dataDir }),
    resources = createNativeResources(),
    handles: HarnessHandle[] = []
  cleanups.push(async () => {
    for (const handle of handles) await handle.kill()
    await resources.close()
    uploads.close()
    db.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  const options = {
    entry,
    account,
    db,
    dataDir,
    uploads,
    resources,
    loadAttachment: createNativeAttachmentLoader(db, dataDir),
  }
  const session: HarnessSession = {
    id: 'session',
    provider,
    accountId: account?.id ?? null,
    cwd,
  }
  const events: HarnessEvent[] = []
  const adapter = createProductionNativeAdapter(provider, options)
  return {
    adapter,
    options,
    session,
    events,
    db,
    async open(load = false, binding?: HarnessSession['binding']) {
      const handle = await (load ? adapter.load! : adapter.spawn)(
        { ...session, binding },
        (event) => events.push(event),
      )
      handles.push(handle)
      expect(Boolean(handle.steer)).toBe(Boolean(adapter.capabilities.steer))
      return handle
    },
  }
}
const entry = (
  command: string,
  args: string[] = [],
  env: Record<string, string> = {},
): HarnessConfig => ({
  name: 'Synthetic native',
  command,
  args,
  env,
  enabled: true,
  adapterKind: 'native',
  protocol: 'acp',
})
it('Codex production composition completes a real JSON-RPC turn and exact resume', async () => {
  const completion = {
    method: 'turn/start',
    result: { turn: turn() },
    after: [turnFrame('started'), turnFrame('completed')],
  }
  const peer = await codexPeer([completion])
  const f = await context(
    'codex',
    peer.root,
    entry(
      peer.options.command!,
      peer.options.args,
      peer.options.env as Record<string, string>,
    ),
  )
  const first = await f.open()
  expect(await (await first.prompt('hello')).completion).toMatchObject({
    status: 'completed',
  })
  const binding = first.binding
  expect(binding?.providerSessionId).toBe('root')
  await first.kill()
  await peer.save([
    ...peer.startup.map((step) =>
      step.method === 'thread/start'
        ? { ...step, method: 'thread/resume' }
        : step,
    ),
    completion,
  ])
  const resumed = await f.open(true, binding)
  expect((await (await resumed.prompt('again')).completion).status).toBe(
    'completed',
  )
  expect(
    f.events.filter((event) => event.type === 'turn_completed'),
  ).toHaveLength(2)
  await resumed.kill()
  f.db.exec(
    "CREATE TRIGGER refuse_binding BEFORE UPDATE ON native_provider_state WHEN NEW.name = 'binding' BEGIN SELECT RAISE(FAIL, 'binding refused'); END",
  )
  await expect(f.open(true, binding)).rejects.toThrow('binding refused')
  const original = guardian.codexChildren.at(-1)!
  expect(original.pid).toBeDefined()
  expect(original.exitCode !== null || original.signalCode !== null).toBe(true)
  expect(original.stdout?.destroyed).toBe(true)
}, 30000)
it('Pi production composition persists native records and reloads the exact session file', async () => {
  const peer = await piPeer()
  cleanups.unshift(() => peer.close())
  const account = {
    ...peer.options.launch.account!,
    harnessKey: 'pi',
    config: { provider: 'fake', model: 'model/one', thinking: 'high' },
    label: 'Synthetic',
    orderIndex: 0,
    createdAt: 0,
    lastUsedAt: null,
  }
  const f = await context(
    'pi',
    peer.cwd,
    entry(peer.executable, peer.options.args),
    account as ProductionNativeOptions['account'],
  )
  const first = await f.open()
  expect(
    first.configOptions?.().find((option) => option.id === 'thinking')
      ?.currentValue,
  ).toBe('high')
  expect(await (await first.prompt('hello')).completion).toMatchObject({
    status: 'completed',
  })
  const binding = first.binding
  await first.kill()
  const resumed = await f.open(true, binding)
  const launch = await peer.started()
  expect(launch.args).toContain('--session')
  expect(launch.args).toContain((binding as ConfirmedPiBinding).sessionFile)
  expect(resumed.binding).toEqual(binding)
  expect((await (await resumed.prompt('again')).completion).status).toBe(
    'completed',
  )
  expect(
    (
      f.db
        .prepare('SELECT count(*) AS n FROM native_provider_records')
        .get() as { n: number }
    ).n,
  ).toBeGreaterThan(0)
}, 30000)
it('OpenCode production composition uses an owned native HTTP server and exact load', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'forge-opencode-composition-'))
  cleanups.unshift(() => rm(cwd, { recursive: true, force: true }))
  const executable = fileURLToPath(
    new URL('../harnesses/fixtures/opencode-server.mjs', import.meta.url),
  )
  const config = join(cwd, 'fixture.json')
  await writeFile(
    config,
    JSON.stringify({ mode: 'complete', report: join(cwd, 'requests.json') }),
  )
  const f = await context(
    'opencode',
    cwd,
    entry(executable, [], { FORGE_OPENCODE_FIXTURE_CONFIG: config }),
  )
  const first = await f.open()
  const result = await (await first.prompt('hello')).completion
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'completed' })
  const binding = first.binding
  await first.kill()
  const resumed = await f.open(true, binding)
  const report = JSON.parse(
    readFileSync(join(cwd, 'requests.json'), 'utf8'),
  ) as { requests: { method: string; path: string }[] }
  expect(
    report.requests.some(
      (request) => request.method === 'POST' && request.path === '/session',
    ),
  ).toBe(false)
  expect(
    report.requests.some(
      (request) =>
        request.method === 'GET' && request.path === '/session/ses_fixture',
    ),
  ).toBe(true)
  expect(resumed.binding?.providerSessionId).toBe(binding?.providerSessionId)
  expect((await (await resumed.prompt('again')).completion).status).toBe(
    'completed',
  )
}, 30000)

const guardian = vi.hoisted(() => ({
  artifact: '',
  wrapper: '',
  runtime: '',
  codexChildren: [] as import('node:child_process').ChildProcess[],
}))
vi.mock('node:child_process', async (originalImport) => {
  const original = await originalImport<typeof import('node:child_process')>()
  return {
    ...original,
    spawn: ((command, args, options) => {
      if (Array.isArray(args) && args[0] === guardian.artifact) {
        if (args.length !== 2 || !guardian.runtime)
          throw new Error('Invalid owned guardian fixture')
        return original.spawn(
          command,
          [guardian.wrapper, args[0], guardian.runtime, args[1]!],
          options ?? {},
        )
      }
      const child = Reflect.apply(original.spawn, original, [
        command,
        args,
        options,
      ])
      if (options?.env?.FORGE_CODEX_SCRIPT) guardian.codexChildren.push(child)
      return child
    }) as typeof original.spawn,
  }
})
async function kimiControl(
  home: string,
  command: unknown,
): Promise<{ sessions?: { active: unknown }[] }> {
  return new Promise((resolve, reject) => {
    const socket = connect(join(home, 'fixture.sock'))
    const timer = setTimeout(
      () => socket.destroy(new Error('Owned fixture control deadline')),
      5000,
    )
    let data = ''
    socket.once('connect', () => socket.end(JSON.stringify(command) + '\n'))
    socket.on('data', (bytes) => {
      data += bytes
    })
    socket.once('error', reject)
    socket.once('close', () => clearTimeout(timer))
    socket.once('end', () => {
      try {
        resolve(JSON.parse(data))
      } catch (error) {
        reject(error)
      }
    })
  })
}
it('Kimi production composition commits native checkpoints and resumes its exact session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forge-kimi-composition-'))
  const home = join(root, 'home'),
    cwd = join(root, 'workspace')
  await mkdir(home, { mode: 0o700 })
  await mkdir(cwd)
  guardian.runtime = join(root, 'runtime')
  await mkdir(guardian.runtime, { mode: 0o700 })
  guardian.artifact = fileURLToPath(
    new URL('../../../../dist/kimi-guardian.js', import.meta.url),
  )
  guardian.wrapper = fileURLToPath(
    new URL('../harnesses/kimi/__fixtures__/guardian.mjs', import.meta.url),
  )
  const environment = await fixtureEnvironment(home)
  cleanups.unshift(async () => {
    await finishFixtureHomes([home])
    await rm(root, { recursive: true, force: true })
  })
  const executable = fileURLToPath(
    new URL('../harnesses/kimi/__fixtures__/peer.mjs', import.meta.url),
  )
  const account = {
    id: 'kimi-account',
    harnessKey: 'kimi',
    kind: 'kimi' as const,
    homePath: home,
    label: 'Synthetic',
    orderIndex: 0,
    disabledAt: null,
    createdAt: 0,
    lastUsedAt: null,
  }
  const env = Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
  const f = await context('kimi', cwd, entry(executable, [], env), account)
  const complete = async (handle: HarnessHandle) => {
    const receipt = await handle.prompt('hello')
    const delivery = await (receipt as KimiReceipt).delivery
    await vi.waitFor(async () =>
      expect(
        (await kimiControl(home, { op: 'inspect' })).sessions?.some(
          (session) => session.active,
        ),
      ).toBe(true),
    )
    await kimiControl(home, {
      op: 'frame',
      sessionId: handle.binding!.providerSessionId,
      type: 'tool.call.started',
      payload: {
        turnId: Number((delivery as { providerTurnId: string }).providerTurnId),
        toolCallId: `tool-${receipt.runId}`,
        name: 'Read',
        input: {},
      },
    })
    await vi.waitFor(() =>
      expect(
        (
          f.db.prepare('SELECT value FROM native_provider_records').all() as {
            value: string
          }[]
        ).some((row) => {
          const value = JSON.parse(row.value)
          return (
            value.kind === 'tool.owner' && value.root.runId === receipt.runId
          )
        }),
      ).toBe(true),
    )
    await kimiControl(home, {
      op: 'finish',
      sessionId: handle.binding!.providerSessionId,
      content: [{ type: 'text', text: 'Kimi native result' }],
    })
    expect(await receipt.completion).toMatchObject({ status: 'completed' })
  }
  const host = f.options.resources.kimi as KimiHostOwner
  const helper = await host.acquire(
    await effectiveAuthority(
      captureAuthority(
        {
          provider: 'kimi',
          account: { ...account, adapterKind: 'native' },
          harness: f.options.entry,
          credentialPolicy: 'configured-native',
          environment: { ...env, ...accountEnv('kimi', home) },
        },
        host.budget.limits,
      ),
    ),
    'helper',
  )
  cleanups.push(() => helper.close())
  const first = await f.open()
  await complete(first)
  const binding = first.binding
  await first.kill()
  const resumed = await f.open(true, binding)
  expect(resumed.binding).toEqual(binding)
  await complete(resumed)
  expect(
    (
      f.db
        .prepare('SELECT count(*) AS n FROM native_provider_records')
        .get() as { n: number }
    ).n,
  ).toBeGreaterThan(0)
}, 30000)

const cursorPeer = vi.hoisted(() => ({ entry: '' }))
vi.mock('../harnesses/cursor/container.js', async (originalImport) => {
  const original =
    await originalImport<typeof import('../harnesses/cursor/container.js')>()
  return {
    ...original,
    CursorContainer: class extends original.CursorContainer {
      constructor(
        ...args: ConstructorParameters<typeof original.CursorContainer>
      ) {
        super(
          { ...args[0], entry: cursorPeer.entry },
          ...(args.slice(1) as [
            (typeof args)[1],
            (typeof args)[2],
            (typeof args)[3],
            (typeof args)[4],
            (typeof args)[5],
            (typeof args)[6],
            (typeof args)[7],
            (typeof args)[8],
          ]),
        )
      }
    },
  }
})
it('Cursor production composition persists owned SDK records and reloads the exact agent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forge-cursor-composition-'))
  const accounts = join(root, 'accounts'),
    home = join(accounts, 'synthetic')
  await mkdir(home, { recursive: true, mode: 0o700 })
  await mkdir(join(root, 'cursor-sidecar'))
  cursorPeer.entry = join(root, 'cursor-sidecar', 'sidecar.mjs')
  await promisify(execFile)(
    'bun',
    [
      'build',
      '--target=node',
      '--external',
      '@cursor/sdk',
      'apps/server/test/fixtures/cursor-peer.ts',
      '--outfile',
      cursorPeer.entry,
    ],
    { cwd: process.cwd(), timeout: 30000 },
  )
  const previous = process.env.FORGE_ACCOUNTS_DIR
  process.env.FORGE_ACCOUNTS_DIR = accounts
  cleanups.unshift(async () => {
    if (previous === undefined) delete process.env.FORGE_ACCOUNTS_DIR
    else process.env.FORGE_ACCOUNTS_DIR = previous
    await rm(root, { recursive: true, force: true })
  })
  const account = {
    id: 'cursor-account',
    harnessKey: 'cursor',
    kind: 'cursor' as const,
    adapterKind: 'native' as const,
    homePath: home,
    label: 'Synthetic',
    orderIndex: 0,
    disabledAt: null,
    createdAt: 0,
    lastUsedAt: null,
  }
  const f = await context(
    'cursor',
    root,
    entry(process.execPath, [], { CURSOR_API_KEY: 'synthetic-key' }),
    account,
  )
  const first = await f.open()
  const outcome = await (await first.prompt('hello')).completion
  expect(outcome, JSON.stringify(outcome)).toMatchObject({
    status: 'completed',
  })
  const binding = first.binding
  await first.kill()
  const resumed = await f.open(true, binding)
  expect(resumed.binding).toEqual(binding)
  const second = await (await resumed.prompt('again')).completion
  expect(second, JSON.stringify(second)).toMatchObject({ status: 'completed' })
  expect(
    (
      f.db
        .prepare('SELECT count(*) AS n FROM native_provider_records')
        .get() as { n: number }
    ).n,
  ).toBeGreaterThan(0)
}, 30000)

it('retains the original typed startup cleanup owner until backend shutdown', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'forge-native-startup-refusal-'))
  cleanups.unshift(() => rm(cwd, { recursive: true, force: true }))
  const f = await context('codex', cwd, entry(process.execPath))
  const cleanup = vi.fn().mockResolvedValue(undefined)
  const failure = new NativeCleanupError(cleanup)
  const start = vi
    .spyOn(nativeProcessModule, 'startNativeProcess')
    .mockRejectedValueOnce(failure)
  try {
    await expect(f.open()).rejects.toBe(failure)
  } finally {
    start.mockRestore()
  }
  expect(cleanup).not.toHaveBeenCalled()
  await f.options.resources.close()
  expect(cleanup).toHaveBeenCalledTimes(1)
})
