import { describe, expect, it } from 'vitest'
import { harnessEventSchema } from '@forge/protocol/harness'
import { CodexNormalizer } from './normalize.js'
import { CodexBudget, MiB, tupleId } from './wire.js'
import {
  peer,
  turn,
  turnFrame,
  itemFrame,
  notify,
  eventually,
} from './test-helpers.js'

const delta = (method: string, itemId: string, text: string, extra = {}) =>
  notify(method, {
    threadId: 'root',
    turnId: 't1',
    itemId,
    delta: text,
    ...extra,
  })
async function active() {
  const p = await peer([{ method: 'turn/start', result: { turn: turn() } }])
  const h = await p.start()
  const receipt = await h.prompt('input', undefined, {
    runId: 'run',
    turnId: 'forge-turn',
  })
  return { p, h, receipt }
}

describe('Codex authoritative content over native JSONL', () => {
  it.each(['agentMessage', 'plan', 'reasoning'])(
    '43, 77: accepts final-only %s at exactly 4 MiB',
    async (type) => {
      const { p, receipt } = await active()
      const text = 'x'.repeat(4 * MiB)
      await p.send([
        itemFrame(
          type === 'reasoning'
            ? { id: 'exact', type, summary: [text], content: [] }
            : { id: 'exact', type, text },
        ),
        turnFrame('completed'),
      ])
      expect((await receipt.completion).status).toBe('completed')
      expect(
        p.events.find((event) => event.type === 'content_snapshot')!.text,
      ).toHaveLength(4 * MiB)
    },
  )

  it.each([
    {
      type: 'commandExecution',
      command: 'fixture',
      commandActions: [],
      cwd: '/fixture',
    },
    { type: 'fileChange', changes: [] },
    {
      type: 'mcpToolCall',
      server: 'fixture',
      tool: 'fixture',
      status: 'completed',
    },
    { type: 'dynamicToolCall', tool: 'fixture', status: 'completed' },
    { type: 'functionCallOutput', name: 'fixture' },
    { type: 'webSearch' },
    { type: 'imageView' },
    { type: 'imageGeneration', status: 'failed' },
    { type: 'sleep', durationMs: -1 },
    { type: 'enteredReviewMode' },
    { type: 'hookPrompt', fragments: [{}] },
  ])(
    '3, 24: malformed required fields in $type fail before a public tool event',
    async (item) => {
      const { p, receipt } = await active()
      await p.send([itemFrame({ id: 'invalid', ...item })])
      expect((await receipt.completion).status).toBe('failed')
      expect(p.events.some((event) => event.type === 'tool_started')).toBe(
        false,
      )
    },
  )
  it('22, 23, 80, 81: keeps repeated chunks, channels, removed parts, and metadata changes', async () => {
    const { p, receipt } = await active()
    await p.send([
      delta('item/agentMessage/delta', 'message', 'same'),
      delta('item/agentMessage/delta', 'message', 'same'),
      itemFrame({
        id: 'message',
        type: 'agentMessage',
        text: 'corrected',
        phase: 'final_answer',
        delivery: 'async',
        questions: [{ title: 'Choose', options: ['α', 'β'] }],
      }),
      itemFrame({
        id: 'message',
        type: 'agentMessage',
        text: '',
        phase: null,
        delivery: null,
        questions: [],
      }),
      delta('item/reasoning/summaryTextDelta', 'thought', 'first', {
        summaryIndex: 0,
      }),
      delta('item/reasoning/summaryTextDelta', 'thought', 'removed', {
        summaryIndex: 1,
      }),
      delta('item/reasoning/textDelta', 'thought', 'private', {
        contentIndex: 0,
      }),
      itemFrame({
        id: 'thought',
        type: 'reasoning',
        summary: ['final'],
        content: [],
      }),
      itemFrame({ id: 'thought', type: 'reasoning', summary: [], content: [] }),
      turnFrame('completed'),
    ])
    await receipt.completion
    const deltas = p.events.filter((event) => event.type === 'text_delta')
    expect(deltas.map((event) => event.text)).toEqual(['same', 'same'])
    const snapshots = p.events.filter(
      (event) => event.type === 'content_snapshot',
    )
    expect(
      snapshots.filter((event) => event.contentType === 'text'),
    ).toMatchObject([
      {
        text: 'corrected',
        phase: 'final_answer',
        delivery: 'async',
        questions: [{ title: 'Choose' }],
      },
      { text: '', phase: null, delivery: null, questions: [] },
    ])
    const thoughts = snapshots.filter(
      (event) => event.contentType === 'thought',
    )
    expect(thoughts.map((event) => event.text)).toEqual(['final', '', '', ''])
    expect(new Set(thoughts.map((event) => event.itemId)).size).toBe(3)
    p.events.forEach((event) => harnessEventSchema.parse(event))
  })

  it('23, 82, 83: full turns use the same item identity; unloaded turns clear nothing', async () => {
    const { p, receipt } = await active()
    const item = {
      id: 'final',
      type: 'agentMessage',
      text: 'only final',
      phase: 'final_answer',
    }
    await p.send([
      itemFrame(item),
      notify('turn/started', {
        threadId: 'root',
        turn: turn('t1', 'inProgress', [], 'summary'),
      }),
      turnFrame('completed', 't1', 'completed', 'root', [item]),
    ])
    await receipt.completion
    const snapshots = p.events.filter(
      (event) => event.type === 'content_snapshot',
    )
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]!.text).toBe('only final')
  })

  it('C4: final corrections preserve effective metadata and distinct reasoning part identities', async () => {
    const { p, receipt } = await active()
    const item = {
      id: 'corrected',
      type: 'agentMessage',
      text: 'first',
      phase: 'final_answer',
      delivery: 'async',
      questions: [{ title: 'Choose', options: [] }],
    }
    await p.send([
      itemFrame(item),
      itemFrame({ id: item.id, type: item.type, text: item.text }),
      itemFrame({ id: item.id, type: item.type, text: 'changed' }),
      itemFrame({ ...item, text: 'changed' }),
      itemFrame({
        ...item,
        text: 'changed',
        phase: null,
        delivery: null,
        questions: null,
      }),
      itemFrame({
        ...item,
        text: 'changed',
        phase: null,
        delivery: null,
        questions: [],
      }),
      itemFrame({ id: item.id, type: item.type, text: '' }),
      itemFrame({
        id: 'thought',
        type: 'reasoning',
        summary: ['same', 'same'],
        content: ['same'],
      }),
      itemFrame({
        id: 'thought',
        type: 'reasoning',
        summary: ['same', 'same'],
        content: ['same'],
      }),
      itemFrame({
        id: 'thought',
        type: 'reasoning',
        summary: ['same', 'new'],
        content: ['same'],
      }),
      turnFrame('completed'),
    ])
    expect((await receipt.completion).status).toBe('completed')
    const text = p.events.filter(
      (event) =>
        event.type === 'content_snapshot' && event.contentType === 'text',
    )
    expect(text).toHaveLength(5)
    expect(text).toMatchObject([
      { text: 'first', phase: 'final_answer' },
      { text: 'changed' },
      { questions: null, phase: null },
      { questions: [] },
      { text: '' },
    ])
    expect(text[1]).not.toHaveProperty('phase')
    const thoughts = p.events
      .filter((event) => event.type === 'content_snapshot')
      .filter((event) => event.contentType === 'thought')
    expect(thoughts).toHaveLength(4)
    expect(new Set(thoughts.map((event) => event.itemId)).size).toBe(3)
    expect(thoughts[1]!.itemId).toBe(thoughts[3]!.itemId)
  })

  it.each(['agentMessage', 'plan', 'reasoning'])(
    '77: rejects %s above the public 4 MiB ceiling before emission',
    async (type) => {
      const { p, receipt } = await active()
      const text = 'x'.repeat(4 * MiB + 1)
      await p.send([
        itemFrame(
          type === 'reasoning'
            ? { id: 'large', type, summary: [text] }
            : { id: 'large', type, text },
        ),
      ])
      expect((await receipt.completion).status).toBe('failed')
      expect(p.events.some((event) => event.type === 'content_snapshot')).toBe(
        false,
      )
    },
  )

  it('78, 79: plan partial snapshots stay inside the byte budget and final content replaces them', async () => {
    const { p, receipt } = await active()
    for (let chunk = 0; chunk < 16; chunk++) {
      await p.send(
        Array.from({ length: 64 }, () =>
          delta('item/plan/delta', 'plan', 'x'.repeat(4096)),
        ),
      )
      await eventually(
        () =>
          p.events.filter((event) => event.type === 'content_snapshot').length >
          0,
      )
    }
    await p.send([
      itemFrame({ type: 'plan', id: 'plan', text: 'changed final' }),
      itemFrame({ type: 'plan', id: 'empty', text: '' }),
      turnFrame('completed'),
    ])
    await receipt.completion
    const snapshots = p.events
      .filter((event) => event.type === 'content_snapshot')
      .filter((event) => event.contentType === 'plan')
    const partial = snapshots.slice(0, -2)
    expect(partial.length).toBeLessThanOrEqual(13)
    expect(
      partial.reduce((sum, event) => sum + Buffer.byteLength(event.text), 0),
    ).toBeLessThanOrEqual(8 * MiB)
    expect(snapshots.slice(-2).map((event) => event.text)).toEqual([
      'changed final',
      '',
    ])
  })

  it('24: command aggregates, stdin, file kinds, and MCP results retain provider detail', async () => {
    const { p, receipt } = await active()
    const command = {
      id: 'cmd',
      type: 'commandExecution',
      command: 'echo fixture',
      cwd: p.root,
      commandActions: [],
      status: 'inProgress',
      processId: 'process',
    }
    const changes = ['add', 'delete', 'update'].map((type) => ({
      path: `${p.root}/${type}`,
      kind: {
        type,
        ...(type === 'update' ? { move_path: `${p.root}/moved` } : {}),
      },
      diff: 'native diff',
    }))
    await p.send([
      notify('item/started', { threadId: 'root', turnId: 't1', item: command }),
      delta('item/commandExecution/outputDelta', 'cmd', 'partial'),
      notify('item/commandExecution/terminalInteraction', {
        threadId: 'root',
        turnId: 't1',
        itemId: 'cmd',
        processId: 'process',
        stdin: 'q',
      }),
      itemFrame({
        ...command,
        status: 'completed',
        aggregatedOutput: 'final output',
        exitCode: 0,
        durationMs: 12,
      }),
      itemFrame({
        id: 'files',
        type: 'fileChange',
        changes,
        status: 'completed',
      }),
      itemFrame({
        id: 'mcp',
        type: 'mcpToolCall',
        server: 'fixture',
        tool: 'lookup',
        arguments: {},
        status: 'completed',
        result: {
          content: [{ type: 'text', text: 'result' }],
          structuredContent: { ok: true },
        },
      }),
      itemFrame({
        id: 'image',
        type: 'imageGeneration',
        status: 'failed',
        result: '',
        failure: { message: 'fixture failure' },
      }),
      turnFrame('completed'),
    ])
    await receipt.completion
    expect(
      p.events
        .filter((event) => event.type === 'file_change')
        .map((event) => event.kind),
    ).toEqual(['created', 'deleted', 'modified'])
    const tools = p.events.filter((event) => event.type === 'tool_update')
    expect(
      tools.find((event) => event.providerItemId === 'files')!.output,
    ).toMatchObject({ changes })
    expect(
      tools.filter((event) => event.providerItemId === 'cmd').at(-1)!.output,
    ).toMatchObject({
      aggregatedOutput: 'final output',
      exitCode: 0,
      durationMs: 12,
    })
    expect(
      tools.find((event) => event.providerItemId === 'image')!.output,
    ).toMatchObject({
      status: 'failed',
      failure: { message: 'fixture failure' },
    })
  })

  it('34, 92: diagnostic and global usage frames do not settle the root', async () => {
    const { p, receipt } = await active()
    await p.send([
      notify('account/rateLimits/updated', {
        rateLimits: { limitId: 'codex', primary: null },
      }),
      notify('error', {
        threadId: 'root',
        turnId: 't1',
        willRetry: true,
        error: {
          message: 'Retry',
          codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } },
          additionalDetails: null,
        },
      }),
      notify('thread/tokenUsage/updated', {
        threadId: 'root',
        turnId: 't1',
        tokenUsage: {
          last: {
            inputTokens: 10,
            outputTokens: 2,
            totalTokens: 12,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            reasoningOutputTokens: 1,
          },
          total: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
          modelContextWindow: null,
        },
      }),
    ])
    await eventually(() => p.events.some((event) => event.type === 'usage'))
    expect(p.events.some((event) => event.type === 'turn_completed')).toBe(
      false,
    )
    expect(p.events.find((event) => event.type === 'diagnostic')).toMatchObject(
      { retryable: true, httpStatus: 503, details: null },
    )
    await p.send([turnFrame('completed')])
    expect((await receipt.completion).status).toBe('completed')
  })
})

describe('Codex retained content admission', () => {
  it('C3: command partial output grows linearly and preserves corrected and empty final aggregates', () => {
    const outputs: unknown[] = []
    const budget = new CodexBudget()
    const mapper = new CodexNormalizer(
      'generation',
      (event) => {
        if (event.type === 'tool_update') outputs.push(event.output)
      },
      budget,
    )
    const owner = {
      runId: 'run',
      turnId: 'turn',
      nativeThreadId: 'root',
      nativeTurnId: 'native',
    }
    for (let i = 0; i < 128; i++)
      mapper.notification(owner, 'item/commandExecution/outputDelta', {
        itemId: 'tool',
        delta: 'x'.repeat(4096),
      })
    const partialBytes = outputs.reduce<number>(
      (total, value) => total + Buffer.byteLength(JSON.stringify(value)),
      0,
    )
    expect(partialBytes).toBeLessThan(2 * 128 * 4096)
    expect(outputs).toHaveLength(8)
    const final = {
      id: 'tool',
      type: 'commandExecution',
      command: 'fixture',
      commandActions: [],
      cwd: '/fixture',
      status: 'completed',
      aggregatedOutput: 'authoritative',
      exitCode: 0,
      durationMs: 42,
    }
    mapper.item(owner, final, true)
    mapper.item(owner, final, true)
    mapper.item(owner, { ...final, aggregatedOutput: '' }, true)
    expect(outputs.slice(-2)).toEqual([
      final,
      { ...final, aggregatedOutput: '' },
    ])
    expect(outputs).toHaveLength(10)
    mapper.close()
    expect(budget.bytes).toBe(0)
  })

  it('C3: exact 8 MiB tool payloads fit a 32 MiB publication ceiling and changed overflow emits nothing', () => {
    const outputs: unknown[] = []
    const mapper = new CodexNormalizer(
      'generation',
      (event) => {
        if (event.type === 'tool_update') outputs.push(event.output)
      },
      new CodexBudget(),
    )
    const owner = {
      runId: 'run',
      turnId: 'turn',
      nativeThreadId: 'root',
      nativeTurnId: 'native',
    }
    const item = {
      id: 'tool',
      type: 'commandExecution',
      command: 'fixture',
      commandActions: [],
      cwd: '/fixture',
      status: 'completed',
      aggregatedOutput: '',
      exitCode: 0,
    }
    item.aggregatedOutput = 'x'.repeat(
      8 * MiB - Buffer.byteLength(JSON.stringify(item)),
    )
    expect(Buffer.byteLength(JSON.stringify(item))).toBe(8 * MiB)
    for (let i = 0; i < 3; i++) {
      const correction = { ...item, exitCode: i }
      mapper.item(owner, correction, true)
      mapper.item(owner, correction, true)
    }
    expect(outputs).toHaveLength(3)
    expect(() => mapper.item(owner, { ...item, exitCode: 3 }, true)).toThrow(
      'CODEX_TOOL_PUBLICATION_LIMIT',
    )
    expect(outputs).toHaveLength(3)
    expect(() =>
      mapper.item(
        owner,
        { ...item, id: 'large', aggregatedOutput: item.aggregatedOutput + 'x' },
        true,
      ),
    ).toThrow('CODEX_TOOL_LIMIT')
    expect(outputs).toHaveLength(3)
    mapper.close()
  })

  it('C4: finalized digests remain charged after payload release and reject metadata capacity before publication', () => {
    const budget = new CodexBudget(1024)
    const events: unknown[] = []
    const mapper = new CodexNormalizer(
      'generation',
      (event) => events.push(event),
      budget,
    )
    const owner = {
      runId: 'run',
      turnId: 'turn',
      nativeThreadId: 'root',
      nativeTurnId: 'native',
    }
    const item = { id: 'text', type: 'agentMessage', text: 'x'.repeat(MiB) }
    mapper.item(owner, item, true)
    const charged = budget.bytes
    expect(charged).toBeGreaterThan(512)
    mapper.item(owner, item, true)
    expect(budget.bytes).toBe(charged)
    expect(events).toHaveLength(1)
    expect(mapper.state.liveBytes).toBe(0)
    const release = budget.charge('test-reserve', 1024 - charged - 128, 1, 1024)
    expect(() =>
      mapper.item(
        owner,
        { ...item, phase: 'final_answer', delivery: 'async', questions: [] },
        true,
      ),
    ).toThrow('CODEX_ITEMS_LIMIT')
    expect(events).toHaveLength(1)
    expect(budget.bytes).toBe(1024)
    release()
    mapper.close()
    expect(budget.bytes).toBe(0)
  })

  it('72, 73, 76: counts empty streams, rejects unsafe indexes, and releases finalized buffers', () => {
    const budget = new CodexBudget()
    const mapper = new CodexNormalizer('generation', () => {}, budget)
    const owner = {
      runId: 'run',
      turnId: 'turn',
      nativeThreadId: 'root',
      nativeTurnId: 'native',
    }
    mapper.notification(owner, 'item/agentMessage/delta', {
      itemId: 'text',
      delta: '',
    })
    expect(mapper.state.streams).toBe(1)
    mapper.item(owner, { id: 'text', type: 'agentMessage', text: '' }, true)
    expect(mapper.state).toEqual({ items: 1, streams: 0, liveBytes: 0 })
    expect(() =>
      mapper.notification(owner, 'item/reasoning/textDelta', {
        itemId: 'thought',
        contentIndex: 128,
        delta: '',
      }),
    ).toThrow()
    expect(tupleId('a:b', 'c')).not.toBe(tupleId('a', 'b:c'))
    mapper.close()
    expect(budget.bytes).toBe(0)
  })

  it('79: single-byte plan deltas coalesce at powers of two', () => {
    const emitted: number[] = []
    const mapper = new CodexNormalizer(
      'generation',
      (event) => {
        if (event.type === 'content_snapshot') emitted.push(event.text.length)
      },
      new CodexBudget(),
    )
    const owner = {
      runId: 'run',
      turnId: 'turn',
      nativeThreadId: 'root',
      nativeTurnId: 'native',
    }
    for (let i = 0; i < 4096; i++)
      mapper.notification(owner, 'item/plan/delta', {
        itemId: 'plan',
        delta: 'x',
      })
    mapper.item(owner, { id: 'plan', type: 'plan', text: '' }, true)
    expect(emitted).toEqual([1024, 2048, 4096, 0])
    mapper.close()
  })
})
