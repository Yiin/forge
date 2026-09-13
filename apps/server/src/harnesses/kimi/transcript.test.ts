import { afterEach, describe, expect, test } from 'vitest'
import { KimiHostOwner } from './host.js'
import { KimiBudget, type KimiLimits } from './limits.js'
import { KimiRecords } from './records.js'
import { KimiTranscript } from './transcript.js'
import type { KimiNativeRecord } from './types.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})
function fixture(limits: Partial<KimiLimits> = {}) {
  const host = new KimiHostOwner({ limits }),
    budget = new KimiBudget(host.budget.limits)
  const rows: KimiNativeRecord[] = []
  const records = new KimiRecords(
    {
      sessionId: 'correction',
      runtimeGeneration: 'generation',
      binding: {
        provider: 'kimi',
        accountId: 'account',
        cwd: '/inert',
        providerSessionId: 'native',
      },
    },
    budget,
    host,
    async (input) => {
      rows.push(...input.records)
      return { ordinal: input.expectedOrdinal + 1, disposition: 'committed' }
    },
    () => {},
    new AbortController().signal,
  )
  const transcript = new KimiTranscript(records, async () => {})
  const sequences = new Map<string, number>()
  const apply = (agent: string, ops: unknown[]) => {
    const seq = (sequences.get(agent) ?? 0) + 1
    sequences.set(agent, seq)
    return transcript.apply({
      type: 'transcript.ops',
      session_id: 'native',
      seq,
      epoch: 'epoch',
      payload: { agent_id: agent, seq, ops },
    })
  }
  const visible = () => {
    const snapshot = rows
      .filter((row) => row.kind === 'projection.snapshot')
      .at(-1)?.payload as { visibleItemIds: string[] } | undefined
    return (snapshot?.visibleItemIds ?? []).map((id) =>
      rows.find((row) => row.recordId === id)!,
    )
  }
  cleanup.push(async () => {
    await records.drain()
    transcript.close()
    records.close()
    await host.close()
  })
  return { apply, visible, rows, transcript, records }
}
const snapshot = (seq: number, text = 'a') => ({
  agent_id: 'main',
  seq,
  has_more: false,
  items: [
    {
      kind: 'turn',
      turnId: 't1',
      ordinal: 1,
      state: 'running',
      origin: { kind: 'user' },
      steps: [
        {
          stepId: 't1.1',
          ordinal: 1,
          state: 'running',
          frames: [{ kind: 'text', frameId: 'frame', role: 'assistant', text }],
        },
      ],
    },
  ],
  tasks: [],
  interactions: [],
  attachments: [],
  todos: [],
  prompts: [],
  meta: {},
})
const frame = (id: string, text: string) => ({
  op: 'frame.upsert',
  turnId: 't1',
  stepId: 't1.1',
  frame: { kind: 'text', frameId: id, role: 'assistant', text },
})

describe('Kimi source-shaped entity identity and append semantics', () => {
  test('bounded nonempty transforms remove complete valid turn and step dependencies at retained turn capacity', async () => {
    const f = fixture({ retainedTurns: 32 })
    const items = Array.from({ length: 32 }, (_, index) => ({
      kind: 'turn',
      turnId: `t${index}`,
      ordinal: index + 1,
      state: 'completed',
      origin: { kind: 'user' },
      steps: [
        {
          stepId: `t${index}.1`,
          ordinal: 1,
          state: 'completed',
          frames: [
            {
              kind: 'text',
              frameId: `frame-${index}`,
              role: 'assistant',
              text: `text-${index}`,
            },
          ],
        },
      ],
    }))
    await f.transcript.baseline(
      'main',
      { ...snapshot(1), items },
      'bounded-store',
    )
    expect(f.visible()).toHaveLength(96)
    await expect(
      f.transcript.apply({
        type: 'transcript.ops',
        session_id: 'native',
        seq: 2,
        epoch: 'epoch',
        payload: {
          agent_id: 'main',
          seq: 2,
          ops: [
            {
              op: 'turn.upsert',
              turn: {
                kind: 'turn',
                turnId: 't32',
                ordinal: 33,
                state: 'running',
                origin: { kind: 'user' },
              },
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: 'kimi_retained_turns_limit' })
    expect(f.visible()).toHaveLength(96)
    await f.transcript.apply({
      type: 'transcript.ops',
      session_id: 'native',
      seq: 2,
      epoch: 'epoch',
      payload: {
        agent_id: 'main',
        seq: 2,
        ops: [{ op: 'items.remove', ids: items.map((item) => item.turnId) }],
      },
    })
    expect(f.visible()).toEqual([])
  })
  test('materializes a nonempty baseline before append and binds the accepted store incarnation', async () => {
    const f = fixture()
    await f.transcript.baseline('main', snapshot(10), 'store-first')
    await f.transcript.apply({
      type: 'transcript.ops',
      session_id: 'native',
      seq: 42,
      epoch: 'persistent',
      payload: {
        agent_id: 'main',
        seq: 11,
        ops: [
          {
            op: 'append',
            target: {
              type: 'frame',
              frameId: 'frame',
              turnId: 't1',
              stepId: 't1.1',
            },
            offset: 1,
            text: 'b',
          },
        ],
      },
    })
    expect(
      f
        .visible()
        .map(
          (row) => (row.payload as { native: { text?: string } }).native.text,
        )
        .filter(Boolean),
    ).toEqual(['ab'])
    expect(f.records.checkpoint.transcriptStores?.main).toBe('store-first')
    await f.transcript.baseline('main', snapshot(1, 'new'), 'store-second')
    expect(f.records.checkpoint.transcripts.main).toBe(1)
    expect(f.records.checkpoint.transcriptStores?.main).toBe('store-second')
    expect(
      f
        .visible()
        .map(
          (row) => (row.payload as { native: { text?: string } }).native.text,
        )
        .filter(Boolean),
    ).toEqual(['new'])
  })
  test('a nonempty reset installs its target frame before a same-batch append', async () => {
    const f = fixture()
    await f.apply('main', [
      { op: 'reset', snapshot: snapshot(1) },
      {
        op: 'append',
        target: { type: 'frame', frameId: 'frame' },
        offset: 1,
        text: 'b',
      },
    ])
    expect(
      f
        .visible()
        .map(
          (row) => (row.payload as { native: { text?: string } }).native.text,
        )
        .filter(Boolean),
    ).toEqual(['ab'])
  })
  test('rejects conflicting duplicate inner sequences and refuses an evicted duplicate without an identity proof', async () => {
    const f = fixture({ duplicateEntries: 3 })
    const payload = { agent_id: 'main', seq: 1, ops: [frame('frame', 'a')] },
      raw = {
        type: 'transcript.ops',
        session_id: 'native',
        seq: 2,
        epoch: 'persistent',
        payload,
      }
    await f.transcript.apply(raw)
    await f.transcript.apply({ ...raw, seq: 3 })
    await expect(
      f.transcript.apply({
        ...raw,
        seq: 4,
        payload: { ...payload, ops: [frame('frame', 'changed')] },
      }),
    ).rejects.toMatchObject({ code: 'kimi_transcript_duplicate_conflict' })
    for (let seq = 2; seq < 6; seq++)
      await f.transcript.apply({
        ...raw,
        seq: seq + 10,
        payload: { ...payload, seq, ops: [frame('frame', String(seq))] },
      })
    await expect(f.transcript.apply(raw)).rejects.toMatchObject({
      code: 'kimi_transcript_duplicate_unproved',
    })
  })
  test('a task append creates the native default task skeleton', async () => {
    const f = fixture()
    await f.apply('main', [
      {
        op: 'append',
        target: { type: 'task', taskId: 'shell' },
        offset: 0,
        text: 'output',
      },
    ])
    expect((f.visible()[0].payload as { native: unknown }).native).toEqual({
      taskId: 'shell',
      kind: 'other',
      state: 'running',
      detached: false,
      outputTail: 'output',
    })
  })
  test('cold display IDs cannot borrow a current live text owner', async () => {
    const f = fixture(),
      root = {
        runId: 'owned',
        turnId: 'owned-engine-1',
        operationId: 'operation',
      }
    f.transcript.step('main', 't1', 't1.1', root)
    await f.apply('main', [
      frame('t1.1.f1', 'historical engine 0 steering answer'),
    ])
    expect(
      f.rows
        .filter((row) => row.kind === 'projection.item')
        .every(
          (row) =>
            row.root === undefined &&
            row.sourceIdentity.domain === 'cold-import',
        ),
    ).toBe(true)
    await f.transcript.engineDelta(
      {
        type: 'assistant.delta',
        session_id: 'native',
        seq: 3,
        epoch: 'persistent',
        payload: { agentId: 'main', turnId: 1, delta: 'owned answer' },
      },
      root,
    )
    expect(
      f.rows.filter((row) => row.root).map((row) => row.root?.turnId),
    ).toEqual(['owned-engine-1'])
  })
  test('child turn removal preserves the same display IDs in main and another child', async () => {
    const f = fixture()
    for (const agent of ['main', 'child-a', 'child-b'])
      await f.apply(agent, [frame('t1.1.f1', agent)])
    await f.apply('child-a', [{ op: 'items.remove', ids: ['t1'] }])
    expect(
      f
        .visible()
        .map((row) => row.agentId)
        .sort(),
    ).toEqual(['child-b', 'main'])
  })
  test('native task references use refId through replacement and removal', async () => {
    const f = fixture()
    const item = {
      kind: 'task_ref',
      refId: 'shell-ref',
      taskId: 'shell',
      beforeTurn: 2,
    }
    await f.apply('main', [{ op: 'taskref.upsert', item }])
    await f.apply('main', [
      { op: 'taskref.upsert', item: { ...item, label: 'Updated' } },
    ])
    expect(f.visible()).toHaveLength(1)
    await f.apply('main', [{ op: 'items.remove', ids: ['shell-ref'] }])
    expect(f.visible()).toEqual([])
  })
  test.each(['text', 'thinking', 'task'] as const)(
    'appends %s output with exact native overlap checks',
    async (kind) => {
      const f = fixture()
      const target =
        kind === 'task'
          ? { type: 'task', taskId: 'shell' }
          : { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 'frame' }
      await f.apply('main', [
        kind === 'task'
          ? {
              op: 'task.upsert',
              task: {
                taskId: 'shell',
                kind: 'shell',
                state: 'running',
                detached: false,
                outputTail: 'a',
              },
            }
          : {
              ...frame('frame', 'a'),
              frame: { kind, frameId: 'frame', text: 'a' },
            },
      ])
      await f.apply('main', [{ op: 'append', target, offset: 1, text: 'bc' }])
      await f.apply('main', [{ op: 'append', target, offset: 2, text: 'cd' }])
      const native = (
        f.visible()[0].payload as { native: Record<string, unknown> }
      ).native
      expect(native[kind === 'task' ? 'outputTail' : 'text']).toBe('abcd')
      await expect(
        f.apply('main', [{ op: 'append', target, offset: 2, text: 'wrong' }]),
      ).rejects.toMatchObject({ code: 'kimi_append_offset' })
    },
  )
  test('tool input and output each admit their independent value allowance', async () => {
    const f = fixture({ toolValueBytes: 64 })
    const tool = {
      kind: 'tool',
      frameId: 'tool',
      toolCallId: 'call',
      name: 'Read',
      state: 'done',
      input: 'i'.repeat(64),
      output: 'o'.repeat(64),
      display: 'd'.repeat(64),
    }
    await f.apply('main', [
      { op: 'frame.upsert', turnId: 't1', stepId: 't1.1', frame: tool },
    ])
    expect(f.visible()).toHaveLength(1)
    await expect(
      f.apply('main', [
        {
          op: 'frame.upsert',
          turnId: 't1',
          stepId: 't1.1',
          frame: { ...tool, output: 'o'.repeat(65) },
        },
      ]),
    ).rejects.toThrow()
  })
})
