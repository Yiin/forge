import { mkdtemp, writeFile, readFile, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect } from 'vitest'
import type { HarnessEvent } from '@forge/protocol/harness'
import type { HarnessHandle } from '../types.js'
import { createCodexAdapter, type CodexAdapterOptions } from './index.js'

export type Step = {
  method: string
  expected?: unknown
  result?: unknown
  error?: { code: number; message: string }
  before?: unknown[]
  after?: unknown[]
  delay?: number
  exit?: boolean
}
const peers: { root: string; handles: HarnessHandle[] }[] = []
afterEach(async () => {
  for (const peer of peers.splice(0)) {
    await Promise.all(peer.handles.map((handle) => handle.kill()))
    await rm(peer.root, { recursive: true, force: true })
  }
})
export const sandbox = {
  type: 'workspaceWrite',
  writableRoots: [],
  networkAccess: false,
  excludeSlashTmp: false,
  excludeTmpdirEnvVar: false,
} as const
export const turn = (
  id = 't1',
  status = 'inProgress',
  items: unknown[] = [],
  itemsView = 'full',
) => ({ id, status, items, itemsView })
export const notify = (method: string, params: unknown) => ({ method, params })
export const turnFrame = (
  method: 'started' | 'completed',
  id = 't1',
  status = method === 'started' ? 'inProgress' : 'completed',
  threadId = 'root',
  items: unknown[] = [],
) => notify(`turn/${method}`, { threadId, turn: turn(id, status, items) })
export const itemFrame = (item: unknown, turnId = 't1', threadId = 'root') =>
  notify('item/completed', { threadId, turnId, item })
export const model = {
  id: 'catalog-m',
  model: 'm',
  displayName: 'Model',
  description: 'Fake model',
  hidden: false,
  isDefault: true,
  defaultReasoningEffort: 'medium',
  supportedReasoningEfforts: [
    { reasoningEffort: 'medium', description: 'Medium' },
    { reasoningEffort: 'novel', description: 'Novel' },
  ],
  inputModalities: ['text', 'image'],
  serviceTiers: [{ id: 'priority', name: 'Priority', description: 'Priority' }],
  defaultServiceTier: 'default',
}
export async function peer(
  extra: Step[] = [],
  settings: {
    config?: Record<string, unknown>
    threadResponse?: Record<string, unknown>
    load?: boolean
    selected?: boolean
    modelPages?: Step[]
    environment?: Record<string, string>
    absent?: string[]
    eager?: string
    options?: Partial<CodexAdapterOptions>
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'forge-codex-test-'))
  const trace = join(root, 'trace.jsonl')
  const control = join(root, 'control.jsonl')
  const ready = join(root, 'ready')
  const script = join(root, 'script.json')
  const fixture = fileURLToPath(
    new URL('./fixtures/fake-codex.mjs', import.meta.url),
  )
  const thread = {
    id: 'root',
    sessionId: 'tree',
    cliVersion: '0.153.4',
    cwd: root,
    createdAt: 1,
    updatedAt: 1,
    ephemeral: false,
    modelProvider: 'openai',
    preview: '',
    projectId: null,
    source: 'cli',
    status: { type: 'idle' },
    turns: [],
  }
  const response = {
    thread,
    cwd: root,
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox,
    model: 'm',
    modelProvider: 'openai',
    reasoningEffort: 'medium',
    serviceTier: 'default',
    ...settings.threadResponse,
  }
  const config = settings.config ?? {
    model: 'm',
    model_reasoning_effort: 'medium',
    service_tier: 'default',
  }
  const startup: Step[] = [
    {
      method: 'initialize',
      expected: {
        clientInfo: { name: 'forge', title: 'Forge', version: '0.2.3' },
        capabilities: { experimentalApi: false },
      },
      result: {
        codexHome: root,
        platformFamily: 'unix',
        platformOs: 'linux',
        userAgent: 'codex/0.153.4 fake',
      },
    },
    { method: 'initialized', expected: {} },
    {
      method: 'config/read',
      expected: { cwd: root, includeLayers: false },
      result: { config, origins: {} },
    },
    {
      method: 'account/read',
      expected: { refreshToken: false },
      result: { account: null, requiresOpenaiAuth: true },
    },
    ...(settings.modelPages ?? [
      {
        method: 'model/list',
        expected: { includeHidden: true, limit: 100 },
        result: { data: [model], nextCursor: null },
      },
    ]),
    {
      method: 'skills/list',
      expected: { cwds: [root], forceReload: false },
      result: { data: [{ cwd: root, errors: [], skills: [] }] },
    },
    {
      method: settings.load ? 'thread/resume' : 'thread/start',
      result: response,
    },
  ]
  await Promise.all([writeFile(control, ''), writeFile(trace, '')])
  const env = { FORGE_CODEX_SCRIPT: script, CODEX_HOME: root }
  const options = (
    settings.selected
      ? {
          provider: 'codex-test',
          accountId: 'account',
          expectedCodexHome: root,
          env,
          nativeLaunch: {
            credentials: 'native-configured-sources',
            provider: 'codex-test',
            canonicalCwd: root,
            account: {
              id: 'account',
              harnessKey: 'codex-test',
              kind: 'codex',
              homePath: root,
              disabledAt: null,
            },
            harness: {
              command: process.execPath,
              args: [fixture],
              env: {},
              adapterKind: 'native',
              enabled: true,
            },
          },
          loadAttachment: async () => {
            throw new Error('Fixture has no attachment')
          },
          ...settings.options,
        }
      : {
          provider: 'codex-test',
          accountId: null,
          command: process.execPath,
          args: [fixture],
          env,
          expectedCodexHome: root,
          loadAttachment: async () => {
            throw new Error('Fixture has no attachment')
          },
          ...settings.options,
        }
  ) as CodexAdapterOptions
  const handles: HarnessHandle[] = []
  peers.push({ root, handles })
  const events: HarnessEvent[] = []
  const save = (steps: Step[]) =>
    writeFile(
      script,
      JSON.stringify({
        trace,
        control,
        ready,
        steps,
        environment: settings.environment,
        absent: settings.absent,
        eager: settings.eager,
      }),
    )
  await save([...startup, ...extra])
  return {
    root,
    thread,
    response,
    events,
    options,
    startup,
    save,
    input: (paused: boolean) =>
      appendFile(
        control,
        JSON.stringify({ action: paused ? 'pauseInput' : 'resumeInput' }) +
          '\n',
      ),
    trace: async (): Promise<Record<string, unknown>[]> =>
      (await readFile(trace, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    send: (frames: unknown[]) =>
      appendFile(control, JSON.stringify({ action: 'frames', frames }) + '\n'),
    raw: (bytes: Buffer) =>
      appendFile(
        control,
        JSON.stringify({ action: 'raw', bytes: bytes.toString('base64') }) +
          '\n',
      ),
    exit: () => appendFile(control, JSON.stringify({ action: 'exit' }) + '\n'),
    start: async () => {
      const adapter = createCodexAdapter(options)
      const session = {
        id: 'session',
        provider: 'codex-test',
        accountId: options.accountId,
        cwd: root,
        ...(settings.load
          ? {
              binding: {
                provider: 'codex-test',
                accountId: options.accountId,
                cwd: root,
                providerSessionId: 'root',
              },
            }
          : {}),
      }
      const handle = await (settings.load ? adapter.load! : adapter.spawn)(
        session,
        (event) => events.push(event),
      )
      handles.push(handle)
      return handle
    },
  }
}
export async function eventually(check: () => unknown | Promise<unknown>) {
  await expect.poll(check, { timeout: 3000 }).toBeTruthy()
}
export const methods = async (p: Awaited<ReturnType<typeof peer>>) =>
  (await p.trace())
    .filter((frame) => typeof frame.method === 'string')
    .map((frame) => frame.method)
