import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { watch, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  harnessEventSchema,
  type HarnessEvent,
  type DispatchOptions,
  type ConfirmedNativeBinding,
} from '@forge/protocol/harness'
import {
  emptyTimeline,
  reduceTimeline,
  timelineRunKey,
} from '@forge/protocol/timeline'
import {
  createClaudeAdapter,
  type ClaudeAdapterOptions,
  type ClaudeHandle,
} from './index.js'
import { LIMITS, MiB, type Identities } from './wire.js'
import { deferred } from '../transport-test-helpers.js'
import type { NativeProcess } from '../process.js'
import type { JsonlTransport } from '../jsonl.js'
import type { Attachment } from './input.js'

const fixture = resolve(import.meta.dirname, 'fixtures/fake-claude.mjs')
const directories: string[] = []
const handles: ClaudeHandle[] = []
type Action = Record<string, unknown>
const init = (extra: Record<string, unknown> = {}): Action => ({
  send: {
    type: 'system',
    subtype: 'init',
    session_id: '$session',
    claude_code_version: '2.1.258',
    capabilities: ['msg_lifecycle_v1', 'interrupt_cancel_queued_v1'],
    ...extra,
  },
})
const user = (name = 'user'): Action => ({
  expect: { type: 'user', parent_tool_use_id: null, message: { role: 'user' } },
  capture: name,
})
const started = (name = 'user'): Action => ({
  send: {
    type: 'command_lifecycle',
    command_uuid: `$${name}.uuid`,
    state: 'started',
    uuid: '$new',
    session_id: '$session',
  },
})
const full = (text = 'hello', extra: Record<string, unknown> = {}): Action => ({
  send: {
    type: 'assistant',
    message: { id: '$new', content: [{ type: 'text', text }] },
    uuid: '$new',
    ...extra,
  },
})
const result = (extra: Record<string, unknown> = {}): Action => ({
  send: {
    type: 'result',
    subtype: 'success',
    session_id: '$session',
    usage: { input_tokens: 2, output_tokens: 3 },
    uuid: '$new',
    ...extra,
  },
})
const stream = (
  event: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Action => ({ send: { type: 'stream_event', event, uuid: '$new', ...extra } })
const control = (
  subtype: string,
  capture = 'control',
  response?: unknown,
): Action => ({
  expect: { type: 'control_request', request: { subtype } },
  capture,
  controlSuccess: true,
  ...(response === undefined ? {} : { response }),
})
const permission = (extra: Record<string, unknown> = {}): Action => ({
  send: {
    type: 'control_request',
    request_id: 'native-request',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      tool_use_id: 'bash',
      input: { command: 'pwd', retained: true },
      decision_reason: 'Read the work directory',
      blocked_path: '/tmp/example',
      ...extra,
    },
  },
})
const question = (questions?: unknown[]): Action =>
  permission({
    tool_name: 'AskUserQuestion',
    input: {
      retained: 'original',
      questions: questions ?? [
        {
          question: 'Choose features',
          header: 'Features',
          multiSelect: true,
          options: [
            { label: 'One', description: 'First' },
            { label: 'Two', description: 'Second' },
          ],
        },
      ],
    },
  })
const reply = (response: Record<string, unknown>): Action => ({
  expect: {
    type: 'control_response',
    response: { subtype: 'success', request_id: 'native-request', response },
  },
})
async function file(directory: string, name: string) {
  const path = join(directory, name)
  if (existsSync(path)) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      watcher.close()
      reject(new Error(`Fixture did not reach ${name}`))
    }, 4000)
    const check = () => {
      if (existsSync(join(directory, 'failure.txt'))) {
        clearTimeout(timer)
        watcher.close()
        reject(new Error('Fixture assertion failed'))
        return
      }
      if (existsSync(path)) {
        clearTimeout(timer)
        watcher.close()
        resolve()
      }
    }
    const watcher = watch(directory, check)
    check()
  })
}
async function setup(
  actions: Action[] = [],
  options: ClaudeAdapterOptions = {},
  spec: Record<string, unknown> = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'forge-claude-'))
  directories.push(directory)
  await writeFile(
    join(directory, 'scenario.json'),
    JSON.stringify({ cwd: directory, actions, ...spec }),
  )
  const events: HarnessEvent[] = []
  const listeners = new Set<() => void>()
  const emit = (event: HarnessEvent) => {
    expect(harnessEventSchema.parse(event)).toEqual(event)
    events.push(event)
    for (const notify of listeners) notify()
  }
  const adapter = createClaudeAdapter({
    command: process.execPath,
    args: [fixture],
    accountId: 'fixture',
    env: {
      FORGE_CLAUDE_FIXTURE: directory,
      CLAUDE_CONFIG_DIR: join(directory, 'account'),
    },
    interruptGraceMs: 80,
    controlTimeoutMs: 1000,
    ...options,
  })
  const session = {
    id: 'forge-session',
    provider: 'claude-custom',
    accountId: options.accountId === undefined ? 'fixture' : options.accountId,
    cwd: directory,
  }
  const start = async (binding?: ConfirmedNativeBinding) => {
    const handle = binding
      ? await adapter.load({ ...session, binding }, emit)
      : await adapter.spawn(session, emit)
    handles.push(handle)
    return handle
  }
  const until = (predicate: (events: HarnessEvent[]) => boolean) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(check)
        reject(new Error('Expected Claude event did not arrive'))
      }, 4000)
      const check = () => {
        if (predicate(events)) {
          clearTimeout(timer)
          listeners.delete(check)
          resolve()
        }
      }
      listeners.add(check)
      check()
    })
  return {
    directory,
    adapter,
    session,
    events,
    emit,
    start,
    until,
    gate: (name = 'go') => writeFile(join(directory, name), 'ready'),
    finished: () => file(directory, 'finished'),
    wire: async () =>
      (await readFile(join(directory, 'stdin.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  }
}
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.kill()
  for (const directory of directories.splice(0)) {
    if (existsSync(join(directory, 'failure.txt')))
      throw new Error(await readFile(join(directory, 'failure.txt'), 'utf8'))
    await rm(directory, { recursive: true, force: true })
  }
})
const text = (events: HarnessEvent[], child = false) =>
  events
    .filter((e) => e.type === 'text_delta' && Boolean(e.childId) === child)
    .map((e) => (e.type === 'text_delta' ? e.text : ''))
    .join('')

describe('Claude native process', () => {
  it('discovers the captured catalog without sending a user message', async () => {
    const t = await setup()
    const handle = await t.start()
    await t.finished()
    expect(handle.binding).toBeNull()
    expect(handle.availableModels?.map((m) => m.id)).toContain('opus[1m]')
    expect(
      handle.catalog.commands.find((c) => c.name === 'list-agents'),
    ).toMatchObject({ aliases: ['peers'], argumentHint: '' })
    expect(handle.configOptions?.()[0]?.options).toEqual(
      expect.arrayContaining([
        { value: 'xhigh', name: 'xhigh' },
        { value: 'max', name: 'max' },
      ]),
    )
    expect((await t.wire()).map((f) => f.type)).toEqual([
      'control_request',
      'control_request',
    ])
    expect(t.events).toHaveLength(0)
  })
  it('publishes only acknowledged bindings and keeps a process for two supplied turn identities', async () => {
    const t = await setup([
      user(),
      { mark: 'received', wait: 'go' },
      init(),
      started(),
      full(),
      result(),
      user('second'),
      started('second'),
      full('again'),
      result(),
    ])
    const handle = await t.start()
    const first = await handle.prompt('one', undefined, {
      runId: 'run',
      turnId: 'one',
    })
    await file(t.directory, 'received')
    expect(handle.binding).toBeNull()
    await t.gate()
    expect(await first.completion).toEqual({
      status: 'completed',
      runId: 'run',
      turnId: 'one',
    })
    expect(Object.isFrozen(handle.binding)).toBe(true)
    expect(handle.binding).toMatchObject({
      provider: 'claude-custom',
      accountId: 'fixture',
      cwd: t.directory,
    })
    const second = await handle.prompt('two', undefined, {
      runId: 'run',
      turnId: 'two',
    })
    expect(first.completion).not.toBe(second.completion)
    expect(await second.completion).toMatchObject({
      status: 'completed',
      turnId: 'two',
    })
    expect(text(t.events)).toBe('helloagain')
    expect(t.events.filter((e) => e.type === 'run_started')).toHaveLength(1)
    await t.finished()
  })
  it('restores exactly the saved binding without a fresh fallback', async () => {
    const t = await setup([user(), init(), started(), full(), result()])
    const first = await t.start()
    await (
      await first.prompt('first')
    ).completion
    const binding = first.binding!
    await first.kill()
    await writeFile(
      join(t.directory, 'scenario.json'),
      JSON.stringify({
        cwd: t.directory,
        resume: binding.providerSessionId,
        actions: [user(), init(), started(), full('restored'), result()],
      }),
    )
    const second = await t.start(binding)
    expect(second.binding).toBeNull()
    await (
      await second.prompt('resume')
    ).completion
    expect(second.binding).toEqual(binding)
    const launch = JSON.parse(
      await readFile(join(t.directory, 'launch.json'), 'utf8'),
    )
    expect(launch.argv).toContain(`--resume=${binding.providerSessionId}`)
    expect(launch.argv).not.toContain('--session-id')
  })
  it.each(['startupExit', 'invalidCatalog'])(
    'rejects %s during initialize and cleans up',
    async (kind) => {
      const t = await setup([], {}, { [kind]: true })
      await expect(t.start()).rejects.toThrow()
    },
  )
  it('rejects a delayed resume identity mismatch without changing the saved binding', async () => {
    const t = await setup([user(), init({ session_id: 'another-session' })])
    const binding = Object.freeze({
      provider: t.session.provider,
      accountId: 'fixture',
      cwd: t.directory,
      providerSessionId: 'native-existing',
    })
    const handle = await t.start(binding)
    const receipt = await handle.prompt('resume')
    expect(await receipt.completion).toMatchObject({ status: 'failed' })
    expect(handle.binding).toBeNull()
    expect(binding.providerSessionId).toBe('native-existing')
    expect(
      JSON.parse(await readFile(join(t.directory, 'launch.json'), 'utf8'))
        .resume,
    ).toBe('native-existing')
  })
  it('checks provider, account, and canonical cwd before spawn', async () => {
    const t = await setup([user(), init(), started(), result()])
    const binding = {
      provider: t.session.provider,
      accountId: 'fixture',
      cwd: t.directory,
      providerSessionId: 'native-existing',
    }
    for (const patch of [
      { provider: 'other' },
      { accountId: 'other' },
      { cwd: tmpdir() },
      { providerSessionId: null },
    ])
      await expect(
        t.adapter.load(
          { ...t.session, binding: { ...binding, ...patch } },
          t.emit,
        ),
      ).rejects.toThrow()
    await expect(
      t.adapter.spawn({ ...t.session, binding }, t.emit),
    ).rejects.toThrow('Use load')
    expect(existsSync(join(t.directory, 'launch.json'))).toBe(false)
    const link = join(t.directory, 'link')
    await symlink(t.directory, link)
    const handle = await t.adapter.load(
      { ...t.session, binding: { ...binding, cwd: link } },
      t.emit,
    )
    handles.push(handle)
    await (
      await handle.prompt('canonical')
    ).completion
    await t.finished()
    expect(handle.binding?.cwd).toBe(t.directory)
  })
  it.each([
    '--',
    '--no-session-persistence',
    '--continue',
    '-c',
    '--fork-session',
    '--resume=x',
    '-r=x',
    '--permission-mode=yolo',
    '--session-id=x',
    '--output-format=json',
    '--replay-user-messages',
  ])('rejects owned launch flag %s before spawn', async (flag) => {
    const t = await setup([], { args: [fixture, flag] })
    await expect(t.start()).rejects.toThrow('adapter owns')
    expect(existsSync(join(t.directory, 'launch.json'))).toBe(false)
  })
  it('preserves plugins and isolates selected accounts from inherited credentials and backend selectors', async () => {
    const names = [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_FOUNDRY',
      'CLAUDE_CODE_USE_ANTHROPIC_AWS',
      'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
      'CLAUDE_CODE_USE_MANTLE',
      'CLAUDE_CODE_USE_VERTEX',
      'ANTHROPIC_BASE_URL',
      'CLAUDECODE',
    ]
    const previous = names.map((name) => process.env[name])
    try {
      for (const name of names) process.env[name] = 'inherited-sentinel'
      const t = await setup(
        [],
        {
          args: [
            fixture,
            '--plugin-dir',
            '/tmp/plugin',
            '--settings',
            '/tmp/settings.json',
          ],
        },
        {
          absentEnv: names,
          args: [
            '--plugin-dir',
            '/tmp/plugin',
            '--settings',
            '/tmp/settings.json',
          ],
        },
      )
      await t.start()
      await t.finished()
    } finally {
      names.forEach((name, index) => {
        if (previous[index] === undefined) delete process.env[name]
        else process.env[name] = previous[index]
      })
    }
  })
  it('keeps explicit account overrides and separate catalogs, bindings, and generations', async () => {
    const a = await setup(
      [user(), init(), started(), full(), result()],
      { accountId: 'account-a' },
      { catalogModel: 'Account A' },
    )
    const b = await setup(
      [user(), init(), started(), full(), result()],
      { accountId: 'account-b' },
      { catalogModel: 'Account B' },
    )
    const adapter = createClaudeAdapter({
      command: process.execPath,
      args: [fixture],
      accountId: 'account-b',
      env: {
        FORGE_CLAUDE_FIXTURE: b.directory,
        CLAUDE_CONFIG_DIR: join(b.directory, 'account'),
        ANTHROPIC_API_KEY: 'explicit-sentinel',
        CLAUDE_CODE_USE_VERTEX: '0',
        ANTHROPIC_BASE_URL: 'https://example.invalid',
      },
    })
    await writeFile(
      join(b.directory, 'scenario.json'),
      JSON.stringify({
        env: {
          ANTHROPIC_API_KEY: 'explicit-sentinel',
          CLAUDE_CODE_USE_VERTEX: '0',
          ANTHROPIC_BASE_URL: 'https://example.invalid',
        },
        catalogModel: 'Account B',
        actions: [user(), init(), started(), full(), result()],
      }),
    )
    const [ha, hb] = await Promise.all([
      a.start(),
      adapter.spawn(b.session, b.emit),
    ])
    handles.push(hb)
    await Promise.all([
      (await ha.prompt('a')).completion,
      (await hb.prompt('b')).completion,
    ])
    expect(ha.availableModels?.[0]?.displayName).toBe('Account A')
    expect(hb.availableModels?.[0]?.displayName).toBe('Account B')
    expect(ha.binding?.providerSessionId).not.toBe(
      hb.binding?.providerSessionId,
    )
    expect(a.events[0]?.runtimeGeneration).not.toBe(
      b.events[0]?.runtimeGeneration,
    )
  })
})

describe('Claude content and root ownership', () => {
  it.each([true, false])(
    'streams through the owned UUID before full text, started=%s',
    async (lifecycle) => {
      const t = await setup([
        user(),
        init(),
        ...(lifecycle ? [started()] : []),
        stream(
          { type: 'message_start', message: { id: 'message' } },
          { user_message_uuid: '$user.uuid' },
        ),
        stream({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
        stream({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'hel' },
        }),
        { mark: 'partial', wait: 'go' },
        full('hello', {
          message: {
            id: 'message',
            content: [{ type: 'text', text: 'hello' }],
          },
        }),
        stream({ type: 'message_stop' }),
        {
          send: {
            type: 'system',
            subtype: 'session_state_changed',
            state: 'idle',
          },
        },
        { mark: 'stopped', wait: 'result' },
        result(),
      ])
      const handle = await t.start()
      const receipt = await handle.prompt('prompt', undefined, {
        runId: 'owned-run',
        turnId: 'owned-turn',
      })
      let settled = false
      void receipt.completion.then(() => {
        settled = true
      })
      await t.until((events) => text(events) === 'hel')
      expect(settled).toBe(false)
      await t.gate()
      await file(t.directory, 'stopped')
      expect(settled).toBe(false)
      expect(text(t.events)).toBe('hello')
      expect(
        new Set(
          t.events
            .filter((e) => e.type === 'text_delta')
            .map((e) => ('itemId' in e ? e.itemId : '')),
        ).size,
      ).toBe(1)
      await t.gate('result')
      expect(await receipt.completion).toMatchObject({
        status: 'completed',
        turnId: 'owned-turn',
      })
    },
  )
  it('reconciles thinking, two text blocks, and interleaved child full frames', async () => {
    const t = await setup([
      user(),
      init(),
      started(),
      stream({ type: 'message_start', message: { id: 'root-message' } }),
      stream({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '' },
      }),
      stream({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'reason' },
      }),
      full('', {
        message: {
          id: 'root-message',
          content: [{ type: 'thinking', thinking: 'reason' }],
        },
      }),
      full('', {
        message: {
          id: 'spawn',
          content: [
            {
              type: 'tool_use',
              id: 'agent',
              name: 'Agent',
              input: { prompt: 'work', description: 'Child' },
            },
          ],
        },
      }),
      full('child', {
        parent_tool_use_id: 'agent',
        message: {
          id: 'child-message',
          content: [{ type: 'text', text: 'child' }],
        },
      }),
      stream({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'text', text: '' },
      }),
      stream({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'first' },
      }),
      stream({
        type: 'content_block_start',
        index: 2,
        content_block: { type: 'text', text: '' },
      }),
      stream({
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'text_delta', text: 'second' },
      }),
      full('', {
        message: {
          id: 'root-message',
          content: [
            { type: 'text', text: 'first' },
            { type: 'text', text: 'second' },
          ],
        },
      }),
      result(),
    ])
    const h = await t.start()
    await (
      await h.prompt('go')
    ).completion
    expect(text(t.events)).toBe('firstsecond')
    expect(text(t.events, true)).toBe('child')
    expect(
      t.events
        .filter((e) => e.type === 'thought_delta')
        .map((e) => e.text)
        .join(''),
    ).toBe('reason')
    expect(
      new Set(
        t.events
          .filter((e) => e.type === 'text_delta' && !e.childId)
          .map((e) => ('itemId' in e ? e.itemId : '')),
      ).size,
    ).toBe(2)
  })
  it('keeps a later EOF failure attached to its own completion', async () => {
    const t = await setup([
      user(),
      init(),
      started(),
      full(),
      result(),
      user('two'),
      started('two'),
      full('partial second'),
      { exit: 0 },
    ])
    const h = await t.start()
    const one = await h.prompt('one', undefined, {
      runId: 'run',
      turnId: 'one',
    })
    expect(await one.completion).toMatchObject({ status: 'completed' })
    const two = await h.prompt('two', undefined, {
      runId: 'run',
      turnId: 'two',
    })
    expect(await two.completion).toMatchObject({
      status: 'failed',
      turnId: 'two',
    })
    await h.kill()
    expect(t.events.filter((e) => e.type === 'run_failed')).toHaveLength(1)
    expect(await one.completion).toMatchObject({ status: 'completed' })
  })
  it('keeps a checked automatic wake and its permission separate from accepted pending input', async () => {
    const t = await setup([
      user(),
      init(),
      started(),
      full('A'),
      result({ uuid: 'result-a' }),
      user('b'),
      {
        send: {
          type: 'command_lifecycle',
          command_uuid: 'internal-command',
          state: 'started',
        },
      },
      init(),
      started(),
      result({ uuid: 'result-a' }),
      stream({ type: 'message_start', message: { id: 'wake-message' } }),
      stream({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
      {
        repeat: 300,
        actions: [
          stream({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'w' },
          }),
        ],
      },
      permission(),
      reply({ behavior: 'deny', message: 'The user denied this tool.' }),
      result({ uuid: 'wake-result', origin: { kind: 'task-notification' } }),
      started('b'),
      full('B'),
      result({ user_message_uuid: '$b.uuid' }),
      result({ uuid: 'wake-result', origin: { kind: 'task-notification' } }),
      started(),
    ])
    const h = await t.start()
    await (
      await h.prompt('A', undefined, { runId: 'run', turnId: 'a' })
    ).completion
    const b = await h.prompt('B', undefined, { runId: 'run', turnId: 'b' })
    let completeB = false
    void b.completion.then(() => {
      completeB = true
    })
    await t.until((events) =>
      events.some((e) => e.type === 'permission_requested'),
    )
    expect(completeB).toBe(false)
    const request = t.events.find((e) => e.type === 'permission_requested')!
    expect(request.type).toBe('permission_requested')
    if (request.type !== 'permission_requested')
      throw new Error('Missing permission')
    expect(request.turnId).not.toBe('a')
    expect(request.turnId).not.toBe('b')
    expect(text(t.events)).toBe(`A${'w'.repeat(300)}`)
    await h.replyPermission?.({
      type: 'selected',
      requestId: request.request.requestId,
      optionId: 'deny',
    })
    expect(await b.completion).toMatchObject({
      status: 'completed',
      turnId: 'b',
    })
    await t.finished()
    expect(t.events.filter((e) => e.type === 'turn_started')).toHaveLength(3)
    expect(t.events.filter((e) => e.type === 'turn_completed')).toHaveLength(3)
    expect(t.events.filter((e) => e.type === 'run_failed')).toHaveLength(0)
  })
  it.each([
    {},
    { claude_code_version: '2.1.999', capabilities: ['msg_lifecycle_v1'] },
  ])(
    'uses bounded attribution for an unchecked profile %j',
    async (profile) => {
      const t = await setup(
        [
          user(),
          init({
            claude_code_version: undefined,
            capabilities: undefined,
            ...profile,
          }),
          full('ambiguous'),
        ],
        { attributionTimeoutMs: 30 },
      )
      const h = await t.start()
      const receipt = await h.prompt('pending')
      expect(await receipt.completion).toMatchObject({
        status: 'failed',
        message: expect.stringContaining('attribution'),
      })
      expect(text(t.events)).toBe('')
      expect(t.events.filter((e) => e.type === 'turn_started')).toHaveLength(0)
    },
  )
  it('fails an explicit unknown trigger without consuming pending foreground work', async () => {
    const t = await setup([
      user(),
      init(),
      full('unknown', { user_message_uuid: 'peer-uuid' }),
    ])
    const h = await t.start()
    expect(await (await h.prompt('pending')).completion).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('unknown'),
    })
    expect(text(t.events)).toBe('')
  })
  it('keeps completed command acknowledgements separate from results and rejects owned refusal', async () => {
    const t = await setup([
      user(),
      init(),
      {
        send: {
          type: 'command_lifecycle',
          command_uuid: 'unknown-peer',
          state: 'refused',
        },
      },
      started(),
      full(),
      {
        send: {
          type: 'command_lifecycle',
          command_uuid: '$user.uuid',
          state: 'completed',
        },
      },
      { mark: 'ack', wait: 'go' },
      result(),
      {
        send: {
          type: 'command_lifecycle',
          command_uuid: '$user.uuid',
          state: 'completed',
        },
      },
      user('b'),
      {
        send: {
          type: 'command_lifecycle',
          command_uuid: '$b.uuid',
          state: 'refused',
        },
      },
    ])
    const h = await t.start()
    const a = await h.prompt('a')
    let settled = false
    void a.completion.then(() => {
      settled = true
    })
    await file(t.directory, 'ack')
    expect(settled).toBe(false)
    await t.gate()
    expect(await a.completion).toMatchObject({ status: 'completed' })
    const b = await h.prompt('b')
    expect(await b.completion).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('accepted user message'),
    })
  })
  it.each([
    {
      actions: [
        full('', {
          error: 'billing_error',
          message: {
            id: 'error',
            content: [{ type: 'text', text: 'Billing is unavailable' }],
          },
        }),
        result({ subtype: 'error_during_execution' }),
      ],
      message: 'Billing is unavailable',
    },
    {
      actions: [result({ subtype: 'error_during_execution' })],
      message: 'Claude turn failed',
    },
    {
      actions: [
        result({
          subtype: 'error_during_execution',
          errors: ['<diagnostic>private breadcrumb</diagnostic>'],
        }),
      ],
      message: 'Claude turn failed',
    },
    {
      actions: [
        {
          send: {
            type: 'rate_limit_event',
            rate_limit_info: { status: 'rejected' },
          },
        },
        result({ subtype: 'error_during_execution' }),
      ],
      message: 'Claude rejected the turn because of a rate limit',
    },
  ])('retains useful native failure context: $message', async (scenario) => {
    const t = await setup([user(), init(), started(), ...scenario.actions])
    const h = await t.start()
    expect(await (await h.prompt('go')).completion).toMatchObject({
      status: 'failed',
      message: scenario.message,
    })
    expect(text(t.events)).toBe('')
  })
  it('keeps informational rate-limit notices nonterminal and supports result-only text', async () => {
    const t = await setup([
      user(),
      init(),
      started(),
      {
        send: {
          type: 'rate_limit_event',
          rate_limit_info: { status: 'allowed_warning' },
        },
      },
      result({ result: 'result only' }),
    ])
    const h = await t.start()
    expect(await (await h.prompt('go')).completion).toMatchObject({
      status: 'completed',
    })
    expect(text(t.events)).toBe('result only')
    expect(t.events.filter((e) => e.type === 'usage')).toHaveLength(1)
  })
})

describe('Claude interactions and controls', () => {
  it.each(['allow_once', 'deny'])(
    'waits for an explicit manual permission %s',
    async (optionId) => {
      const t = await setup([
        user(),
        init(),
        started(),
        permission(),
        { mark: 'requested' },
        reply(
          optionId === 'deny'
            ? { behavior: 'deny', message: 'The user denied this tool.' }
            : {
                behavior: 'allow',
                updatedInput: { command: 'pwd', retained: true },
              },
        ),
        result(),
      ])
      const h = await t.start()
      const receipt = await h.prompt('go')
      await t.until((events) =>
        events.some((e) => e.type === 'permission_requested'),
      )
      const event = t.events.find((e) => e.type === 'permission_requested')!
      if (event.type !== 'permission_requested')
        throw new Error('Missing permission')
      expect(event.request).toMatchObject({
        toolCallId: 'bash',
        title: 'Bash',
        detail: 'Read the work directory\n/tmp/example',
      })
      expect(
        (await t.wire()).filter((frame) => frame.type === 'control_response'),
      ).toHaveLength(0)
      await expect(
        h.replyPermission?.({
          type: 'selected',
          requestId: event.request.requestId,
          optionId,
          grant: { network: { enabled: true } },
        }),
      ).rejects.toThrow('structured')
      await h.replyPermission?.({
        type: 'selected',
        requestId: event.request.requestId,
        optionId,
      })
      expect(await receipt.completion).toMatchObject({ status: 'completed' })
      await expect(
        h.replyPermission?.({
          type: 'selected',
          requestId: event.request.requestId,
          optionId,
        }),
      ).rejects.toThrow('stale')
    },
  )
  it('maps question labels, descriptions, free text, notes, and original input', async () => {
    const qs = [
      {
        question: 'Choose features',
        multiSelect: true,
        options: [{ label: 'One', description: 'First' }, { label: 'Two' }],
      },
      { question: 'Name it', options: [] },
    ]
    const t = await setup([
      user(),
      init(),
      started(),
      question(qs),
      reply({
        behavior: 'allow',
        updatedInput: {
          retained: 'original',
          questions: qs,
          answers: { 'Choose features': 'One, Two', 'Name it': 'A name' },
          annotations: { 'Choose features': { notes: 'Use both' } },
        },
      }),
      result(),
    ])
    const h = await t.start()
    const receipt = await h.prompt('go')
    await t.until((events) =>
      events.some((e) => e.type === 'question_requested'),
    )
    const event = t.events.find((e) => e.type === 'question_requested')!
    if (event.type !== 'question_requested') throw new Error('Missing question')
    const [select, free] = event.request.questions
    expect(select!.options[0]).toMatchObject({
      label: 'One',
      description: 'First',
    })
    expect(event.request.requestId).not.toBe('native-request')
    await expect(
      h.replyQuestion?.(event.request.requestId, {
        [select!.id]: { type: 'selected', optionIds: ['wrong'] },
      }),
    ).rejects.toThrow()
    await h.replyQuestion?.(event.request.requestId, {
      [select!.id]: {
        type: 'selected_with_text',
        optionIds: select!.options.map((o) => o.id),
        text: 'Use both',
      },
      [free!.id]: { type: 'free_text', text: 'A name' },
    })
    expect(await receipt.completion).toMatchObject({ status: 'completed' })
  })
  it.each([false, true])(
    'denies the whole skipped question request, partial=%s',
    async (partial) => {
      const qs = [
        { question: 'One?', options: [{ label: 'Yes' }] },
        { question: 'Two?', options: [{ label: 'Yes' }] },
      ]
      const t = await setup([
        user(),
        init(),
        started(),
        question(qs),
        reply({
          behavior: 'deny',
          message: 'The user skipped this question request.',
        }),
        result(),
      ])
      const h = await t.start()
      const receipt = await h.prompt('go')
      await t.until((events) =>
        events.some((e) => e.type === 'question_requested'),
      )
      const e = t.events.find((e) => e.type === 'question_requested')!
      if (e.type !== 'question_requested') throw new Error('Missing question')
      await h.replyQuestion?.(
        e.request.requestId,
        Object.fromEntries(
          e.request.questions.map((q, i) => [
            q.id,
            partial && i === 0
              ? { type: 'selected', optionIds: [q.options[0]!.id] }
              : { type: 'skipped' },
          ]),
        ),
      )
      expect(await receipt.completion).toMatchObject({ status: 'completed' })
    },
  )
  it('expires provider-cancelled requests and rejects late or stale generation answers without writes', async () => {
    const t = await setup([
      user(),
      init(),
      started(),
      question(),
      question(),
      { mark: 'asked', wait: 'go' },
      {
        send: { type: 'control_cancel_request', request_id: 'native-request' },
      },
      { mark: 'cancelled', wait: 'finish' },
      result(),
    ])
    const h = await t.start()
    const receipt = await h.prompt('go')
    await t.until((events) =>
      events.some((e) => e.type === 'question_requested'),
    )
    const e = t.events.find((e) => e.type === 'question_requested')!
    if (e.type !== 'question_requested') throw new Error('Missing question')
    await expect(
      h.replyQuestion?.(`old:${e.request.requestId}`, {}),
    ).rejects.toThrow('stale')
    await t.gate()
    await t.until((events) =>
      events.some((e) => e.type === 'request_cancelled'),
    )
    await expect(h.replyQuestion?.(e.request.requestId, {})).rejects.toThrow(
      'stale',
    )
    expect(
      (await t.wire()).filter((f) => f.type === 'control_response'),
    ).toHaveLength(0)
    expect(
      t.events.filter((e) => e.type === 'question_requested'),
    ).toHaveLength(1)
    await t.gate('finish')
    await receipt.completion
  })
  it('answers unknown controls with correlated errors', async () => {
    const t = await setup([
      {
        send: {
          type: 'control_request',
          request_id: 'unknown',
          request: { subtype: 'unsupported_hook' },
        },
      },
      {
        expect: {
          type: 'control_response',
          response: {
            subtype: 'error',
            request_id: 'unknown',
            error: 'Unsupported Claude control request',
          },
        },
      },
    ])
    await t.start()
    await t.finished()
  })
  it.each(['auto', 'yolo'] as const)(
    'keeps rejected %s policy changes from delivering input',
    async (mode) => {
      const t = await setup([
        {
          expect: {
            type: 'control_request',
            request: {
              subtype: 'set_permission_mode',
              mode: mode === 'auto' ? 'auto' : 'bypassPermissions',
            },
          },
          capture: 'policy',
        },
        {
          send: {
            type: 'control_response',
            response: {
              subtype: 'error',
              request_id: '$policy.request_id',
              error: 'Managed policy rejects this mode',
            },
          },
        },
        user(),
        init(),
        started(),
        permission(),
        reply({ behavior: 'deny' }),
        result(),
      ])
      const h = await t.start()
      await expect(
        h.prompt('no send', { permissionMode: mode }),
      ).rejects.toThrow('Managed policy')
      expect((await t.wire()).filter((f) => f.type === 'user')).toHaveLength(0)
      const receipt = await h.prompt('manual', { permissionMode: 'manual' })
      await t.until((events) =>
        events.some((e) => e.type === 'permission_requested'),
      )
      const e = t.events.find((e) => e.type === 'permission_requested')!
      if (e.type === 'permission_requested')
        await h.replyPermission?.({
          type: 'denied',
          requestId: e.request.requestId,
        })
      await receipt.completion
    },
  )
  it.each(['auto', 'yolo'] as const)(
    'still requests residual native permission in %s mode',
    async (mode) => {
      const t = await setup([
        control('set_permission_mode', 'policy', {
          mode: mode === 'auto' ? 'auto' : 'bypassPermissions',
        }),
        user(),
        init(),
        started(),
        permission(),
        reply({ behavior: 'deny' }),
        result(),
      ])
      const h = await t.start()
      const receipt = await h.prompt('go', { permissionMode: mode })
      await t.until((events) =>
        events.some((e) => e.type === 'permission_requested'),
      )
      expect(
        (await t.wire()).filter((f) => f.type === 'control_response'),
      ).toHaveLength(0)
      const e = t.events.find((e) => e.type === 'permission_requested')!
      if (e.type === 'permission_requested')
        await h.replyPermission?.({
          type: 'denied',
          requestId: e.request.requestId,
        })
      await receipt.completion
    },
  )
  it('sets models and session effort through verified controls, including clearing overrides', async () => {
    const t = await setup([
      control('set_model'),
      control('apply_flag_settings'),
      control('apply_flag_settings'),
      user(),
      init(),
      started(),
      full(),
      result(),
      control('set_model'),
      control('apply_flag_settings'),
      user('b'),
      started('b'),
      result(),
      control('set_model'),
    ])
    const h = await t.start()
    await h.setModel?.('sonnet')
    await h.setConfigOption?.('effort', 'xhigh')
    const first = await h.prompt('go', {
      permissionMode: 'manual',
      reasoning: 'max',
    })
    await first.completion
    await (
      await h.prompt('clear', {
        permissionMode: 'manual',
        model: null,
        reasoning: null,
      })
    ).completion
    await h.setModel?.('haiku')
    expect(h.configOptions?.()).toEqual([])
    await expect(h.setConfigOption?.('effort', 'high')).rejects.toThrow(
      'does not support',
    )
    const wire = await t.wire()
    expect(
      wire
        .filter((f) => f.request?.subtype === 'set_model')
        .map((f) => f.request.model),
    ).toEqual(['sonnet', null, 'haiku'])
    expect(
      wire
        .filter((f) => f.request?.subtype === 'apply_flag_settings')
        .map((f) => f.request.settings.effortLevel),
    ).toEqual(['xhigh', 'max', null])
    expect(
      new Set(
        wire
          .filter((f) => f.type === 'control_request')
          .map((f) => f.request_id),
      ).size,
    ).toBe(wire.filter((f) => f.type === 'control_request').length)
  })
  it('ignores unrelated control replies and preserves a rejected model selection', async () => {
    const t = await setup([
      {
        expect: { type: 'control_request', request: { subtype: 'set_model' } },
        capture: 'model',
      },
      {
        send: {
          type: 'control_response',
          response: { subtype: 'success', request_id: 'unrelated' },
        },
      },
      {
        send: {
          type: 'control_response',
          response: {
            subtype: 'error',
            request_id: '$model.request_id',
            error: 'Model access denied',
          },
        },
      },
    ])
    const h = await t.start()
    await expect(h.setModel?.('haiku')).rejects.toThrow('Model access denied')
    expect(h.configOptions?.().length).toBe(1)
  })
  it('fails an unanswered control at its original deadline', async () => {
    const t = await setup(
      [
        {
          expect: {
            type: 'control_request',
            request: { subtype: 'set_model' },
          },
          capture: 'model',
        },
        {
          repeat: 10,
          actions: [
            {
              send: {
                type: 'control_response',
                response: { subtype: 'success', request_id: 'wrong-id' },
              },
            },
          ],
        },
      ],
      { controlTimeoutMs: 250 },
    )
    const h = await t.start()
    await expect(h.setModel?.('sonnet')).rejects.toThrow('timed out')
    await expect(h.prompt('later')).rejects.toThrow('closed')
  })
})

describe('Claude children', () => {
  it('keeps child tools, permission, user text, shell tasks, and late metadata on the spawning turn', async () => {
    const parentTool = 'toolu_01EjFLnNhCiMR2PBNKcVvtkT'
    const childTool = 'toolu_01GMC9ZezKCsFd8Kco7EE3iS'
    const agent = 'afc3eb80f41dedf60'
    const spawn = full('', {
      message: {
        id: 'spawn',
        content: [
          {
            type: 'tool_use',
            id: parentTool,
            name: 'Agent',
            input: {
              prompt: 'Do child work',
              description: 'Background child',
              run_in_background: true,
            },
          },
        ],
      },
    })
    const t = await setup([
      user(),
      init(),
      started(),
      spawn,
      full('parent'),
      result(),
      full('', {
        parent_tool_use_id: parentTool,
        message: {
          id: 'child-tool',
          content: [
            {
              type: 'tool_use',
              id: childTool,
              name: 'Bash',
              input: { command: 'pwd' },
            },
          ],
        },
      }),
      permission({ tool_use_id: childTool, agent_id: agent }),
      reply({ behavior: 'deny', message: 'The user denied this tool.' }),
      {
        send: {
          type: 'system',
          subtype: 'task_started',
          task_id: 'shell',
          tool_use_id: childTool,
        },
      },
      {
        send: {
          type: 'system',
          subtype: 'task_notification',
          task_id: 'shell',
          tool_use_id: childTool,
          status: 'completed',
          summary: 'shell output',
        },
      },
      {
        send: {
          type: 'user',
          parent_tool_use_id: parentTool,
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: childTool,
                content: 'actual tool output',
              },
              { type: 'text', text: 'child user message' },
            ],
          },
        },
      },
      full('child reply', { parent_tool_use_id: parentTool }),
      {
        send: {
          type: 'system',
          subtype: 'task_notification',
          tool_use_id: parentTool,
          status: 'completed',
        },
      },
      {
        send: {
          type: 'system',
          subtype: 'task_started',
          task_id: agent,
          tool_use_id: parentTool,
          subagent_type: 'general-purpose',
        },
      },
      {
        send: {
          type: 'user',
          parent_tool_use_id: parentTool,
          message: { content: '[Request interrupted by user]' },
        },
      },
      stream({ type: 'message_start', message: { id: 'wake' } }),
      full('wake', {
        message: { id: 'wake', content: [{ type: 'text', text: 'wake' }] },
      }),
      result({ origin: { kind: 'task-notification' } }),
    ])
    const h = await t.start()
    const receipt = await h.prompt('launch', undefined, {
      runId: 'run',
      turnId: 'parent-turn',
    })
    expect(await receipt.completion).toMatchObject({ status: 'completed' })
    await t.until((events) =>
      events.some((e) => e.type === 'permission_requested'),
    )
    const permissionEvent = t.events.find(
      (e) => e.type === 'permission_requested',
    )!
    if (permissionEvent.type !== 'permission_requested')
      throw new Error('Missing permission')
    const child = t.events.find((e) => e.type === 'child_started')!
    expect(permissionEvent.childId).toBe(child.childId)
    expect(permissionEvent.turnId).toBe('parent-turn')
    await h.replyPermission?.({
      type: 'selected',
      requestId: permissionEvent.request.requestId,
      optionId: 'deny',
    })
    await t.until(
      (events) =>
        events.filter((e) => e.type === 'turn_completed').length === 2,
    )
    expect(t.events.filter((e) => e.type === 'child_started')).toHaveLength(1)
    expect(t.events.filter((e) => e.type === 'child_finished')).toHaveLength(1)
    expect(text(t.events, true)).toBe('child user messagechild reply')
    expect(t.events.find((e) => e.type === 'child_updated')).toMatchObject({
      childId: child.childId,
      providerChildId: agent,
      parentToolCallId: parentTool,
    })
    const childOutput = t.events.filter((e) => 'childId' in e && e.childId)
    expect(
      childOutput.every((e) => 'turnId' in e && e.turnId === 'parent-turn'),
    ).toBe(true)
    let state = emptyTimeline()
    for (const [index, event] of t.events.entries()) {
      state = reduceTimeline(state, { kind: 'delta', cursor: index + 1, event })
      if ('childId' in event && event.childId)
        expect(
          state.runs
            .get(timelineRunKey(event.runtimeGeneration, 'run'))
            ?.turns.get('parent-turn'),
        ).toMatchObject({
          phase: event.type === 'child_started' ? 'running' : 'settled',
        })
    }
    const replay = reduceTimeline(emptyTimeline(), {
      kind: 'snapshot',
      cursor: t.events.length,
      entries: t.events.map((event, index) => ({ cursor: index + 1, event })),
    })
    expect(replay.events).toEqual(state.events)
    expect(replay.events.find((e) => e.type === 'child_updated')).toMatchObject(
      { providerChildId: agent },
    )
  })
  it('fails unknown child ownership immediately', async () => {
    const t = await setup([
      user(),
      init(),
      started(),
      full('child', { parent_tool_use_id: 'unknown-child' }),
    ])
    const h = await t.start()
    expect(await (await h.prompt('go')).completion).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('child attribution'),
    })
    expect(text(t.events)).toBe('')
  })
  it('preserves nested child attribution and tool result output', async () => {
    const t = await setup([
      user(),
      init(),
      started(),
      full('', {
        message: {
          id: 'parent',
          content: [
            {
              type: 'tool_use',
              id: 'agent-a',
              name: 'Task',
              input: { prompt: 'one' },
            },
          ],
        },
      }),
      full('', {
        parent_tool_use_id: 'agent-a',
        message: {
          id: 'nested',
          content: [
            {
              type: 'tool_use',
              id: 'agent-b',
              name: 'Agent',
              input: { prompt: 'two' },
            },
          ],
        },
      }),
      full('', {
        parent_tool_use_id: 'agent-b',
        message: {
          id: 'bash',
          content: [
            {
              type: 'tool_use',
              id: 'bash',
              name: 'Bash',
              input: { command: 'pwd' },
            },
          ],
        },
      }),
      {
        send: {
          type: 'user',
          parent_tool_use_id: 'agent-b',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'bash',
                content: 'kept output',
              },
            ],
          },
        },
      },
      result(),
    ])
    const h = await t.start()
    await (
      await h.prompt('go')
    ).completion
    const children = t.events.filter((e) => e.type === 'child_started')
    expect(children[1]).toMatchObject({ parentChildId: children[0]?.childId })
    expect(t.events.find((e) => e.type === 'tool_update')).toMatchObject({
      childId: children[1]?.childId,
      output: 'kept output',
    })
  })
})

describe('Claude input and preparation', () => {
  it('sends exact image bytes above the shared default frame cap and preserves input order', async () => {
    const data = Buffer.alloc(MiB + 10, 123)
    const small = Buffer.from([0, 1, 2, 255])
    const t = await setup([user(), init(), started(), result()], {
      loadAttachment: async (session, id, signal) => {
        expect(session).toBe('forge-session')
        expect(signal.aborted).toBe(false)
        const bytes = id === 'large' ? data : small
        return {
          mime: 'image/png',
          name: `${id}.png`,
          path: `/tmp/${id}.png`,
          sizeBytes: bytes.length,
          readBytes: async () => bytes,
        }
      },
    })
    const h = await t.start()
    await (
      await h.prompt([
        { type: 'text', text: 'before' },
        { type: 'attachment', attachmentId: 'large', mime: 'image/png' },
        { type: 'text', text: 'between' },
        { type: 'attachment', attachmentId: 'small', mime: 'image/png' },
      ])
    ).completion
    const blocks = (await t.wire()).find((f) => f.type === 'user').message
      .content
    expect(blocks.map((b: { type: string }) => b.type)).toEqual([
      'text',
      'image',
      'text',
      'image',
    ])
    expect(blocks[1].source).toEqual({
      type: 'base64',
      media_type: 'image/png',
      data: data.toString('base64'),
    })
    expect(blocks[3].source.data).toBe(small.toString('base64'))
  })
  it.each(['owner', 'unreadable', 'size', 'mime', 'changed'])(
    'rejects attachment %s failures before acceptance',
    async (kind) => {
      const t = await setup([], {
        loadAttachment: async () => {
          if (kind === 'owner')
            throw new Error('Attachment belongs to another session')
          return {
            mime: kind === 'mime' ? 'image/jpeg' : 'image/png',
            name: 'image.png',
            path: '/tmp/image.png',
            sizeBytes: kind === 'size' ? 5 * MiB + 1 : 2,
            readBytes: async () => {
              if (kind === 'unreadable')
                throw new Error('Attachment is unreadable')
              return Buffer.alloc(kind === 'changed' ? 1 : 2)
            },
          }
        },
      })
      const h = await t.start()
      await expect(
        h.prompt([
          { type: 'attachment', attachmentId: 'image', mime: 'image/png' },
        ]),
      ).rejects.toThrow()
      expect(t.events).toHaveLength(0)
      expect((await t.wire()).filter((f) => f.type === 'user')).toHaveLength(0)
    },
  )
  it('rejects more than four images and more than 64 parts before reading attachments', async () => {
    let loads = 0
    const t = await setup([], {
      loadAttachment: async () => {
        loads++
        throw new Error('Unexpected load')
      },
    })
    const h = await t.start()
    await expect(
      h.prompt(
        Array.from({ length: 5 }, () => ({
          type: 'attachment' as const,
          attachmentId: 'image',
          mime: 'image/png',
        })),
      ),
    ).rejects.toThrow('four images')
    await expect(
      h.prompt(
        Array.from({ length: 65 }, () => ({
          type: 'text' as const,
          text: 'x',
        })),
      ),
    ).rejects.toThrow('64 input parts')
    await expect(h.prompt('x'.repeat(MiB + 1))).rejects.toThrow('1 MiB')
    expect(loads).toBe(0)
  })
  it('keeps non-image paths and review references as authorized text', async () => {
    const t = await setup([user(), init(), started(), result()], {
      loadAttachment: async () => ({
        mime: 'text/plain',
        name: 'notes.txt',
        path: '/tmp/authorized/notes.txt',
        sizeBytes: 10,
        readBytes: async () => {
          throw new Error('Do not read non-image content')
        },
      }),
    })
    const h = await t.start()
    await (
      await h.prompt([
        { type: 'attachment', attachmentId: 'notes', mime: 'text/plain' },
        {
          type: 'review_reference',
          title: 'Review',
          url: 'https://example.invalid/review',
        },
      ])
    ).completion
    expect(
      (await t.wire()).find((f) => f.type === 'user').message.content,
    ).toEqual([
      { type: 'text', text: 'File: notes.txt\n/tmp/authorized/notes.txt' },
      { type: 'text', text: 'Review\nhttps://example.invalid/review' },
    ])
  })
  it.each([
    { sandboxPolicy: { type: 'readOnly' } },
    {
      approvalPolicy: {
        granular: {
          sandbox_approval: false,
          rules: true,
          mcp_elicitations: false,
          request_permissions: false,
        },
      },
    },
    { serviceTier: 'priority' },
    { reasoning: 'unsupported' },
    { permissionMode: 'invalid' },
  ])(
    'rejects dispatch restrictions before controls or attachment reads: %j',
    async (patch) => {
      let reads = 0
      const t = await setup([], {
        loadAttachment: async () => {
          reads++
          throw new Error('Unexpected load')
        },
      })
      const h = await t.start()
      await expect(
        h.prompt(
          [{ type: 'attachment', attachmentId: 'image', mime: 'image/png' }],
          { permissionMode: 'manual', ...patch } as DispatchOptions,
        ),
      ).rejects.toThrow()
      expect(reads).toBe(0)
      expect((await t.wire()).length).toBe(2)
      expect(t.events).toHaveLength(0)
    },
  )
  it('reserves preparation before awaiting and cancels a deferred loader without sending input', async () => {
    const release = deferred<Attachment>()
    const begun = deferred<void>()
    const t = await setup(
      [control('interrupt', 'interrupt', { still_queued: [] })],
      {
        loadAttachment: async () => {
          begun.resolve()
          return release.promise
        },
      },
    )
    const h = await t.start()
    const pending = h.prompt([
      { type: 'attachment', attachmentId: 'image', mime: 'image/png' },
    ])
    const rejection = expect(pending).rejects.toThrow('cancelled')
    await begun.promise
    await expect(h.prompt('competing')).rejects.toThrow('busy')
    await h.cancel()
    await rejection
    release.resolve({
      mime: 'image/png',
      name: 'image',
      path: '/tmp/image',
      sizeBytes: 1,
      readBytes: async () => Buffer.alloc(1),
    })
    expect(t.events.filter((e) => e.type === 'prompt_accepted')).toHaveLength(0)
    expect((await t.wire()).filter((f) => f.type === 'user')).toHaveLength(0)
  })
  it('keeps an automatic wake separate while a foreground image loads', async () => {
    const release = deferred<void>()
    const begun = deferred<void>()
    const t = await setup(
      [
        init(),
        { wait: 'wake' },
        full('wake'),
        result({ origin: { kind: 'task-notification' } }),
        user(),
        started(),
        full('foreground'),
        result(),
      ],
      {
        loadAttachment: async () => {
          begun.resolve()
          await release.promise
          return {
            mime: 'image/png',
            name: 'image',
            path: '/tmp/image',
            sizeBytes: 1,
            readBytes: async () => Buffer.alloc(1),
          }
        },
      },
    )
    const h = await t.start()
    const pending = h.prompt(
      [{ type: 'attachment', attachmentId: 'image', mime: 'image/png' }],
      undefined,
      { runId: 'foreground-run', turnId: 'foreground-turn' },
    )
    await begun.promise
    await t.gate('wake')
    await t.until((events) => events.some((e) => e.type === 'turn_completed'))
    expect(t.events.some((e) => e.type === 'prompt_accepted')).toBe(false)
    release.resolve()
    const receipt = await pending
    expect(await receipt.completion).toMatchObject({
      status: 'completed',
      turnId: 'foreground-turn',
    })
    expect(text(t.events)).toBe('wakeforeground')
  })
})

describe('Claude steering, cancellation, and process ownership', () => {
  it('sends concurrent steers in order with fresh receipts and one active completion', async () => {
    const t = await setup([
      user(),
      init(),
      started(),
      full('before'),
      user('steer1'),
      started('steer1'),
      user('steer2'),
      started('steer2'),
      full('after'),
      result(),
    ])
    const h = await t.start()
    const first = await h.prompt('first', undefined, {
      runId: 'run',
      turnId: 'turn',
    })
    await t.until((events) => text(events) === 'before')
    await expect(
      h.steer?.('wrong', undefined, { runId: 'run', turnId: 'wrong' }),
    ).rejects.toThrow('identity')
    await expect(
      h.steer?.('wrong', { permissionMode: 'manual', reasoning: 'high' }),
    ).rejects.toThrow('settings')
    const [one, two] = await Promise.all([h.steer!('one'), h.steer!('two')])
    expect(one.completion).toBe(first.completion)
    expect(two.completion).toBe(first.completion)
    expect(new Set([one.receiptId, two.receiptId, first.receiptId]).size).toBe(
      3,
    )
    expect(await first.completion).toMatchObject({
      status: 'completed',
      turnId: 'turn',
    })
    expect(
      (await t.wire())
        .filter((f) => f.type === 'user')
        .map((f) => f.message.content[0].text),
    ).toEqual(['first', 'one', 'two'])
    expect(t.events.filter((e) => e.type === 'turn_completed')).toHaveLength(1)
  })
  it('rejects a steer whose attachment preparation crosses the captured result', async () => {
    const release = deferred<void>()
    const begun = deferred<void>()
    const t = await setup(
      [user(), init(), started(), full(), { wait: 'go' }, result()],
      {
        loadAttachment: async () => {
          begun.resolve()
          await release.promise
          return {
            mime: 'image/png',
            name: 'image',
            path: '/tmp/image',
            sizeBytes: 1,
            readBytes: async () => Buffer.alloc(1),
          }
        },
      },
    )
    const h = await t.start()
    const first = await h.prompt('first')
    await t.until((events) => text(events) === 'hello')
    const steering = h.steer!([
      { type: 'attachment', attachmentId: 'image', mime: 'image/png' },
    ])
    const rejected = expect(steering).rejects.toThrow('crossed')
    await begun.promise
    await t.gate()
    await first.completion
    release.resolve()
    await rejected
    expect((await t.wire()).filter((f) => f.type === 'user')).toHaveLength(1)
  })
  it('interrupts while a question waits without blocking the reader', async () => {
    const t = await setup([
      user(),
      init(),
      started(),
      question(),
      reply({ behavior: 'deny', message: 'The user stopped Claude' }),
      {
        expect: {
          type: 'control_request',
          request: { subtype: 'interrupt', cancel_queued: true },
        },
        capture: 'interrupt',
        controlSuccess: true,
        response: { cancelled: [], still_queued: [] },
      },
      result(),
    ])
    const h = await t.start()
    const receipt = await h.prompt('go')
    await t.until((events) =>
      events.some((e) => e.type === 'question_requested'),
    )
    await h.cancel()
    expect(await receipt.completion).toMatchObject({ status: 'interrupted' })
    expect(t.events.filter((e) => e.type === 'request_cancelled')).toHaveLength(
      1,
    )
    expect(t.events.filter((e) => e.type === 'turn_completed')).toHaveLength(1)
  })
  it('correlates queued steer cancellation with the native receipt', async () => {
    const t = await setup([
      user(),
      init(),
      started(),
      full(),
      user('steer'),
      { mark: 'queued' },
      {
        expect: {
          type: 'control_request',
          request: { subtype: 'interrupt', cancel_queued: true },
        },
        capture: 'interrupt',
      },
      {
        send: {
          type: 'command_lifecycle',
          command_uuid: '$steer.uuid',
          state: 'cancelled',
        },
      },
      {
        send: {
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: '$interrupt.request_id',
            response: { cancelled: ['$steer.uuid'], still_queued: [] },
          },
        },
      },
      result(),
    ])
    const h = await t.start()
    const receipt = await h.prompt('go')
    await t.until((events) => text(events) === 'hello')
    const steering = await h.steer!('queued')
    await file(t.directory, 'queued')
    await h.cancel()
    expect(steering.completion).toBe(receipt.completion)
    expect(await receipt.completion).toMatchObject({ status: 'interrupted' })
    expect(t.events.filter((e) => e.type === 'run_failed')).toHaveLength(0)
  })
  it('closes an older runtime that cannot prove queued input was cancelled', async () => {
    const t = await setup([
      user(),
      init({ capabilities: ['msg_lifecycle_v1'] }),
      started(),
      full(),
      user('steer'),
      { mark: 'queued' },
      control('interrupt', 'interrupt', { still_queued: ['$steer.uuid'] }),
      result(),
    ])
    const h = await t.start()
    const receipt = await h.prompt('go')
    await t.until((events) => text(events) === 'hello')
    await h.steer!('queued')
    await file(t.directory, 'queued')
    await h.cancel()
    expect(await receipt.completion).toMatchObject({ status: 'interrupted' })
    await expect(h.prompt('after stop')).rejects.toThrow('closed')
  })
  it('closes ignored interrupts and owned descendants, then tolerates repeated close', async () => {
    const t = await setup(
      [
        user(),
        init(),
        started(),
        full(),
        { descendant: true, ignoreTerm: true },
        { mark: 'spawned' },
        {
          expect: {
            type: 'control_request',
            request: { subtype: 'interrupt' },
          },
        },
      ],
      { interruptGraceMs: 20 },
    )
    const h = await t.start()
    const receipt = await h.prompt('go')
    await file(t.directory, 'spawned')
    const child = JSON.parse(
      await readFile(join(t.directory, 'descendant.json'), 'utf8'),
    ).pid
    await h.cancel()
    await Promise.all([h.kill(), h.kill()])
    expect(await receipt.completion).toMatchObject({ status: 'interrupted' })
    expect(() => process.kill(child, 0)).toThrow()
    expect(t.events.filter((e) => e.type === 'turn_completed')).toHaveLength(1)
  })
  it('routes out-of-order interrupt and model responses by their exact IDs', async () => {
    const t = await setup([
      {
        expect: { type: 'control_request', request: { subtype: 'set_model' } },
        capture: 'model',
        mark: 'model',
      },
      {
        expect: { type: 'control_request', request: { subtype: 'interrupt' } },
        capture: 'interrupt',
      },
      {
        send: {
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: '$interrupt.request_id',
            response: { still_queued: [] },
          },
        },
      },
      {
        send: {
          type: 'control_response',
          response: {
            subtype: 'error',
            request_id: '$model.request_id',
            error: 'Model cancelled',
          },
        },
      },
    ])
    const h = await t.start()
    const model = h.setModel!('sonnet')
    const rejected = expect(model).rejects.toThrow()
    await file(t.directory, 'model')
    await h.cancel()
    await rejected
    expect(h.configOptions?.()[0]?.id).toBe('effort')
  })
})

describe('Claude retained-state admission', () => {
  it('bounds incoming interactions by count', async () => {
    const t = await setup([
      user(),
      init(),
      started(),
      {
        repeat: 65,
        actions: [
          {
            send: {
              type: 'control_request',
              request_id: '$new',
              request: {
                subtype: 'can_use_tool',
                tool_name: 'Bash',
                input: {},
              },
            },
          },
        ],
      },
    ])
    const h = await t.start()
    expect(await (await h.prompt('go')).completion).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('interaction limit'),
    })
    expect(
      t.events.filter((e) => e.type === 'permission_requested'),
    ).toHaveLength(64)
    expect(t.events.filter((e) => e.type === 'request_cancelled')).toHaveLength(
      64,
    )
  })
  it('bounds retained interaction wire bytes below the transport frame cap', async () => {
    const t = await setup([
      user(),
      init(),
      started(),
      {
        repeat: 9,
        actions: [
          {
            send: {
              type: 'control_request',
              request_id: '$new',
              request: {
                subtype: 'can_use_tool',
                tool_name: 'Bash',
                input: { text: 'x'.repeat(MiB) },
              },
            },
          },
        ],
      },
    ])
    const h = await t.start()
    expect(await (await h.prompt('go')).completion).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('interaction limit'),
    })
    expect(
      t.events.filter((e) => e.type === 'permission_requested'),
    ).toHaveLength(7)
  })
  it.each([
    {
      name: 'block',
      actions: [
        stream({ type: 'message_start', message: { id: 'message' } }),
        {
          repeat: 3,
          actions: [
            stream({
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'x'.repeat(MiB) },
            }),
          ],
        },
      ],
    },
    {
      name: 'message',
      actions: [
        stream({ type: 'message_start', message: { id: 'message' } }),
        {
          repeat: 5,
          actions: [
            stream({
              type: 'content_block_delta',
              index: '$index',
              delta: { type: 'text_delta', text: 'x'.repeat(MiB) },
            }),
          ],
        },
      ],
    },
    {
      name: 'aggregate',
      actions: [
        {
          repeat: 9,
          actions: [
            stream({ type: 'message_start', message: { id: '$new' } }),
            stream({
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'x'.repeat(MiB) },
            }),
          ],
        },
      ],
    },
  ])('bounds retained partial text by $name', async (scenario) => {
    const t = await setup([user(), init(), started(), ...scenario.actions])
    const h = await t.start()
    expect(await (await h.prompt('go')).completion).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('text limit'),
    })
  })
  it('bounds incomplete messages and per-message blocks', async () => {
    const a = await setup([
      user(),
      init(),
      started(),
      {
        repeat: 33,
        actions: [stream({ type: 'message_start', message: { id: '$new' } })],
      },
    ])
    const ha = await a.start()
    expect(await (await ha.prompt('go')).completion).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('message limit'),
    })
    const b = await setup([
      user(),
      init(),
      started(),
      stream({ type: 'message_start', message: { id: 'message' } }),
      {
        repeat: 129,
        actions: [
          stream({
            type: 'content_block_start',
            index: '$index',
            content_block: { type: 'text', text: '' },
          }),
        ],
      },
    ])
    const hb = await b.start()
    expect(await (await hb.prompt('go')).completion).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('block limit'),
    })
  })
  it('bounds active children and retained tool identities', async () => {
    const a = await setup([
      user(),
      init(),
      started(),
      {
        repeat: 257,
        actions: [
          full('', {
            message: {
              id: '$new',
              content: [
                { type: 'tool_use', id: '$new', name: 'Agent', input: {} },
              ],
            },
          }),
        ],
      },
    ])
    const ha = await a.start()
    expect(await (await ha.prompt('go')).completion).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('task limit'),
    })
    const b = await setup([
      user(),
      init(),
      started(),
      {
        repeat: 1100,
        actions: [
          full('', {
            message: {
              id: '$new',
              content: [
                { type: 'tool_use', id: '$new', name: 'Bash', input: {} },
              ],
            },
          }),
        ],
      },
    ])
    const hb = await b.start()
    expect(await (await hb.prompt('go')).completion).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('identity limit'),
    })
  })
  it('bounds unresolved root frames while leaving pending output unassigned', async () => {
    const t = await setup([
      user(),
      init({ capabilities: [] }),
      { repeat: 257, actions: [full('unknown')] },
    ])
    const h = await t.start()
    expect(await (await h.prompt('pending')).completion).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('attribution buffer'),
    })
    expect(text(t.events)).toBe('')
  })
  it('retains settled identities after the recent UUID cache evicts their frames', async () => {
    const t = await setup([
      user(),
      init(),
      started(),
      stream({ type: 'message_start', message: { id: 'settled' } }),
      full('A', {
        message: { id: 'settled', content: [{ type: 'text', text: 'A' }] },
      }),
      result({ uuid: 'settled-result' }),
      user('b'),
      {
        repeat: 8200,
        actions: [
          { send: { type: 'system', subtype: 'idle_notice', uuid: '$new' } },
        ],
      },
      result({ uuid: 'settled-result' }),
      full('A', {
        message: { id: 'settled', content: [{ type: 'text', text: 'A' }] },
      }),
      started(),
      stream({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'late' },
      }),
      started('b'),
      full('B'),
      result(),
    ])
    const h = await t.start()
    await (
      await h.prompt('a')
    ).completion
    const b = await h.prompt('b')
    expect(await b.completion).toMatchObject({ status: 'completed' })
    expect(text(t.events)).toBe('AB')
    expect(t.events.filter((e) => e.type === 'turn_started')).toHaveLength(2)
  })
})

describe('Claude boundary regressions', () => {
  it('confirms a result-only binding through positive owned correlation', async () => {
    const t = await setup([
      user(),
      result({ user_message_uuid: '$user.uuid', result: 'answer' }),
    ])
    const h = await t.start()
    expect(h.binding).toBeNull()
    const receipt = await h.prompt('go')
    expect(await receipt.completion).toMatchObject({ status: 'completed' })
    expect(h.binding?.providerSessionId).toBeTruthy()
    expect(text(t.events)).toBe('answer')
  })
  it('holds early unowned content until a checked init confirms its automatic owner', async () => {
    const t = await setup([
      user(),
      full('early'),
      { mark: 'early', wait: 'go' },
      init(),
      result({ origin: { kind: 'task-notification' } }),
      started(),
      full('user'),
      result(),
    ])
    const h = await t.start()
    const receipt = await h.prompt('pending')
    await file(t.directory, 'early')
    expect(text(t.events)).toBe('')
    await t.gate()
    expect(await receipt.completion).toMatchObject({ status: 'completed' })
    expect(text(t.events)).toBe('earlyuser')
    expect(t.events.filter((e) => e.type === 'turn_started')).toHaveLength(2)
  })
  it('rejects failed resume startup without a new-session retry', async () => {
    const t = await setup([], {}, { startupExit: true })
    const binding = Object.freeze({
      provider: t.session.provider,
      accountId: 'fixture',
      cwd: t.directory,
      providerSessionId: 'failed-existing',
    })
    await expect(t.start(binding)).rejects.toThrow()
    const launch = JSON.parse(
      await readFile(join(t.directory, 'launch.json'), 'utf8'),
    )
    expect(launch.resume).toBe('failed-existing')
    expect(launch.argv).not.toContain('--session-id')
    expect(binding.providerSessionId).toBe('failed-existing')
  })
  it('rejects a startup control error and cleans up its process', async () => {
    const t = await setup(
      [
        {
          expect: {
            type: 'control_request',
            request: { subtype: 'initialize' },
          },
          capture: 'init',
        },
        {
          send: {
            type: 'control_response',
            response: {
              subtype: 'error',
              request_id: '$init.request_id',
              error: 'Resume history is unavailable',
            },
          },
        },
      ],
      {},
      { manualInitialize: true },
    )
    await expect(t.start()).rejects.toThrow('Resume history is unavailable')
    const launch = JSON.parse(
      await readFile(join(t.directory, 'launch.json'), 'utf8'),
    )
    expect(() => process.kill(launch.pid, 0)).toThrow()
  })
  it('accepts the full four-image raw-byte budget through the configured frame limit', async () => {
    const bytes = Buffer.alloc(5 * MiB, 42)
    const t = await setup([user(), init(), started(), result()], {
      loadAttachment: async () => ({
        mime: 'image/webp',
        name: 'large.webp',
        path: '/tmp/large.webp',
        sizeBytes: bytes.length,
        readBytes: async () => bytes,
      }),
    })
    const h = await t.start()
    await (
      await h.prompt(
        Array.from({ length: 4 }, (_, index) => ({
          type: 'attachment' as const,
          attachmentId: `image-${index}`,
          mime: 'image/webp',
        })),
      )
    ).completion
    const frame = (await t.wire()).find((f) => f.type === 'user')
    expect(frame.message.content).toHaveLength(4)
    expect(
      frame.message.content.every(
        (block: { source: { data: string } }) =>
          Buffer.from(block.source.data, 'base64').length === 5 * MiB,
      ),
    ).toBe(true)
  })
  it.each(['discarded', 'cancelled'])(
    'fails an unexplained owned %s delivery',
    async (state) => {
      const t = await setup([
        user(),
        init(),
        {
          send: {
            type: 'command_lifecycle',
            command_uuid: '$user.uuid',
            state,
          },
        },
      ])
      const h = await t.start()
      expect(await (await h.prompt('go')).completion).toMatchObject({
        status: 'failed',
      })
    },
  )
  it('bounds admitted operations while one attachment is preparing', async () => {
    const release = deferred<void>()
    let loads = 0
    const begun = deferred<void>()
    const t = await setup(
      [
        user(),
        init(),
        started(),
        full(),
        { repeat: 16, actions: [user('steer')] },
        result(),
      ],
      {
        loadAttachment: async () => {
          loads++
          begun.resolve()
          await release.promise
          return {
            mime: 'image/png',
            name: 'image',
            path: '/tmp/image',
            sizeBytes: 1,
            readBytes: async () => Buffer.alloc(1),
          }
        },
      },
    )
    const h = await t.start()
    const root = await h.prompt('go')
    await t.until((events) => text(events) === 'hello')
    const first = h.steer!([
      { type: 'attachment', attachmentId: 'image', mime: 'image/png' },
    ])
    await begun.promise
    const others = Array.from({ length: 15 }, () => h.steer!('queued'))
    await expect(h.steer!('overflow')).rejects.toThrow('operation limit')
    expect(loads).toBe(1)
    release.resolve()
    await Promise.all([first, ...others])
    await root.completion
  })
  it('drops late replies after a control deadline without reviving the session', async () => {
    const t = await setup(
      [
        {
          expect: {
            type: 'control_request',
            request: { subtype: 'set_model' },
          },
          capture: 'model',
          mark: 'waiting',
          wait: 'go',
        },
        {
          send: {
            type: 'control_response',
            response: { subtype: 'success', request_id: '$model.request_id' },
          },
        },
      ],
      { controlTimeoutMs: 200 },
    )
    const h = await t.start()
    await expect(h.setModel!('sonnet')).rejects.toThrow('timed out')
    const count = t.events.length
    await t.gate()
    await h.kill()
    expect(t.events.length).toBe(count)
    await expect(h.prompt('late')).rejects.toThrow('closed')
  })
  it('rejects duplicate question labels and invalid selection counts without automatic approval', async () => {
    const bad = await setup([
      user(),
      init(),
      started(),
      question([
        { question: 'Pick', options: [{ label: 'Same' }, { label: 'Same' }] },
      ]),
    ])
    const badHandle = await bad.start()
    expect(await (await badHandle.prompt('go')).completion).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('duplicate option'),
    })
    const t = await setup([
      user(),
      init(),
      started(),
      question([
        { question: 'Pick', options: [{ label: 'One' }, { label: 'Two' }] },
      ]),
      reply({ behavior: 'allow' }),
      result(),
    ])
    const h = await t.start()
    const receipt = await h.prompt('go')
    await t.until((events) =>
      events.some((e) => e.type === 'question_requested'),
    )
    const e = t.events.find((e) => e.type === 'question_requested')!
    if (e.type !== 'question_requested') throw new Error('Missing question')
    const q = e.request.questions[0]!
    await expect(
      h.replyQuestion!(e.request.requestId, {
        [q.id]: { type: 'selected', optionIds: q.options.map((o) => o.id) },
      }),
    ).rejects.toThrow('selection count')
    await expect(h.replyQuestion!(e.request.requestId, {})).rejects.toThrow(
      'required',
    )
    await h.replyQuestion!(e.request.requestId, {
      [q.id]: { type: 'selected', optionIds: [q.options[0]!.id] },
    })
    await receipt.completion
  })
})

describe('Claude final send checks', () => {
  it('does not write a user line when the acceptance callback cancels delivery', async () => {
    const t = await setup([
      control('interrupt', 'interrupt', { still_queued: [] }),
    ])
    let h!: ClaudeHandle
    let cancellation: Promise<void> | void = undefined
    h = await t.adapter.spawn(t.session, (event) => {
      t.emit(event)
      if (event.type === 'prompt_accepted') cancellation = h.cancel()
    })
    handles.push(h)
    await expect(h.prompt('cancel before write')).rejects.toThrow('cancelled')
    await cancellation
    expect((await t.wire()).filter((f) => f.type === 'user')).toHaveLength(0)
    expect(t.events.filter((e) => e.type === 'turn_completed')).toMatchObject([
      { outcome: { status: 'interrupted' } },
    ])
  })
  it('rejects cancelled preparation after a native model change and retains the acknowledged selection', async () => {
    const t = await setup([
      {
        expect: {
          type: 'control_request',
          request: { subtype: 'set_model', model: 'sonnet' },
        },
        capture: 'model',
        mark: 'model',
      },
      {
        expect: { type: 'control_request', request: { subtype: 'interrupt' } },
        capture: 'interrupt',
      },
      {
        send: {
          type: 'control_response',
          response: { subtype: 'success', request_id: '$model.request_id' },
        },
      },
      {
        send: {
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: '$interrupt.request_id',
            response: { still_queued: [] },
          },
        },
      },
      user(),
      init(),
      started(),
      result(),
    ])
    const h = await t.start()
    const pending = h.prompt('old', {
      permissionMode: 'manual',
      model: 'sonnet',
    })
    const rejected = expect(pending).rejects.toThrow('cancelled')
    await file(t.directory, 'model')
    await h.cancel()
    await rejected
    expect(t.events.filter((e) => e.type === 'prompt_accepted')).toHaveLength(0)
    await (
      await h.prompt('new', { permissionMode: 'manual', model: 'sonnet' })
    ).completion
    expect((await t.wire()).filter((f) => f.type === 'user')).toHaveLength(1)
  })
})

describe('Claude aggregate budget release', () => {
  it('releases interaction wire bytes after each reply', async () => {
    const requests = Array.from({ length: 10 }, (_, index) => [
      {
        send: {
          type: 'control_request',
          request_id: `request-${index}`,
          request: {
            subtype: 'can_use_tool',
            tool_name: 'Bash',
            input: { text: 'x'.repeat(MiB) },
          },
        },
      },
      {
        expect: {
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: `request-${index}`,
            response: { behavior: 'deny' },
          },
        },
      },
    ]).flat()
    const t = await setup([user(), init(), started(), ...requests, result()])
    const h = await t.start()
    const receipt = await h.prompt('go')
    for (let index = 0; index < 10; index++) {
      await t.until(
        (events) =>
          events.filter((e) => e.type === 'permission_requested').length >
          index,
      )
      const event = t.events.filter((e) => e.type === 'permission_requested')[
        index
      ]!
      await h.replyPermission!({
        type: 'denied',
        requestId: event.request.requestId,
      })
    }
    expect(await receipt.completion).toMatchObject({ status: 'completed' })
    expect(
      t.events.filter((e) => e.type === 'permission_requested'),
    ).toHaveLength(10)
  })
  it('bounds unresolved root wire bytes independently of frame count', async () => {
    const t = await setup([
      user(),
      init({ capabilities: [] }),
      full('x'.repeat(2 * MiB)),
      full('y'.repeat(2 * MiB)),
    ])
    const h = await t.start()
    expect(await (await h.prompt('pending')).completion).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('attribution buffer'),
    })
    expect(text(t.events)).toBe('')
  })
})

describe('Claude review regressions', () => {
  type RequestEvent = Extract<
    HarnessEvent,
    { type: 'permission_requested' | 'question_requested' }
  >
  const answer = (handle: ClaudeHandle, event: RequestEvent) => {
    if (event.type === 'permission_requested')
      return handle.replyPermission!({
        type: 'selected',
        requestId: event.request.requestId,
        optionId: 'allow_once',
      })
    const q = event.request.questions[0]!
    return handle.replyQuestion!(event.request.requestId, {
      [q.id]: { type: 'selected', optionIds: [q.options[0]!.id] },
    })
  }
  const child = () =>
    full('', {
      message: {
        id: 'spawn',
        content: [
          {
            type: 'tool_use',
            id: 'agent',
            name: 'Agent',
            input: { description: 'child' },
          },
        ],
      },
    })
  const childEnd = {
    send: {
      type: 'system',
      subtype: 'task_notification',
      tool_use_id: 'agent',
      status: 'killed',
    },
  }
  for (const kind of ['permission', 'question'] as const) {
    for (const ending of [
      'provider cancellation',
      'child completion',
    ] as const) {
      it(`retracts queued ${kind} replies at ${ending} and keeps unrelated work live`, async () => {
        const childOwned = ending === 'child completion'
        const request = kind === 'permission' ? permission() : question()
        if (childOwned)
          (request.send as Record<string, unknown>).parent_tool_use_id = 'agent'
        const other = permission()
        ;(other.send as Record<string, unknown>).request_id = 'other-request'
        const t = await setup([
          user(),
          init(),
          started(),
          ...(childOwned ? [child()] : []),
          request,
          { wait: 'cancel' },
          childOwned
            ? childEnd
            : {
                send: {
                  type: 'control_cancel_request',
                  request_id: 'native-request',
                },
              },
          full('cancellation observed'),
          { wait: 'finish' },
          { expect: { type: 'cleanup_blocker' } },
          other,
          {
            expect: {
              type: 'control_response',
              response: {
                request_id: 'other-request',
                response: { behavior: 'allow' },
              },
            },
          },
          {
            send: {
              type: 'control_cancel_request',
              request_id: 'native-request',
            },
          },
          full('still live'),
          result(),
        ])
        const h = await t.start()
        const root = await h.prompt('go')
        await t.until((events) =>
          events.some((e) => e.type === `${kind}_requested`),
        )
        const event = t.events.find(
          (e): e is RequestEvent => e.type === `${kind}_requested`,
        )!
        const runtime = h as unknown as {
          process: NativeProcess
          transport: JsonlTransport
          interactions: Map<string, unknown>
          interactionBytes: number
        }
        runtime.process.child.stdin.cork()
        try {
          const blocker = runtime.transport.send({ type: 'cleanup_blocker' })
          const pending = answer(h, event)
          const rejected = expect(pending).rejects.toThrow()
          expect(runtime.transport.state.queuedFrames).toBe(2)
          await expect(answer(h, event)).rejects.toThrow('stale')
          let reentrant: Promise<void> | undefined
          const terminal = childOwned
            ? t.until((events) => {
                if (!events.some((e) => e.type === 'child_finished'))
                  return false
                reentrant = expect(answer(h, event)).rejects.toThrow('stale')
                return true
              })
            : Promise.resolve()
          await t.gate('cancel')
          await t.until((events) =>
            text(events).includes('cancellation observed'),
          )
          await rejected
          await terminal
          await reentrant
          expect(runtime.transport.state.queuedFrames).toBe(1)
          expect(runtime.interactions.size).toBe(0)
          expect(runtime.interactionBytes).toBe(0)
          expect(
            t.events.filter((e) => e.type === 'request_cancelled'),
          ).toHaveLength(1)
          runtime.process.child.stdin.uncork()
          await blocker
          await t.gate('finish')
          await t.until((events) =>
            events.some(
              (e) =>
                e.type === 'permission_requested' &&
                e.request.requestId !== event.request.requestId,
            ),
          )
          const otherEvent = t.events.find(
            (e): e is Extract<HarnessEvent, { type: 'permission_requested' }> =>
              e.type === 'permission_requested' &&
              e.request.requestId !== event.request.requestId,
          )!
          await answer(h, otherEvent)
          expect(await root.completion).toMatchObject({ status: 'completed' })
          await t.finished()
          expect(
            (await t.wire()).filter(
              (f) =>
                f.type === 'control_response' &&
                f.response.request_id === 'native-request',
            ),
          ).toHaveLength(0)
          expect(text(t.events)).toContain('still live')
          expect(t.events.some((e) => e.type === 'run_failed')).toBe(false)
        } finally {
          runtime.process.child.stdin.uncork()
        }
      })
    }
    it(`expires unanswered child ${kind} requests before terminal callbacks`, async () => {
      const request = kind === 'permission' ? permission() : question()
      ;(request.send as Record<string, unknown>).parent_tool_use_id = 'agent'
      const t = await setup([
        user(),
        init(),
        started(),
        child(),
        request,
        { wait: 'end' },
        childEnd,
        { wait: 'finish' },
        result(),
      ])
      const h = await t.start()
      const root = await h.prompt('go')
      await t.until((events) =>
        events.some((e) => e.type === `${kind}_requested`),
      )
      const event = t.events.find(
        (e): e is RequestEvent => e.type === `${kind}_requested`,
      )!
      let reentrant: Promise<void> | undefined
      const terminal = t.until((events) => {
        if (!events.some((e) => e.type === 'child_finished')) return false
        reentrant = expect(answer(h, event)).rejects.toThrow('stale')
        return true
      })
      await t.gate('end')
      await terminal
      await reentrant
      await expect(answer(h, event)).rejects.toThrow('stale')
      expect(
        t.events.filter((e) => e.type === 'request_cancelled'),
      ).toHaveLength(1)
      await t.gate('finish')
      expect(await root.completion).toMatchObject({ status: 'completed' })
      expect(
        (await t.wire()).filter((f) => f.type === 'control_response'),
      ).toHaveLength(0)
    })
  }

  it.each(['free_text', 'selected', 'selected_with_text'] as const)(
    'serializes literal __proto__ question keys for %s',
    async (kind) => {
      const t = await setup([
        user(),
        init(),
        started(),
        question([{ question: '__proto__', options: [{ label: 'Yes' }] }]),
        reply({ behavior: 'allow' }),
        result(),
      ])
      const h = await t.start()
      const root = await h.prompt('go')
      await t.until((events) =>
        events.some((e) => e.type === 'question_requested'),
      )
      const event = t.events.find((e) => e.type === 'question_requested')!
      const q = event.request.questions[0]!
      await h.replyQuestion!(event.request.requestId, {
        [q.id]:
          kind === 'free_text'
            ? { type: kind, text: 'Literal answer' }
            : kind === 'selected'
              ? { type: kind, optionIds: [q.options[0]!.id] }
              : {
                  type: kind,
                  optionIds: [q.options[0]!.id],
                  text: 'Literal note',
                },
      })
      await root.completion
      const input = (await t.wire()).find((f) => f.type === 'control_response')
        .response.response.updatedInput
      expect(Object.hasOwn(input.answers, '__proto__')).toBe(true)
      expect(input.answers.__proto__).toBe(
        kind === 'free_text' ? 'Literal answer' : 'Yes',
      )
      if (kind === 'selected_with_text') {
        expect(Object.hasOwn(input.annotations, '__proto__')).toBe(true)
        expect(input.annotations.__proto__).toEqual({ notes: 'Literal note' })
      }
    },
  )

  it.each(['runId', 'turnId'] as const)(
    'rejects repeated oversized %s without retaining ownership',
    async (field) => {
      const t = await setup([user(), init(), started(), result()])
      const h = await t.start()
      const runtime = h as unknown as {
        ids: Identities
        turns: Map<string, unknown>
      }
      for (let i = 0; i < 64; i++) {
        await expect(
          h.prompt('oversized owner', undefined, {
            runId: String(i).padEnd(LIMITS.stringBytes - 4, 'r'),
            turnId: String(i).padEnd(LIMITS.stringBytes - 5, 't'),
            [field]: 'x'.repeat(LIMITS.stringBytes),
          }),
        ).rejects.toThrow('identity byte limit')
        expect(runtime.ids.size).toBe(0)
        expect(runtime.ids.retainedBytes).toBe(0)
        expect(runtime.turns.size).toBe(0)
      }
      expect(t.events).toHaveLength(0)
      expect(
        (await t.wire()).filter((frame) => frame.type === 'user'),
      ).toHaveLength(0)
      expect(await (await h.prompt('valid owner')).completion).toMatchObject({
        status: 'completed',
      })
      expect(
        (await t.wire()).filter((frame) => frame.type === 'user'),
      ).toHaveLength(1)
      await h.kill()
      expect(runtime.ids.size).toBe(0)
      expect(runtime.ids.retainedBytes).toBe(0)
    },
  )

  it('rejects colliding native tool names before retained names exceed their byte budget', async () => {
    const combined = 'a:'.repeat(128) + 'n'.repeat(62 * 1024)
    const frames = Array.from({ length: 128 }, (_, i) => {
      const cut = 2 * i + 1
      return {
        send: {
          type: 'assistant',
          uuid: `frame${i}`,
          message: {
            id: `message${i}`,
            content: [
              {
                type: 'tool_use',
                id: combined.slice(0, cut),
                name: combined.slice(cut + 1),
                input: {},
              },
            ],
          },
        },
      }
    })
    const t = await setup([user(), init(), started(), ...frames, result()])
    const h = await t.start()
    const root = await h.prompt('colliding names')
    expect(await root.completion).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('identity byte limit'),
    })
    const tools = t.events.filter((event) => event.type === 'tool_started')
    expect(tools.length).toBeGreaterThan(0)
    expect(tools.length).toBeLessThan(128)
    expect(
      tools.reduce((bytes, tool) => bytes + Buffer.byteLength(tool.name), 0),
    ).toBeLessThanOrEqual(LIMITS.identityBytes)
    for (const [i, tool] of tools.entries()) {
      const cut = 2 * i + 1
      expect(tool.toolCallId).toBe(combined.slice(0, cut))
      expect(tool.name).toBe(combined.slice(cut + 1))
    }
    await expect(h.prompt('after overflow')).rejects.toThrow('closed')
    await h.kill()
    const runtime = h as unknown as {
      ids: Identities
      normalizer: { state: { tools: number } }
    }
    expect(runtime.ids.size).toBe(0)
    expect(runtime.ids.retainedBytes).toBe(0)
    expect(runtime.normalizer.state.tools).toBe(0)
  })

  it('bounds and evicts native frame bytes through the real transport', async () => {
    const frames = Array.from({ length: 40 }, (_, i) => ({
      send: { type: 'idle', uuid: String(i).padEnd(LIMITS.stringBytes, 'x') },
    }))
    const t = await setup([
      user(),
      init(),
      started(),
      ...frames,
      full('fence'),
      { wait: 'finish' },
      result(),
    ])
    const h = await t.start()
    const root = await h.prompt('go')
    await t.until((events) => text(events) === 'fence')
    const runtime = h as unknown as {
      recentFrames: Map<string, number>
      recentFrameBytes: number
    }
    expect(runtime.recentFrameBytes).toBeLessThanOrEqual(LIMITS.frameBytes)
    expect(runtime.recentFrameBytes).toBe(
      [...runtime.recentFrames.values()].reduce((sum, bytes) => sum + bytes, 0),
    )
    expect(runtime.recentFrames.has('0'.padEnd(LIMITS.stringBytes, 'x'))).toBe(
      false,
    )
    expect(runtime.recentFrames.has('39'.padEnd(LIMITS.stringBytes, 'x'))).toBe(
      true,
    )
    await t.gate('finish')
    expect(await root.completion).toMatchObject({ status: 'completed' })
    await h.kill()
    expect(runtime.recentFrameBytes).toBe(0)
    expect(runtime.recentFrames.size).toBe(0)
  })
  it('fails explicitly for an oversized native frame identity', async () => {
    const t = await setup([
      user(),
      init(),
      started(),
      { send: { type: 'idle', uuid: 'x'.repeat(LIMITS.stringBytes + 1) } },
    ])
    const h = await t.start()
    const root = await h.prompt('go')
    expect(await root.completion).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('frame identity byte limit'),
    })
  })

  for (const phase of ['loader', 'reader'] as const) {
    for (const rejects of [false, true]) {
      it(`retains cancelled ${phase} admission until actual settlement, rejects=${rejects}`, async () => {
        const begun = deferred<void>()
        const underlying = deferred<void>()
        let active = 0
        let maximum = 0
        let loads = 0
        let reads = 0
        let first = true
        const run = async () => {
          if (!first) return
          first = false
          active++
          maximum = Math.max(maximum, active)
          begun.resolve()
          try {
            await underlying.promise
          } finally {
            active--
          }
        }
        const t = await setup(
          [
            init(),
            {
              repeat: 4,
              actions: [
                control('interrupt', 'interrupt', {
                  cancelled: [],
                  still_queued: [],
                }),
              ],
            },
            user(),
            started(),
            result(),
          ],
          {
            loadAttachment: async () => {
              loads++
              if (phase === 'loader') await run()
              return {
                mime: 'image/png',
                name: 'image',
                path: '/tmp/image',
                sizeBytes: 1,
                readBytes: async () => {
                  reads++
                  if (phase === 'reader') await run()
                  return Buffer.alloc(1)
                },
              }
            },
          },
        )
        const h = await t.start()
        const input = [
          {
            type: 'attachment' as const,
            attachmentId: 'image',
            mime: 'image/png',
          },
        ]
        const pending = h.prompt(input)
        const rejected = expect(pending).rejects.toThrow('cancelled')
        await begun.promise
        await h.cancel()
        await rejected
        for (let i = 0; i < 3; i++) {
          await expect(h.prompt(input)).rejects.toThrow(
            'attachment work is still active',
          )
          await h.cancel()
        }
        expect(active).toBe(1)
        expect(maximum).toBe(1)
        expect(loads).toBe(1)
        expect(reads).toBe(phase === 'reader' ? 1 : 0)
        expect(t.events.some((e) => e.type === 'prompt_accepted')).toBe(false)
        if (rejects) underlying.reject(new Error('late attachment failure'))
        else underlying.resolve()
        await underlying.promise.catch(() => {})
        // Wait for the original loader/reader and its admission-finally callback.
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(active).toBe(0)
        expect(await (await h.prompt(input)).completion).toMatchObject({
          status: 'completed',
        })
        expect(loads).toBe(2)
        expect(reads).toBe(phase === 'reader' ? 2 : 1)
        expect(maximum).toBe(1)
        await t.finished()
      })
    }
    it(`closes with one unsettled ${phase} and rejects later work`, async () => {
      const begun = deferred<void>()
      const release = deferred<void>()
      let active = 0
      const run = async () => {
        active++
        begun.resolve()
        try {
          await release.promise
        } finally {
          active--
        }
      }
      const t = await setup([], {
        loadAttachment: async () => {
          if (phase === 'loader') await run()
          return {
            mime: 'image/png',
            name: 'image',
            path: '/tmp/image',
            sizeBytes: 1,
            readBytes: async () => {
              if (phase === 'reader') await run()
              return Buffer.alloc(1)
            },
          }
        },
      })
      const h = await t.start()
      const input = [
        {
          type: 'attachment' as const,
          attachmentId: 'image',
          mime: 'image/png',
        },
      ]
      const rejected = expect(h.prompt(input)).rejects.toThrow('cancelled')
      await begun.promise
      await h.kill()
      await rejected
      expect(active).toBe(1)
      await expect(h.prompt(input)).rejects.toThrow('closed')
      release.resolve()
      await release.promise
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(active).toBe(0)
      expect((await t.wire()).filter((f) => f.type === 'user')).toHaveLength(0)
    })
  }
})
