import { describe, expect, it } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { harnessEventSchema } from '@forge/protocol/harness'
import { deferred, expectStopped } from '../transport-test-helpers.js'
import {
  copyLaunchOptions,
  normalizeCodexArgs,
  prepareCodexEnvironment,
  selectedRemovalKeys,
} from './environment.js'
import { CodexOptions, MiB } from './wire.js'
import {
  peer,
  turn,
  turnFrame,
  itemFrame,
  eventually,
  methods,
  sandbox,
} from './test-helpers.js'

describe('Codex native owned process', () => {
  it('1, 5: initializes, reads config, discovers surfaces, then confirms exact startup without an event', async () => {
    const p = await peer()
    const handle = await p.start()
    expect(handle.binding).toEqual({
      provider: 'codex-test',
      accountId: null,
      cwd: p.root,
      providerSessionId: 'root',
    })
    expect(p.events).toEqual([])
    const trace = await p.trace()
    expect(trace.every((frame) => !Object.hasOwn(frame, 'jsonrpc'))).toBe(true)
    expect(
      trace.find((frame) => frame.method === 'thread/start')!.params,
    ).toEqual({
      cwd: p.root,
      ephemeral: false,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
      config: {
        sandbox_workspace_write: {
          writable_roots: [],
          network_access: false,
          exclude_slash_tmp: false,
          exclude_tmpdir_env_var: false,
        },
        model_reasoning_effort: 'medium',
      },
      model: 'm',
      serviceTier: 'default',
    })
  })
  it('6, 7: resume uses the persisted thread and never falls back after native failure', async () => {
    const p = await peer([], { load: true })
    p.startup[p.startup.length - 1] = {
      method: 'thread/resume',
      error: { code: -32000, message: 'History is missing' },
    }
    await p.save(p.startup)
    await expect(p.start()).rejects.toThrow('History is missing')
    expect(await methods(p)).not.toContain('thread/start')
    expect(
      (await p.trace()).find((frame) => frame.method === 'thread/resume')!
        .params,
    ).toMatchObject({ threadId: 'root', excludeTurns: true })
  })
  it('8, 9, 10: sequential prompts retain one thread and settle each accepted owner once', async () => {
    const p = await peer([
      {
        method: 'turn/start',
        result: { turn: turn('a') },
        after: [
          turnFrame('started', 'a'),
          itemFrame({ id: 'message', type: 'agentMessage', text: 'done' }, 'a'),
          turnFrame('completed', 'a'),
        ],
      },
      {
        method: 'turn/start',
        before: [turnFrame('started', 'b'), turnFrame('completed', 'b')],
        result: { turn: turn('b') },
      },
    ])
    const h = await p.start()
    const a = await h.prompt('first', undefined, { runId: 'r1', turnId: 'f1' })
    expect(await a.completion).toEqual({
      runId: 'r1',
      turnId: 'f1',
      status: 'completed',
    })
    const b = await h.prompt('second', undefined, { runId: 'r2', turnId: 'f2' })
    expect(await b.completion).toEqual({
      runId: 'r2',
      turnId: 'f2',
      status: 'completed',
    })
    await p.send([turnFrame('started', 'a'), turnFrame('completed', 'a')])
    await eventually(
      () =>
        p.events.filter((event) => event.type === 'turn_completed').length ===
        2,
    )
    expect(new Set(p.events.map((event) => event.runtimeGeneration)).size).toBe(
      1,
    )
    p.events.forEach((event) => harnessEventSchema.parse(event))
  })
  it('9: a receipt resolves before the terminal event', async () => {
    const p = await peer([{ method: 'turn/start', result: { turn: turn() } }])
    const h = await p.start()
    const receipt = await h.prompt('input')
    let done = false
    void receipt.completion.then(() => {
      done = true
    })
    await Promise.resolve()
    expect(done).toBe(false)
    await p.send([turnFrame('completed')])
    expect((await receipt.completion).status).toBe('completed')
  })
  it('12: explicit start rejection does not retry input', async () => {
    const p = await peer([
      {
        method: 'turn/start',
        error: { code: -32001, message: 'Input rejected' },
      },
    ])
    const h = await p.start()
    await expect(h.prompt('kept draft')).rejects.toThrow('Input rejected')
    expect(
      (await methods(p)).filter((method) => method === 'turn/start'),
    ).toHaveLength(1)
  })
  it('13, 14, 59: steer retains completion and captured IDs even when completion precedes the reply', async () => {
    const p = await peer([
      { method: 'turn/start', result: { turn: turn() } },
      {
        method: 'turn/steer',
        before: [turnFrame('completed')],
        result: { turnId: 't1' },
      },
    ])
    const h = await p.start()
    const first = await h.prompt('first', undefined, {
      runId: 'run',
      turnId: 'forge-turn',
    })
    await expect(
      h.steer!('wrong', undefined, { runId: 'other', turnId: 'forge-turn' }),
    ).rejects.toThrow('IDENTITY')
    const steer = await h.steer!('next', undefined, {
      runId: 'run',
      turnId: 'forge-turn',
    })
    expect(steer.completion).toBe(first.completion)
    expect(steer.receiptId).not.toBe(first.receiptId)
    expect((await first.completion).status).toBe('completed')
    expect(
      (await p.trace()).find((frame) => frame.method === 'turn/steer')!.params,
    ).toMatchObject({ expectedTurnId: 't1', threadId: 'root' })
  })
  it('15, 99: steer inherits active options and rejects explicit changes before bytes', async () => {
    const p = await peer([
      { method: 'turn/start', result: { turn: turn() } },
      { method: 'turn/steer', result: { turnId: 't1' } },
    ])
    const h = await p.start()
    await h.prompt('first')
    await h.setConfigOption!('permissionMode', 'yolo')
    await expect(h.steer!('wrong', { permissionMode: 'yolo' })).rejects.toThrow(
      'STEER_OPTIONS',
    )
    await h.steer!('still manual')
    expect(
      (await methods(p)).filter((method) => method === 'turn/steer'),
    ).toHaveLength(1)
  })
  it('16, 17, 44: interrupt ack alone stays pending; deadline stops only the owned child', async () => {
    const p = await peer(
      [
        { method: 'turn/start', result: { turn: turn() } },
        {
          method: 'turn/interrupt',
          expected: { threadId: 'root', turnId: 't1' },
          result: {},
        },
      ],
      { options: { interruptGraceMs: 25 } },
    )
    const h = await p.start()
    const result = await h.prompt('input')
    const pid = (await p.trace()).find((frame) => frame.event === 'spawned')!
      .pid as number
    await h.cancel()
    expect((await result.completion).status).toBe('interrupted')
    await expectStopped(pid)
    expect(h.binding?.providerSessionId).toBe('root')
    await expect(h.prompt('after death')).rejects.toThrow('UNAVAILABLE')
  })
  it('18, 54: process death rejects unfinished preparation and keeps confirmed binding', async () => {
    const loader = deferred<{
      mime: string
      name: string
      path: string
      sizeBytes: number
    }>()
    const p = await peer([], {
      options: { loadAttachment: () => loader.promise },
    })
    const h = await p.start()
    const send = Promise.resolve(
      h.prompt([{ type: 'attachment', attachmentId: 'id', mime: 'image/png' }]),
    )
    const rejected = expect(send).rejects.toThrow()
    await p.exit()
    await rejected
    loader.resolve({
      mime: 'image/png',
      name: 'x',
      path: '/missing',
      sizeBytes: 0,
    })
    expect(h.binding?.providerSessionId).toBe('root')
    expect(await methods(p)).not.toContain('turn/start')
  })
  it('53, 55: admission precedes loaders and cancelled work never sends', async () => {
    const gate = deferred<{
      mime: string
      name: string
      path: string
      sizeBytes: number
    }>()
    let called = 0
    const p = await peer([], {
      options: {
        loadAttachment: () => {
          called++
          return gate.promise
        },
      },
    })
    const h = await p.start()
    const send = Promise.resolve(
      h.prompt([
        { type: 'attachment', attachmentId: 'upload', mime: 'image/png' },
      ]),
    )
    const rejected = expect(send).rejects.toThrow('CANCELLED')
    await expect(h.prompt('overlap')).rejects.toThrow('BUSY')
    await h.setConfigOption!('permissionMode', 'yolo')
    await h.cancel()
    await rejected
    gate.resolve({
      mime: 'image/png',
      name: 'x',
      path: '/missing',
      sizeBytes: 0,
    })
    expect(called).toBe(1)
    expect(await methods(p)).not.toContain('turn/start')
  })
  it('56: an automatic root turn invalidates ordinary attachment preparation', async () => {
    const gate = deferred<{
      mime: string
      name: string
      path: string
      sizeBytes: number
    }>()
    const p = await peer([], {
      options: { loadAttachment: () => gate.promise },
    })
    const h = await p.start()
    const send = Promise.resolve(
      h.prompt([
        { type: 'attachment', attachmentId: 'upload', mime: 'image/png' },
      ]),
    )
    const rejected = expect(send).rejects.toThrow('CANCELLED')
    await p.send([turnFrame('started', 'wake')])
    await rejected
    gate.resolve({
      mime: 'image/png',
      name: 'x',
      path: '/missing',
      sizeBytes: 0,
    })
    expect(
      p.events.filter((event) => event.type === 'turn_started'),
    ).toHaveLength(1)
    expect(await methods(p)).not.toContain('turn/start')
  })
  it('40, 41: attachment inputs retain image, file, text and review-reference order', async () => {
    const p = await peer([{ method: 'turn/start', result: { turn: turn() } }])
    const image = join(p.root, 'photo.png')
    const file = join(p.root, 'notes.txt')
    await writeFile(image, 'png')
    await writeFile(file, 'notes')
    p.options.loadAttachment = async (_session, id) => ({
      mime: id === 'photo' ? 'image/png' : 'text/plain',
      name: id,
      path: id === 'photo' ? image : file,
      sizeBytes: id === 'photo' ? 3 : 5,
    })
    const h = await p.start()
    await h.prompt([
      { type: 'attachment', attachmentId: 'photo', mime: 'image/png' },
      { type: 'attachment', attachmentId: 'notes', mime: 'text/plain' },
      { type: 'text', text: 'tail' },
      {
        type: 'review_reference',
        url: 'https://example.com/review',
        title: 'Review',
      },
    ])
    const params = (await p.trace()).find(
      (frame) => frame.method === 'turn/start',
    )!.params as { input: unknown[] }
    expect(params.input).toEqual([
      { type: 'localImage', path: image },
      {
        type: 'text',
        text: `Local file attachment: notes\n${file}`,
        text_elements: [],
      },
      { type: 'text', text: 'tail', text_elements: [] },
      {
        type: 'text',
        text: 'Review reference: Review\nhttps://example.com/review',
        text_elements: [],
      },
    ])
  })
  it('3: versioned native frames retire the runtime', async () => {
    const p = await peer()
    const h = await p.start()
    await p.send([
      {
        jsonrpc: '2.0',
        method: 'turn/started',
        params: { threadId: 'root', turn: turn() },
      },
    ])
    await eventually(async () => {
      try {
        await h.prompt('after')
        return false
      } catch {
        return true
      }
    })
  })
})

describe('Codex launch and options', () => {
  it('45, 101, 102, 106: selected launches reject missing, narrower, and mismatched authority before any child', async () => {
    const p = await peer([], { selected: true })
    for (const update of [
      { nativeLaunch: undefined },
      {
        nativeLaunch: {
          ...(p.options as any).nativeLaunch,
          credentials: 'home-only',
        },
      },
      {
        nativeLaunch: { ...(p.options as any).nativeLaunch, provider: 'other' },
      },
    ]) {
      expect(() =>
        copyLaunchOptions({ ...p.options, ...update } as any),
      ).toThrow('CODEX_ACCOUNT_')
    }
    expect(await p.trace()).toEqual([])
  })
  it('46, 47, 48, 49, 103: fixed removals apply in the actual eager child', async () => {
    const p = await peer([], {
      selected: true,
      absent: selectedRemovalKeys.filter((key) => key !== 'CODEX_HOME'),
      eager: 'model-refresh',
    })
    const h = await p.start()
    expect(h.binding?.accountId).toBe('account')
    expect((await p.trace())[1]).toEqual({
      event: 'authorized-eager-source',
      source: 'model-refresh',
    })
    const prepared = await prepareCodexEnvironment(
      copyLaunchOptions(p.options),
      p.root,
    )
    for (const key of selectedRemovalKeys.filter(
      (key) => key !== 'CODEX_HOME',
    )) {
      expect(Object.hasOwn(prepared.env, key)).toBe(true)
      expect(prepared.env[key]).toBeUndefined()
    }
  })
  it.each([
    '--model=m',
    '-mm',
    '--sandbox=read-only',
    '--listen=stdio://',
    '--resume',
    '--remote-control',
    '-capproval_policy="never"',
    '--config=sandbox_mode="read-only"',
  ])('35, 36: rejects adapter-owned argument %s', (argument) => {
    expect(() => normalizeCodexArgs([argument])).toThrow()
  })
  it('47: retains ordinary native profile and configured overrides', () => {
    expect(
      normalizeCodexArgs([
        '--profile',
        'custom',
        '-c',
        'mcp_servers.demo.command="server"',
        'app-server',
        '--stdio',
      ]),
    ).toEqual([
      '--profile',
      'custom',
      '-c',
      'mcp_servers.demo.command="server"',
      'app-server',
      '--stdio',
    ])
  })
  it('95, 96, 97, 98: per-call overrides do not replace baseline or persist yolo', () => {
    const policy = new CodexOptions({
      model: 'configured',
      model_reasoning_effort: 'medium',
      service_tier: 'default',
    })
    const yolo = policy.resolve({
      permissionMode: 'yolo',
      model: 'override',
      serviceTier: 'priority',
    })
    policy.sent(yolo)
    expect(yolo.approvalPolicy).toBe('never')
    expect(policy.resolve()).toMatchObject({
      model: 'configured',
      serviceTier: 'default',
      permissionMode: 'manual',
      approvalPolicy: 'on-request',
      sandboxPolicy: sandbox,
    })
    policy.set({ model: 'desired' })
    expect(policy.resolve({ model: null }).model).toBe('configured')
    expect(policy.resolve().model).toBe('desired')
    expect(() => policy.resolve({ model: '', serviceTier: '' })).toThrow()
    const unknown = new CodexOptions({})
    unknown.sent(unknown.resolve({ model: 'x' }))
    expect(() => unknown.resolve({ model: null })).toThrow(
      'BASELINE_UNAVAILABLE',
    )
  })
  it('43, 72, 73: input and identity limits reject before dispatch', async () => {
    const p = await peer()
    const h = await p.start()
    await expect(h.prompt('x'.repeat(4 * MiB + 1))).rejects.toThrow(
      'INPUT_LIMIT',
    )
    await expect(
      h.prompt('valid', undefined, { runId: '界'.repeat(342), turnId: 't' }),
    ).rejects.toThrow('IDENTITY')
    expect(await methods(p)).not.toContain('turn/start')
  })
})
