import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  chmod,
  symlink,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PassThrough } from 'node:stream'
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { cursorLimits, CursorResources, plainCopy } from './limits.js'
import { CursorNormalizer } from './normalize.js'
import {
  captureInput,
  cursorMessage,
  cursorPolicy,
  validateCatalog,
  validateModel,
  modelConfig,
  inputDigest,
} from './input.js'
import { parseRawJsonl, inspectRawStore, boundedRead } from './store.js'
import {
  validateStoredCredentials,
  readCursorCredentials,
} from './credentials.js'
import { managerUnsetKeys, validateEnvironment } from './launch.js'
import { CursorWire, cursorTransport, parseFrame } from './wire.js'
import { DiagnosticTail } from '../diagnostics.js'
import { NativeProcess } from '../process.js'
import type { HarnessEvent } from '../types.js'
import type {
  CursorOwner,
  CursorNativeEnvelope,
  CursorSelectedRecords,
} from './contracts.js'
import type { InteractionUpdate } from '@cursor/sdk'
import { modelOptionsSchema } from '@forge/protocol/harness'

const limits = cursorLimits()
const owner: CursorOwner = {
  forgeSessionId: 'session',
  provider: 'cursor-one',
  accountId: 'account',
  cwd: '/tmp',
  storeId: randomUUID(),
  generation: 'generation',
  attemptId: 'attempt',
  runId: 'run',
  turnId: 'turn',
}
let root: string, peer: string
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'forge-cursor-focused-'))
  peer = join(root, 'peer.mjs')
  await mkdir(join(root, 'native-data'), { mode: 0o700 })
  await promisify(execFile)(
    'bun',
    [
      'build',
      '--target=node',
      '--external',
      '@cursor/sdk',
      resolve('apps/server/test/fixtures/cursor-peer.ts'),
      '--outfile',
      peer,
    ],
    { timeout: 30000, maxBuffer: 4096 },
  )
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})
function normalizer() {
  const events: HarnessEvent[] = [],
    records: CursorNativeEnvelope[] = []
  return {
    events,
    records,
    normalizer: new CursorNormalizer(
      owner,
      limits,
      (value) => events.push(value),
      (value) => records.push(value),
    ),
  }
}
function delta(normalizer: CursorNormalizer, value: unknown) {
  normalizer.delta(value as InteractionUpdate)
}
const selected = (home: string): CursorSelectedRecords => ({
  provider: 'cursor-one',
  selectionEpoch: 'epoch',
  harness: {
    name: 'Cursor',
    command: process.execPath,
    args: [],
    env: {},
    protocol: 'acp',
    adapterKind: 'native',
    enabled: true,
  },
  account: {
    id: 'account',
    harnessKey: 'cursor-one',
    kind: 'cursor',
    adapterKind: 'native',
    homePath: home,
    disabledAt: null,
    label: 'Test',
    orderIndex: 0,
    createdAt: 0,
    lastUsedAt: null,
    identity: null,
    config: null,
  },
  credential: { type: 'api-key', apiKey: 'synthetic-key' },
  accountEnv: {},
  settingSources: [],
})

describe('Cursor launch, credentials, input and limits', () => {
  it('rejects getters and proxies without reading values', () => {
    let reads = 0
    expect(() =>
      plainCopy(
        {
          get secret() {
            reads++
            return 'value'
          },
        },
        1024,
      ),
    ).toThrow()
    expect(reads).toBe(0)
    expect(() =>
      plainCopy(
        new Proxy(
          {},
          {
            ownKeys() {
              reads++
              return []
            },
          },
        ),
        1024,
      ),
    ).toThrow()
    expect(reads).toBe(0)
  })
  it('copies nested caller values before mutation', () => {
    const value = { args: ['first'], nested: { value: 1 } }
    const captured = plainCopy(value, 1024)
    value.args.push('second')
    value.nested.value = 2
    expect(captured).toEqual({ args: ['first'], nested: { value: 1 } })
    expect(Object.isFrozen(captured.args)).toBe(true)
  })
  it('rejects every invalid limit override', () => {
    for (const key of Object.keys(limits))
      for (const value of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER])
        expect(() => cursorLimits({ [key]: value })).toThrow()
  })
  it('preserves physical charges until explicit release across shared resources', () => {
    const resources = new CursorResources()
    const release = resources.charge('callbacks', 1, 1)
    expect(() => resources.charge('callbacks', 1, 1)).toThrow()
    release()
    release()
    expect(resources.snapshot().callbacks).toBe(0)
  })
  it('removes manager injection keys and rejects invalid environment keys', () => {
    expect(
      managerUnsetKeys(
        ['NODE_OPTIONS', 'LD_PRELOAD', 'CURSOR_API_KEY', 'SAFE'],
        ['REMOVED'],
        limits,
      ),
    ).toEqual(
      expect.arrayContaining([
        'NODE_OPTIONS',
        'LD_PRELOAD',
        'CURSOR_API_KEY',
        'REMOVED',
      ]),
    )
    expect(() => validateEnvironment({ 'INVALID-KEY': 'x' }, limits)).toThrow()
  })
  it('rejects omitted and manual policies and granular overrides', () => {
    expect(() => cursorPolicy(undefined)).toThrow()
    expect(() => cursorPolicy({ permissionMode: 'manual' })).toThrow()
    expect(() =>
      cursorPolicy({ permissionMode: 'auto', serviceTier: 'priority' }),
    ).toThrow()
    expect(() =>
      cursorPolicy({ permissionMode: 'auto', approvalPolicy: 'never' }),
    ).toThrow()
    expect(cursorPolicy({ permissionMode: 'auto' })).toMatchObject({
      autoReview: true,
      sandboxOptions: { enabled: true },
    })
    expect(cursorPolicy({ permissionMode: 'yolo' })).toMatchObject({
      autoReview: false,
      sandboxOptions: { enabled: false },
    })
  })
  it('preserves aliases, exact parameters and null options', () => {
    const items = validateCatalog(
      [
        {
          id: 'model',
          displayName: 'Model',
          aliases: ['alias'],
          parameters: [{ id: 'effort', values: [{ value: 'high' }] }],
        },
      ],
      limits,
    )
    expect(
      validateModel(
        { id: 'alias', params: [{ id: 'effort', value: 'high' }] },
        items,
      ).id,
    ).toBe('alias')
    expect(modelConfig({ id: 'alias' }, items)[0].currentValue).toBeNull()
    expect(() => validateModel({ id: 'missing' }, items)).toThrow()
    expect(() =>
      validateModel(
        { id: 'alias', params: [{ id: 'effort', value: 'low' }] },
        items,
      ),
    ).toThrow()
    expect(() => validateCatalog([...items, ...items], limits)).toThrow()
  })
  it('validates native model parameters at the shared protocol boundary', () => {
    const params = [{ id: 'é'.repeat(64), value: 'é'.repeat(128) }]
    expect(
      modelOptionsSchema.parse({ nativeModelParams: params }).nativeModelParams,
    ).toEqual(params)
    for (const invalid of [
      [...params, ...params],
      [{ id: 'é'.repeat(65), value: '' }],
      [{ id: 'p', value: 'é'.repeat(129) }],
      [{ id: 'p', value: 'v', extra: true }],
      [{ id: '', value: 'v' }],
      Array.from({ length: 33 }, (_, index) => ({
        id: String(index),
        value: '',
      })),
    ])
      expect(
        modelOptionsSchema.safeParse({ nativeModelParams: invalid }).success,
      ).toBe(false)
  })
  it('rejects all malformed credential fields and keeps valid zero timestamps', () => {
    const record = {
      version: 1,
      backendUrl: 'https://api2.cursor.sh',
      apiKey: 'synthetic-key',
      createdAtMs: 0,
    }
    expect(
      validateStoredCredentials({ ...record, unknown: 'ignored' }, limits),
    ).toEqual(record)
    for (const [key, value] of [
      ['version', 2],
      ['backendUrl', 0],
      ['apiKey', 0],
      ['createdAtMs', Infinity],
      ['apiKeyExpiresAtMs', '0'],
      ['email', 0],
    ])
      expect(() =>
        validateStoredCredentials(
          { ...record, [key as string]: value },
          limits,
        ),
      ).toThrow()
    for (const key of Object.keys(record)) {
      const row = { ...record }
      delete row[key as keyof typeof row]
      expect(() => validateStoredCredentials(row, limits)).toThrow()
    }
  })
  it('reads only stable owned bounded credential files and rejects expiry, backend and symlinks', async () => {
    const home = await mkdtemp(join(root, 'home-')),
      path = join(home, 'auth.json')
    const record = {
      version: 1,
      backendUrl: 'https://api2.cursor.sh',
      apiKey: 'synthetic-key',
      createdAtMs: 0,
    }
    const authority = {
      ...selected(home),
      credential: { type: 'sdk-file' as const, path },
    }
    await writeFile(path, JSON.stringify(record), { mode: 0o600 })
    const credential = await readCursorCredentials(
      authority,
      limits,
      new AbortController().signal,
    )
    expect(credential.apiKey).toBe('synthetic-key')
    await expect(credential.store.save(record as any)).rejects.toThrow(
      'read_only',
    )
    await writeFile(path, JSON.stringify({ ...record, apiKeyExpiresAtMs: 0 }))
    await expect(
      readCursorCredentials(authority, limits, new AbortController().signal),
    ).rejects.toThrow('expired')
    await writeFile(
      path,
      JSON.stringify({ ...record, backendUrl: 'https://foreign.invalid' }),
    )
    await expect(
      readCursorCredentials(authority, limits, new AbortController().signal),
    ).rejects.toThrow('backend')
    await writeFile(path, JSON.stringify(record))
    await chmod(path, 0o644)
    await expect(boundedRead(path, 65536, true)).rejects.toThrow('permissions')
    await chmod(path, 0o600)
    const link = join(home, 'link')
    await symlink(path, link)
    await expect(boundedRead(link, 65536, true)).rejects.toThrow()
    await expect(boundedRead(path, 4)).rejects.toThrow()
  })
  it('preserves attachment order, reviews, MIME and signatures', async () => {
    const parts = captureInput(
      [
        { type: 'text', text: 'first' },
        { type: 'attachment', attachmentId: 'png', mime: 'image/png' },
        {
          type: 'review_reference',
          title: 'Review',
          url: 'https://example.invalid/1',
        },
        { type: 'attachment', attachmentId: 'jpeg', mime: 'image/jpeg' },
      ],
      { permissionMode: 'auto' },
      limits,
    ).parts
    const loader = vi.fn(async (_session: string, id: string) => {
      const bytes =
        id === 'png'
          ? Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
          : Buffer.from([255, 216, 255])
      return {
        attachmentId: id,
        mime: id === 'png' ? 'image/png' : 'image/jpeg',
        size: bytes.length,
        read: async () => bytes,
      }
    })
    const message = await cursorMessage(
      'session',
      parts,
      loader,
      new AbortController().signal,
      limits,
    )
    expect(message.text).toBe(
      'first\n[Attachment 1: png]\nReview: https://example.invalid/1\n[Attachment 2: jpeg]',
    )
    expect(
      message.images?.map((image) => 'mimeType' in image && image.mimeType),
    ).toEqual(['image/png', 'image/jpeg'])
    const abort = new AbortController()
    abort.abort()
    await expect(
      cursorMessage('session', parts, loader, abort.signal, limits),
    ).rejects.toThrow()
    expect(loader).toHaveBeenCalledTimes(2)
  })
})
describe('Cursor root and child authority', () => {
  it('keeps A, child marker, B as one AB item', () => {
    const { normalizer: n, events } = normalizer()
    delta(n, { type: 'text-delta', text: 'A' })
    n.step({ type: 'assistantMessage', message: { text: 'A' } })
    delta(n, { type: 'step-completed', stepId: 1, stepDurationMs: 1 })
    delta(n, { type: 'text-delta', text: 'B' })
    n.finish({ id: 'native', status: 'finished', result: 'AB' })
    const snapshots = events.filter((event) => event.type === 'text_delta')
    expect(new Set(snapshots.map((event) => event.itemId)).size).toBe(1)
    expect(snapshots.map((event) => event.text).join('')).toBe('AB')
    expect(
      events.filter((event) => event.type === 'content_snapshot'),
    ).toHaveLength(0)
  })
  it('preserves thought duration and actual tool boundaries', () => {
    const { normalizer: n, events, records } = normalizer()
    delta(n, { type: 'thinking-delta', text: 'thought' })
    delta(n, { type: 'thinking-completed', thinkingDurationMs: 25 })
    delta(n, { type: 'text-delta', text: 'A' })
    delta(n, {
      type: 'tool-call-completed',
      callId: 'shell',
      toolCall: {
        type: 'shell',
        args: { command: 'true' },
        result: { status: 'success', value: { exitCode: 0 } },
      },
    })
    delta(n, { type: 'text-delta', text: 'B' })
    n.finish({ id: 'native', status: 'finished', result: '' })
    const text = events.filter(
      (event) =>
        event.type === 'text_delta' ||
        (event.type === 'content_snapshot' && event.contentType === 'text'),
    )
    expect(text.map((event) => event.text)).toEqual(['A', 'B', ''])
    expect(
      records.some((record) =>
        JSON.stringify(record.payload).includes('thinkingDurationMs'),
      ),
    ).toBe(true)
  })
  it('preserves a stream-only summary without duplicate root text or terminal events', () => {
    const { normalizer: n, events, records } = normalizer()
    delta(n, { type: 'text-delta', text: 'A' })
    n.stream({ type: 'task', text: 'summary' } as any)
    n.stream({
      type: 'assistant',
      agent_id: 'agent',
      run_id: 'run',
      message: { role: 'assistant', content: [{ type: 'text', text: 'A' }] },
    })
    expect(events.filter((event) => event.type === 'text_delta')).toHaveLength(
      1,
    )
    expect(records.filter((record) => record.kind === 'summary')).toHaveLength(
      1,
    )
    expect(events.some((event) => event.type === 'turn_completed')).toBe(false)
  })
  it('keeps reused provider IDs on separate executions and observations cannot finish them', () => {
    const { normalizer: n, events } = normalizer()
    for (const id of ['spawn', 'continuation']) {
      delta(n, {
        type: 'tool-call-started',
        callId: id,
        toolCall: {
          type: 'task',
          args: {
            prompt: 'work',
            description: 'task',
            ...(id === 'continuation' ? { resume: 'shared' } : {}),
          },
        },
      })
      delta(n, {
        type: 'tool-call-completed',
        callId: id,
        toolCall: {
          type: 'task',
          args: { prompt: 'work' },
          result: {
            status: 'success',
            value: { agentId: 'shared', isBackground: true },
          },
        },
      })
    }
    delta(n, {
      type: 'tool-call-started',
      callId: 'observe',
      toolCall: { type: 'task', args: { prompt: '', resume: 'shared' } },
    })
    delta(n, {
      type: 'tool-call-completed',
      callId: 'observe',
      toolCall: {
        type: 'task',
        result: {
          status: 'error',
          error: 'Await timed out while task is still running',
        },
      },
    })
    expect(
      events.filter((event) => event.type === 'child_started'),
    ).toHaveLength(2)
    expect(
      events.filter((event) => event.type === 'child_finished'),
    ).toHaveLength(0)
    n.finish({ id: 'native', status: 'finished' })
    expect(
      events
        .filter((event) => event.type === 'child_finished')
        .every(
          (event) =>
            event.outcome.status === 'failed' &&
            event.outcome.code === 'cursor_child_outcome_unavailable',
        ),
    ).toBe(true)
  })
  it('keeps incomplete task fields unavailable, settles exact foreground results, and retains old late metadata', () => {
    const { normalizer: n, events, records } = normalizer()
    delta(n, {
      type: 'partial-tool-call',
      callId: 'partial',
      toolCall: { type: 'task', args: { resume: 'shared' } },
    })
    delta(n, {
      type: 'tool-call-delta',
      callId: 'partial',
      taskUpdate: { type: 'text-delta', text: 'unowned' },
    })
    expect(events.some((event) => event.type === 'child_started')).toBe(false)
    delta(n, {
      type: 'tool-call-started',
      callId: 'foreground',
      toolCall: { type: 'task', args: { prompt: 'work' } },
    })
    delta(n, {
      type: 'tool-call-completed',
      callId: 'foreground',
      toolCall: {
        type: 'task',
        args: { prompt: 'work' },
        result: {
          status: 'success',
          value: { agentId: 'shared', isBackground: false },
        },
      },
    })
    expect(
      events.filter((event) => event.type === 'child_finished'),
    ).toMatchObject([{ outcome: { status: 'completed' } }])
    delta(n, {
      type: 'tool-call-started',
      callId: 'observation',
      toolCall: { type: 'task', args: { prompt: '', agentId: 'shared' } },
    })
    delta(n, {
      type: 'tool-call-completed',
      callId: 'observation',
      toolCall: {
        type: 'task',
        result: { status: 'error', error: 'Background task unavailable' },
      },
    })
    n.finish({ id: 'native', status: 'finished', result: '' })
    const before = events.length
    delta(n, {
      type: 'tool-call-delta',
      callId: 'foreground',
      taskUpdate: { type: 'text-delta', text: 'late original root' },
    })
    expect(events).toHaveLength(before)
    expect(records.at(-1)).toMatchObject({ owner, kind: 'sdk-record' })
    expect(JSON.stringify(records.at(-1))).toContain('late original root')
    expect(
      events.filter((event) => event.type === 'child_finished'),
    ).toHaveLength(1)
    expect(
      events.filter((event) => event.type === 'content_snapshot'),
    ).toHaveLength(0)
  })
  it('keeps exposed question errors and native image paths as inert tool records', () => {
    const { normalizer: n, records, events } = normalizer()
    for (const [name, result] of [
      [
        'askQuestion',
        { status: 'error', error: 'Question cannot be answered' },
      ],
      [
        'generateImage',
        { status: 'success', value: { path: '/unread/native/image.png' } },
      ],
    ] as const)
      delta(n, {
        type: 'tool-call-completed',
        callId: name,
        toolCall: { type: name, args: {}, result },
      })
    expect(JSON.stringify(records)).toContain('Question cannot be answered')
    expect(JSON.stringify(records)).toContain('/unread/native/image.png')
    expect(events.some((event) => event.type === 'content_snapshot')).toBe(
      false,
    )
  })
})
describe('Cursor raw store and actual wire runtime', () => {
  it('rejects unknown wire fields, owner changes, malformed initialize and nonmonotonic sequences', async () => {
    for (const value of [
      { v: 1, generation: 'generation', type: 'initialize' },
      { v: 1, generation: 'generation', type: 'close', extra: true },
      { v: 1, generation: 'foreign', type: 'close' },
      {
        v: 1,
        generation: 'generation',
        type: 'result',
        owner: { ...owner, generation: 'foreign' },
        result: {},
      },
    ])
      expect(() => parseFrame(value, 'generation', limits)).toThrow()
    const stdin = new PassThrough(),
      stdout = new PassThrough(),
      frames: unknown[] = [],
      transport = cursorTransport(
        stdin,
        stdout,
        'generation',
        limits,
        (value) => frames.push(value),
      )
    stdout.write(
      '{"v":1,"generation":"generation","type":"ready","requestId":"1","seq":2}\n',
    )
    expect(await transport.done).toBeInstanceOf(Error)
    expect(frames).toHaveLength(0)
  })
  it('bounds diagnostics and redacts a secret split across stderr chunks', () => {
    const tail = new DiagnosticTail(64, ['split-secret'])
    tail.append(Buffer.from('prefix split-'))
    tail.append(Buffer.from('secret suffix'))
    tail.finish()
    expect(tail.text).toBe('prefix [REDACTED] suffix')
  })
  async function runtimePeer(
    scenario = '',
    directory?: string,
    creating = true,
    messageText = 'test',
    overrides = {},
  ) {
    directory ??= await mkdtemp(join(root, 'scenario-'))
    const current = { ...owner, cwd: root },
      reservation = {
        version: 1,
        reservationId: 'scenario-reservation',
        creationOwner: current,
        sdkVersion: '1.0.28',
        storeRelativePath: `sessions/${owner.storeId}/sdk`,
        state: creating ? 'creation-started' : 'native-confirmed',
      }
    const frames: any[] = []
    let wire!: CursorWire
    const launched = await NativeProcess.start(
      { command: process.execPath, args: [peer, owner.generation], cwd: root },
      async (child) => {
        wire = new CursorWire(
          child.child.stdin,
          child.child.stdout,
          owner.generation,
          limits,
          (frame) => frames.push(frame),
        )
        child.ownTransport(wire.transport)
        return wire.request('initialize', {
          selected: {
            ...selected(root),
            accountEnv: { TEST_SCENARIO: scenario },
          },
          owner: current,
          reservation,
          directory,
          creating,
          limits: overrides,
        })
      },
    )
    await wire.request('models')
    const prepare = (agentId?: string, timeout?: number) =>
      wire.request(
        'prepare',
        {
          owner: current,
          reservationId: reservation.reservationId,
          digest: inputDigest({ text: messageText }),
          model: { id: 'test' },
          options: { permissionMode: 'auto' },
          ...(agentId ? { agentId } : {}),
        },
        timeout,
      )
    const submit = () =>
      wire.request('submit', {
        owner: current,
        reservationId: reservation.reservationId,
        message: { text: messageText },
      })
    return {
      wire,
      process: launched.process,
      frames,
      prepare,
      submit,
      directory,
      current,
      reservation,
    }
  }
  it('exhausts cumulative callback and stream counts and bytes through the actual runtime', async () => {
    for (const [scenario, overrides, code] of [
      ['', { generationEvents: 2 }, 'cursor_callback_generation_limit'],
      ['', { generationEventBytes: 50 }, 'cursor_callback_generation_limit'],
      [
        'stream-only',
        { generationEvents: 1 },
        'cursor_stream_generation_limit',
      ],
      [
        'stream-only',
        { generationEventBytes: 50 },
        'cursor_stream_generation_limit',
      ],
    ] as const) {
      const fixture = await runtimePeer(
        scenario,
        undefined,
        true,
        'test',
        overrides,
      )
      try {
        await fixture.prepare()
        const response = await fixture.submit().catch((error) => error)
        if (scenario === '') expect(response).toMatchObject({ code })
        else {
          expect(response.type).toBe('submitted')
          await vi.waitFor(() =>
            expect(
              fixture.frames.some(
                (frame) => frame.type === 'failure' && frame.code === code,
              ),
            ).toBe(true),
          )
        }
        expect(
          fixture.frames.filter((frame) => frame.type === 'result'),
        ).toHaveLength(0)
      } finally {
        await fixture.process.close()
      }
    }
  })
  it('revokes first-submit privilege after cancellation and rejects resumed queued rows', async () => {
    const first = await runtimePeer()
    let agentId: string
    try {
      agentId = String((await first.prepare()).agentId)
      await first.wire.request('cancel')
      await expect(first.submit()).rejects.toThrow('not_prepared')
      expect(first.frames.some((frame) => frame.type === 'result')).toBe(false)
    } finally {
      await first.process.close()
    }
    const resumed = await runtimePeer('', first.directory, false)
    try {
      await expect(resumed.prepare(agentId!)).rejects.toThrow(
        'active_run_ambiguous',
      )
      expect(
        JSON.parse(
          (
            await readFile(join(first.directory, 'agents.ndjson'), 'utf8')
          ).trim(),
        ).agentId,
      ).toBe(agentId!)
    } finally {
      await resumed.process.close()
    }
  })
  it('rejects every changed first-submit owner and reservation without consuming the valid grant', async () => {
    const fixture = await runtimePeer()
    try {
      await fixture.prepare()
      for (const key of Object.keys(fixture.current)) {
        await expect(
          fixture.wire.request('submit', {
            owner: { ...fixture.current, [key]: 'foreign' },
            reservationId: fixture.reservation.reservationId,
            message: { text: 'test' },
          }),
        ).rejects.toThrow()
      }
      await expect(
        fixture.wire.request('submit', {
          owner: fixture.current,
          reservationId: 'foreign',
          message: { text: 'test' },
        }),
      ).rejects.toThrow('reservation_mismatch')
      expect(
        fixture.frames.filter((frame) => frame.type === 'result'),
      ).toHaveLength(0)
      await fixture.submit()
      await vi.waitFor(() =>
        expect(
          fixture.frames.filter((frame) => frame.type === 'result'),
        ).toHaveLength(1),
      )
      await expect(fixture.submit()).rejects.toThrow('not_prepared')
    } finally {
      await fixture.process.close()
    }
  })
  it('rejects unsupported policies before creating an agent through the runtime boundary', async () => {
    const fixture = await runtimePeer()
    try {
      for (const options of [
        {},
        { permissionMode: 'manual' },
        { permissionMode: 'auto', serviceTier: 'priority' },
        { permissionMode: 'auto', approvalPolicy: 'never' },
      ]) {
        await expect(
          fixture.wire.request('prepare', {
            owner: fixture.current,
            reservationId: fixture.reservation.reservationId,
            digest: inputDigest({ text: 'test' }),
            model: { id: 'test' },
            options,
          }),
        ).rejects.toThrow('unsupported_policy')
        expect(
          (await inspectRawStore(fixture.directory, root, limits)).rows.agents,
        ).toHaveLength(0)
      }
      await fixture.prepare()
      expect(
        (await inspectRawStore(fixture.directory, root, limits)).rows.agents,
      ).toHaveLength(1)
    } finally {
      await fixture.process.close()
    }
  })
  it('keeps completion pending through FINISHED stream status and turn-ended until Run.wait settles', async () => {
    const fixture = await runtimePeer('', undefined, true, 'hold')
    try {
      await fixture.prepare()
      await fixture.submit()
      await vi.waitFor(() =>
        expect(
          fixture.frames.some(
            (frame) =>
              frame.type === 'native_record' &&
              JSON.stringify(frame.record).includes('FINISHED'),
          ),
        ).toBe(true),
      )
      expect(fixture.frames.some((frame) => frame.type === 'result')).toBe(
        false,
      )
      expect(
        fixture.frames.filter(
          (frame) =>
            frame.type === 'native_record' && frame.record.kind === 'summary',
        ),
      ).toHaveLength(1)
      await fixture.wire.request('cancel')
      await vi.waitFor(() =>
        expect(
          fixture.frames.filter((frame) => frame.type === 'result'),
        ).toHaveLength(1),
      )
      expect(
        fixture.frames.find((frame) => frame.type === 'result').result.status,
      ).toBe('cancelled')
    } finally {
      await fixture.process.close()
    }
  })
  it('cancels a held create before its late return without publishing prepared identity', async () => {
    const fixture = await runtimePeer('hold-create')
    try {
      const prepared = fixture.prepare()
      void prepared.catch(() => {})
      await vi.waitFor(() =>
        expect(fixture.process.diagnostics).toContain('fixture:create'),
      )
      await fixture.wire.request('cancel')
      fixture.process.child.kill('SIGUSR1')
      await expect(prepared).rejects.toThrow('preparation_cancelled')
      await expect(fixture.submit()).rejects.toThrow('not_prepared')
      expect(fixture.frames.some((frame) => frame.type === 'result')).toBe(
        false,
      )
    } finally {
      fixture.process.child.kill('SIGUSR1')
      await fixture.process.close()
    }
  })
  it('cancels a late returned Run after send was held', async () => {
    const fixture = await runtimePeer('hold-send')
    try {
      await fixture.prepare()
      const submitted = fixture.submit()
      void submitted.catch(() => {})
      await vi.waitFor(() =>
        expect(fixture.process.diagnostics).toContain('fixture:send'),
      )
      expect(fixture.frames.some((frame) => frame.type === 'result')).toBe(
        false,
      )
      await fixture.wire.request('cancel')
      fixture.process.child.kill('SIGUSR1')
      await submitted
      await vi.waitFor(() =>
        expect(
          fixture.frames.filter((frame) => frame.type === 'result'),
        ).toHaveLength(1),
      )
      expect(
        fixture.frames.find((frame) => frame.type === 'result').result.status,
      ).toBe('cancelled')
    } finally {
      fixture.process.child.kill('SIGUSR1')
      await fixture.process.close()
    }
  })
  it('cancels held exact resume without publishing another preparation', async () => {
    const first = await runtimePeer()
    let agentId: string
    try {
      agentId = String((await first.prepare()).agentId)
      await first.submit()
      await vi.waitFor(() =>
        expect(first.frames.some((frame) => frame.type === 'result')).toBe(
          true,
        ),
      )
    } finally {
      await first.process.close()
    }
    const resumed = await runtimePeer('hold-resume', first.directory, false)
    try {
      const prepared = resumed.prepare(agentId!)
      void prepared.catch(() => {})
      await vi.waitFor(() =>
        expect(resumed.process.diagnostics).toContain('fixture:resume'),
      )
      await resumed.wire.request('cancel')
      resumed.process.child.kill('SIGUSR1')
      await expect(prepared).rejects.toThrow('preparation_cancelled')
      await expect(resumed.submit()).rejects.toThrow('not_prepared')
      expect(resumed.frames.some((frame) => frame.type === 'result')).toBe(
        false,
      )
    } finally {
      resumed.process.child.kill('SIGUSR1')
      await resumed.process.close()
    }
  })
  it('retains original rows when a prepared reply is lost', async () => {
    const fixture = await runtimePeer('drop-prepared')
    try {
      await expect(fixture.prepare(undefined, 150)).rejects.toThrow(
        'control_timeout',
      )
      const rows = (
        await readFile(join(fixture.directory, 'agents.ndjson'), 'utf8')
      )
        .trim()
        .split('\n')
      expect(rows).toHaveLength(1)
      await fixture.wire.request('cancel')
      await expect(fixture.submit()).rejects.toThrow('not_prepared')
      expect(fixture.frames.some((frame) => frame.type === 'result')).toBe(
        false,
      )
    } finally {
      await fixture.process.close()
    }
  })
  it('accepts final JSON without newline and rejects malformed final rows and UTF-8', () => {
    expect(parseRawJsonl(Buffer.from('{"agentId":"a"}'), limits)).toHaveLength(
      1,
    )
    for (const bytes of [
      Buffer.from('{"agentId":"a"}\n{"bad":'),
      Buffer.from([255]),
    ])
      expect(() => parseRawJsonl(bytes, limits)).toThrow()
  })
  it('rejects corruption on each store surface before native reads', async () => {
    for (const file of [
      'agents.ndjson',
      'runs.ndjson',
      'run_events.ndjson',
      'checkpoints.ndjson',
    ]) {
      const directory = await mkdtemp(join(root, 'corrupt-'))
      await writeFile(join(directory, file), '{}\n{"broken":')
      await expect(inspectRawStore(directory, '/tmp', limits)).rejects.toThrow()
    }
  })
  it('handles CRLF and EOF frames through the actual JSONL transport', async () => {
    const input = new PassThrough(),
      output = new PassThrough(),
      frames: any[] = []
    const transport = cursorTransport(
      input,
      output,
      'generation',
      limits,
      (frame) => frames.push(frame),
    )
    output.end(
      '{"v":1,"generation":"generation","type":"ready","requestId":"1","seq":1}\r\n{"v":1,"generation":"generation","type":"closed","requestId":"2","seq":2}',
    )
    await transport.done
    expect(frames.map((frame) => frame.type)).toEqual(['ready', 'closed'])
  })
  it('runs first submit and follow-up through Node24, NativeProcess and the real sidecar runtime', async () => {
    const directory = await mkdtemp(join(root, 'sdk-'))
    const sessionOwner = {
      ...owner,
      cwd: root,
      attemptId: 'attempt-0',
      runId: 'run-0',
      turnId: 'turn-0',
    }
    const reservation = {
      version: 1,
      reservationId: 'reservation-test',
      creationOwner: sessionOwner,
      sdkVersion: '1.0.28',
      storeRelativePath: `sessions/${owner.storeId}/sdk`,
      state: 'creation-started',
    }
    const frames: any[] = []
    let wire!: CursorWire
    const launched = await NativeProcess.start(
      { command: process.execPath, args: [peer, owner.generation], cwd: root },
      async (process) => {
        wire = new CursorWire(
          process.child.stdin,
          process.child.stdout,
          owner.generation,
          limits,
          (frame) => frames.push(frame),
        )
        process.ownTransport(wire.transport)
        return wire.request('initialize', {
          selected: selected(root),
          owner: sessionOwner,
          directory,
          creating: true,
          reservation,
        })
      },
    )
    try {
      expect(launched.value.type).toBe('ready')
      await wire.request('models')
      let agentId: unknown
      for (let turn = 0; turn < 2; turn++) {
        const current = {
          ...sessionOwner,
          attemptId: `attempt-${turn}`,
          runId: `run-${turn}`,
          turnId: `turn-${turn}`,
        }
        const message = { text: 'hello' }
        const prepared = await wire.request('prepare', {
          owner: current,
          reservationId: reservation.reservationId,
          digest: inputDigest(message),
          model: { id: 'test' },
          options: { permissionMode: 'auto' },
        })
        agentId ??= prepared.agentId
        expect(prepared.agentId).toBe(agentId)
        await wire.request('submit', {
          owner: current,
          message,
          reservationId: reservation.reservationId,
        })
        await vi.waitFor(() =>
          expect(
            frames.some(
              (frame) =>
                frame.type === 'result' && frame.owner.runId === current.runId,
            ),
          ).toBe(true),
        )
      }
      expect(
        frames.filter(
          (frame) =>
            frame.type === 'native_record' && frame.record.kind === 'summary',
        ),
      ).toHaveLength(2)
      expect(
        JSON.parse(
          (await readFile(join(directory, 'agents.ndjson'), 'utf8')).trim(),
        ).agentId,
      ).toBe(agentId)
    } finally {
      await launched.process.close()
    }
  })
})
