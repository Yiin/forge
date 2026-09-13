import { afterEach, describe, expect, it } from 'vitest'
import { decodeEntry, decodeMessage } from './normalize.js'
import { MiB } from './wire.js'
import { foldTimeline } from '@forge/protocol/timeline'
import {
  fixture,
  assistant,
  png,
  usage,
  waitPhysicalIdle,
} from './fixtures/test-support.js'

const owned: Array<Awaited<ReturnType<typeof fixture>>> = []
afterEach(async () => {
  for (const f of owned.splice(0)) await f.close()
  await waitPhysicalIdle()
})
async function active() {
  const f = await fixture({ behavior: 'manual' })
  owned.push(f)
  const { handle } = await f.start()
  const receipt = handle.prompt('root')
  await receipt.acceptance
  await f.control({ events: [{ type: 'agent_start' }] })
  await f.wait(
    () => f.events.some((event) => event.type === 'run_started') || false,
  )
  return { f, handle, receipt }
}
describe('Pi native message decoder', () => {
  it('E8, 37: initial empty blocks, thought changes, and explicit clearing remain visible', async () => {
    const { f, receipt } = await active()
    await f.control({
      events: [
        { type: 'message_start', message: assistant([], 'pending') },
        {
          type: 'message_update',
          assistantMessageEvent: {
            type: 'text_end',
            contentIndex: 0,
            content: '',
          },
        },
        {
          type: 'message_update',
          assistantMessageEvent: {
            type: 'thinking_end',
            contentIndex: 1,
            content: 'Thought',
          },
        },
        {
          type: 'message_update',
          assistantMessageEvent: {
            type: 'thinking_end',
            contentIndex: 1,
            content: 'Short',
          },
        },
        {
          type: 'message_update',
          assistantMessageEvent: {
            type: 'thinking_end',
            contentIndex: 1,
            content: 'Short',
          },
        },
      ],
    })
    await f.settle('stop', [
      { type: 'text', text: '' },
      { type: 'thinking', thinking: '' },
    ])
    expect(await receipt.completion).toMatchObject({ status: 'completed' })
    const snapshots = f.events.filter((e) => e.type === 'content_snapshot')
    expect(snapshots.map((e) => e.text)).toEqual(['', 'Thought', 'Short', ''])
    expect(snapshots[1]?.itemId).toBe(snapshots[3]?.itemId)
    expect(snapshots[0]?.contentType).toBe('text')
    expect(snapshots[3]?.contentType).toBe('thought')
  })
  it('R1, 39, 49: overlapping secrets redact live diagnostics, progress, and history', async () => {
    const f = await fixture({ behavior: 'manual' })
    owned.push(f)
    const shorter = 'fixture-private',
      longer = shorter + '-suffix'
    const env = { FORGE_PI_SHORT: shorter, FORGE_PI_LONG: longer }
    const message = {
      ...assistant(),
      errorMessage: longer,
      rawStopReason: longer,
      diagnostics: [
        {
          type: 'fixture',
          timestamp: 1,
          error: { message: longer, stack: longer },
          details: { nested: [longer] },
        },
      ],
    }
    const decoded = decodeEntry(
      {
        type: 'message',
        id: 'history',
        parentId: null,
        timestamp: new Date(0).toISOString(),
        message,
      },
      [shorter, longer],
    )
    expect(JSON.stringify(decoded).includes('-suffix')).toBe(false)
    expect(JSON.stringify(decoded).includes(shorter)).toBe(false)
    const { handle } = await f.start({
      env,
      launch: { ...f.options.launch, selectedEnvOverrides: env },
    })
    const receipt = handle.prompt('Diagnostics')
    await receipt.acceptance
    await f.control({
      state: { isStreaming: false },
      events: [
        { type: 'agent_start' },
        {
          type: 'extension_error',
          extensionPath: 'fixture',
          event: 'input',
          error: longer,
        },
        { type: 'message_end', message },
        { type: 'agent_end', messages: [message], willRetry: false },
        { type: 'agent_settled' },
      ],
    })
    expect(await receipt.completion).toMatchObject({
      status: 'failed',
      code: 'PI_EXTENSION_ERROR',
    })
    expect(f.records.some((r) => r.body.type === 'message')).toBe(true)
    expect(f.records.some((r) => r.body.type === 'custom')).toBe(true)
    expect(JSON.stringify(f.records).includes('-suffix')).toBe(false)
    expect(JSON.stringify(f.records).includes(shorter)).toBe(false)
  })
  it('E8, 37, 50: unchanged native snapshots consume one publication and preserve timeline identities', async () => {
    const f = await fixture({ behavior: 'manual' })
    owned.push(f)
    const { handle } = await f.start({
      limits: { operationPublicationBytes: 4096 },
    })
    const receipt = handle.prompt('Snapshots')
    await receipt.acceptance
    await f.control({
      events: [
        { type: 'agent_start' },
        { type: 'message_start', message: assistant([], 'pending') },
        ...Array.from({ length: 12 }, () => ({
          type: 'message_update',
          assistantMessageEvent: {
            type: 'text_end',
            contentIndex: 0,
            content: 'same',
          },
        })),
      ],
    })
    await f.settle('stop', [{ type: 'text', text: 'same' }])
    expect(await receipt.completion).toMatchObject({ status: 'completed' })
    const snapshots = f.events.filter((e) => e.type === 'content_snapshot')
    expect(snapshots).toHaveLength(1)
    const timeline = foldTimeline(
      f.events.map((event, index) => ({
        kind: 'delta',
        cursor: index + 1,
        event,
      })),
    )
    expect(timeline.events).toEqual(f.events)
    expect(timeline.terminal).toBe('completed')
  })
  it('38, 39: native tool image events above one MiB reach their committed tool result', async () => {
    const { f, receipt } = await active()
    const data = Buffer.alloc(1100 * 1024)
    png.copy(data)
    const result = {
      content: [
        { type: 'image', mimeType: 'image/png', data: data.toString('base64') },
      ],
    }
    expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(MiB)
    await f.control({
      events: [
        {
          type: 'tool_execution_start',
          toolCallId: 'image-tool',
          toolName: 'image',
          args: {},
        },
        {
          type: 'tool_execution_update',
          toolCallId: 'image-tool',
          toolName: 'image',
          args: {},
          partialResult: result,
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'image-tool',
          toolName: 'image',
          result,
          isError: false,
        },
        {
          type: 'message_end',
          message: {
            role: 'toolResult',
            toolCallId: 'image-tool',
            toolName: 'image',
            ...result,
            isError: false,
            timestamp: 1,
          },
        },
      ],
    })
    await f.settle()
    expect(await receipt.completion).toMatchObject({ status: 'completed' })
    expect(f.images).toHaveLength(1)
    expect(JSON.stringify(f.records)).not.toContain(data.toString('base64'))
    expect(JSON.stringify(f.records)).toContain('attachmentId')
  })
  it('37: final-only, shorter, empty and removed text blocks retain their item identities', async () => {
    const { f, receipt } = await active()
    await f.control({
      events: [
        { type: 'message_start', message: assistant([], 'pending') },
        {
          type: 'message_update',
          assistantMessageEvent: {
            type: 'text_delta',
            contentIndex: 0,
            delta: 'long partial',
          },
        },
        {
          type: 'message_update',
          assistantMessageEvent: {
            type: 'thinking_delta',
            contentIndex: 1,
            delta: 'private thought',
          },
        },
        {
          type: 'message_update',
          assistantMessageEvent: {
            type: 'text_delta',
            contentIndex: 2,
            delta: 'removed',
          },
        },
      ],
    })
    await f.settle('stop', [
      { type: 'text', text: 'short' },
      { type: 'thinking', thinking: '', thinkingSignature: 'opaque' },
    ])
    expect(await receipt.completion).toMatchObject({ status: 'completed' })
    const snapshots = f.events.filter(
      (event) => event.type === 'content_snapshot',
    )
    expect(snapshots.map((event) => event.text)).toEqual(['short', '', ''])
    const delta = f.events.find((event) => event.type === 'text_delta')
    expect(snapshots[0]?.itemId).toBe(
      delta && 'itemId' in delta ? delta.itemId : undefined,
    )
    expect(
      f.events.some((event) => 'text' in event && event.text === 'opaque'),
    ).toBe(false)
  })
  it('38, 40: tool fragments, cumulative output and final copies use one real tool identity', async () => {
    const { f, receipt } = await active()
    const result = {
      content: [{ type: 'text', text: 'final output' }],
      details: { safe: true },
    }
    await f.control({
      events: [
        { type: 'message_start', message: assistant([], 'pending') },
        {
          type: 'message_update',
          assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0 },
        },
        {
          type: 'message_update',
          assistantMessageEvent: {
            type: 'toolcall_delta',
            contentIndex: 0,
            delta: '{"task":',
          },
        },
        {
          type: 'message_update',
          assistantMessageEvent: {
            type: 'toolcall_end',
            contentIndex: 0,
            toolCall: {
              type: 'toolCall',
              id: 'native-tool',
              name: 'subagent',
              arguments: { task: 'inspect' },
            },
          },
        },
        {
          type: 'message_end',
          message: assistant(
            [
              {
                type: 'toolCall',
                id: 'native-tool',
                name: 'subagent',
                arguments: { task: 'inspect' },
              },
            ],
            'toolUse',
          ),
        },
        {
          type: 'tool_execution_start',
          toolCallId: 'native-tool',
          toolName: 'subagent',
          args: { task: 'inspect' },
        },
        {
          type: 'tool_execution_update',
          toolCallId: 'native-tool',
          toolName: 'subagent',
          args: {},
          partialResult: { content: [{ type: 'text', text: 'first' }] },
        },
        {
          type: 'tool_execution_update',
          toolCallId: 'native-tool',
          toolName: 'subagent',
          args: {},
          partialResult: { content: [{ type: 'text', text: 'replacement' }] },
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'native-tool',
          toolName: 'subagent',
          result,
          isError: true,
        },
        {
          type: 'message_end',
          message: {
            role: 'toolResult',
            toolCallId: 'native-tool',
            toolName: 'subagent',
            ...result,
            isError: true,
            timestamp: 1,
          },
        },
      ],
    })
    await f.settle()
    expect(await receipt.completion).toMatchObject({ status: 'completed' })
    const tools = f.events.filter((event) => event.type === 'tool_update')
    expect(tools.map((event) => event.output)).toEqual([
      'first',
      'replacement',
      'final output',
    ])
    expect(new Set(tools.map((event) => event.itemId)).size).toBe(1)
    expect(f.events.some((event) => event.type.startsWith('child_'))).toBe(
      false,
    )
  })
  it('38: the same native tool ID in later roots cannot overwrite its former owner', async () => {
    const { f, handle, receipt } = await active()
    await f.control({
      events: [
        {
          type: 'tool_execution_start',
          toolCallId: 'reused',
          toolName: 'test',
          args: {},
        },
      ],
    })
    await f.settle()
    await receipt.completion
    const second = handle.prompt('next')
    await second.acceptance
    await f.control({
      events: [
        { type: 'agent_start' },
        {
          type: 'tool_execution_start',
          toolCallId: 'reused',
          toolName: 'test',
          args: {},
        },
      ],
    })
    await f.settle()
    await second.completion
    const tools = f.events.filter((event) => event.type === 'tool_started')
    expect(tools).toHaveLength(2)
    expect(tools[0]?.itemId).not.toBe(tools[1]?.itemId)
    expect(tools[0]?.runId).not.toBe(tools[1]?.runId)
  })
  it('39, 42, 49: all native roles use the same live and history decoder', async () => {
    const { f, receipt } = await active()
    const messages = [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            mimeType: 'image/png',
            data: png.toString('base64'),
          },
        ],
        timestamp: 0,
      },
      {
        role: 'custom',
        customType: 'hidden-extension',
        content: 'hidden content',
        display: false,
        details: { private: true },
        timestamp: 0,
      },
      {
        role: 'bashExecution',
        command: 'printf test',
        output: 'test',
        exitCode: 0,
        cancelled: false,
        truncated: false,
        excludeFromContext: true,
        timestamp: 0,
      },
      {
        role: 'compactionSummary',
        summary: 'prior context',
        tokensBefore: 20,
        timestamp: 0,
      },
      {
        role: 'branchSummary',
        summary: 'branch context',
        fromId: 'native-entry',
        timestamp: 0,
      },
      {
        role: 'toolResult',
        toolCallId: 'no-observed-start',
        toolName: 'native-tool',
        content: [{ type: 'text', text: 'result' }],
        isError: false,
        usage,
        timestamp: 0,
      },
    ]
    for (const message of messages) {
      expect(
        decodeEntry({
          type: 'message',
          id: 'entry',
          parentId: null,
          timestamp: new Date(0).toISOString(),
          message,
        }).body,
      ).toEqual({
        type: 'message',
        message: decodeMessage(message),
        timestamp: new Date(0).toISOString(),
      })
    }
    await f.control({
      events: messages.map((message) => ({ type: 'message_end', message })),
    })
    await f.settle()
    expect(await receipt.completion).toMatchObject({ status: 'completed' })
    expect(
      f.records
        .filter((record) => record.body.type === 'message')
        .map(
          (record) =>
            record.body.type === 'message' && record.body.message.role,
        ),
    ).toEqual([...messages.map((message) => message.role), 'assistant'])
    expect(
      f.events.some(
        (event) => 'text' in event && event.text === 'hidden content',
      ),
    ).toBe(false)
    expect(
      f.events.some(
        (event) =>
          event.type === 'tool_started' &&
          event.toolCallId === 'no-observed-start',
      ),
    ).toBe(false)
  })
  it('42: native usage preserves zeros, optional reasoning, costs and cacheWrite1h without summing', async () => {
    const { f, receipt } = await active()
    const nativeUsage = {
      input: 0,
      output: 20,
      cacheRead: 2,
      cacheWrite: 3,
      cacheWrite1h: 1,
      reasoning: 5,
      totalTokens: 25,
      cost: { input: 0, output: 1, cacheRead: 2, cacheWrite: 3, total: 6 },
    }
    const final = {
      ...assistant(),
      usage: nativeUsage,
      responseId: 'response-id',
      responseModel: 'actual-model',
    }
    await f.control({
      state: { isStreaming: false },
      events: [
        { type: 'message_end', message: final },
        { type: 'turn_end', message: final, toolResults: [] },
        { type: 'agent_end', messages: [final], willRetry: false },
        { type: 'agent_settled' },
      ],
    })
    await receipt.completion
    const events = f.events.filter((event) => event.type === 'usage')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      inputTokens: 0,
      outputTokens: 20,
      totalTokens: 25,
      reasoningOutputTokens: 5,
      cacheWriteInputTokens: 3,
    })
    expect(JSON.stringify(f.records)).toContain('cacheWrite1h')
    expect(f.records[0]?.body).toMatchObject({
      message: { responseId: 'response-id', usage: nativeUsage },
    })
  })
  it('39: strict outer fields and unknown history kinds fail explicitly', () => {
    expect(() =>
      decodeMessage({
        role: 'custom',
        customType: 'x',
        content: 'text',
        display: false,
        timestamp: 0,
        unexpected: true,
      }),
    ).toThrow()
    expect(() =>
      decodeEntry({
        type: 'future_entry',
        id: 'id',
        parentId: null,
        timestamp: new Date(0).toISOString(),
      }),
    ).toThrow()
  })
  it('39, 49: idle native custom messages persist without a fabricated root', async () => {
    const f = await fixture()
    owned.push(f)
    await f.start()
    const message = {
      role: 'custom',
      customType: 'idle-notice',
      content: 'notice',
      display: false,
      timestamp: 0,
    }
    await f.control({
      events: [
        { type: 'message_start', message },
        { type: 'message_end', message },
      ],
    })
    await f.wait(() => f.records.length === 1 || false)
    expect(f.events).toEqual([])
    expect(f.records[0]?.source).not.toHaveProperty('runId')
    expect(f.records[0]?.body).toMatchObject({
      type: 'message',
      message: { customType: 'idle-notice', display: false },
    })
  })
  it('42: native diagnostic strings redact known values while retaining typed metadata', () => {
    const message = decodeMessage(
      {
        ...assistant(),
        errorMessage: 'provider fake-secret failed',
        diagnostics: [
          {
            type: 'transport',
            timestamp: 1,
            error: { message: 'fake-secret' },
            details: { nested: ['fake-secret'] },
          },
        ],
      },
      ['fake-secret'],
    )
    expect(JSON.stringify(message)).not.toContain('fake-secret')
    expect(JSON.stringify(message)).toContain('[REDACTED]')
  })
})
