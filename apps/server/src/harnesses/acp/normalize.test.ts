import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { AcpNormalizer } from './normalize.js'
import { createAcpContent } from './content.js'
import { AcpResourceHost } from './limits.js'
import { captureNumbers } from './numbers.js'
import type { AcpContentOwner, AcpRecordInput } from './ingestion.js'
import { deferred } from '../transport-test-helpers.js'
const subject: Omit<AcpContentOwner, 'itemId'> = {
  owner: {
    phase: 'live',
    sessionId: 'session',
    providerInstanceId: 'instance',
    account: { kind: 'native-default', configurationId: 'config' },
    runtimeGeneration: 'generation',
    binding: {
      provider: 'instance',
      accountId: null,
      cwd: '/var/tmp',
      providerSessionId: 'native',
    },
    runId: 'run',
    turnId: 'turn',
  },
}
function setup(beforePut?: () => Promise<void>, host = new AcpResourceHost()) {
  const stored: Array<{ owner: AcpContentOwner; bytes: Uint8Array }> = []
  const content = createAcpContent({
    host,
    instanceId: 'instance',
    store: {
      async put(input) {
        await beforePut?.()
        stored.push(input)
        return {
          artifactId: `artifact-${stored.length}`,
          mime: input.mime,
          bytes: input.bytes.byteLength,
          sha256: createHash('sha256').update(input.bytes).digest('hex'),
        }
      },
      async discard() {},
    },
  })
  const normalizer = new AcpNormalizer(content, host, 'instance')
  return {
    normalizer,
    stored,
    async close() {
      normalizer.retire(subject)
      await content.close()
    },
  }
}
function update(
  normalizer: AcpNormalizer,
  value: unknown,
  owner = subject,
  signal = new AbortController().signal,
) {
  const text = JSON.stringify({ params: { update: value } })
  return normalizer.update(value, captureNumbers(text), owner, signal)
}
function events(records: AcpRecordInput[]) {
  return records.flatMap((record) =>
    record.value.kind === 'event' ? [record.value.event] : [],
  )
}
describe('ACP journal content normalization', () => {
  it('keeps stable text/thought items, roles, and source references', async () => {
    const f = setup()
    try {
      const first = events(
        await update(f.normalizer, {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'Hello',
            annotations: { audience: ['assistant'] },
          },
          _meta: { signature: 'opaque' },
        }),
      )[0]!
      const second = events(
        await update(f.normalizer, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '.' },
        }),
      )[0]!
      const thought = events(
        await update(f.normalizer, {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'Think' },
        }),
      )[0]!
      const user = events(
        await update(f.normalizer, {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'Ask' },
        }),
      )[0]!
      expect(first).toMatchObject({
        type: 'text_delta',
        text: 'Hello',
        role: 'assistant',
        sourceRef: { artifactId: 'artifact-1' },
      })
      expect(
        'itemId' in first &&
          'itemId' in second &&
          first.itemId === second.itemId,
      ).toBe(true)
      expect(
        'itemId' in first &&
          'itemId' in thought &&
          first.itemId !== thought.itemId,
      ).toBe(true)
      expect(user).toMatchObject({ type: 'text_delta', role: 'user' })
      expect(
        JSON.parse(Buffer.from(f.stored[0]!.bytes).toString()),
      ).toMatchObject({
        _meta: { signature: 'opaque' },
        content: { annotations: { audience: ['assistant'] } },
      })
    } finally {
      await f.close()
    }
  })
  it('retains exact media bytes and ordered block indexes', async () => {
    const f = setup()
    try {
      const image = events(
        await update(f.normalizer, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'image', mimeType: 'image/png', data: 'AAEC' },
        }),
      )[0]!
      const audio = events(
        await update(f.normalizer, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'audio', mimeType: 'audio/wav', data: 'AwQ=' },
        }),
      )[0]!
      expect(image).toMatchObject({
        type: 'content_block',
        blockIndex: 0,
        block: { kind: 'image', bytes: 3 },
      })
      expect(audio).toMatchObject({
        type: 'content_block',
        blockIndex: 1,
        block: { kind: 'audio', bytes: 2 },
      })
      expect([...f.stored[0]!.bytes]).toEqual([0, 1, 2])
    } finally {
      await f.close()
    }
  })
  it('does not store redundant sidecars for bare text or thought chunks', async () => {
    const f = setup()
    try {
      await update(f.normalizer, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'plain' },
      })
      await update(f.normalizer, {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'plain' },
      })
      expect(f.stored).toEqual([])
    } finally {
      await f.close()
    }
  })
  it('reserves media ordering before out-of-order storage acknowledgments', async () => {
    const gates = [deferred<void>(), deferred<void>()],
      entered = [deferred<void>(), deferred<void>()]
    let ordinal = 0
    const f = setup(async () => {
      const i = ordinal++
      entered[i]!.resolve()
      await gates[i]!.promise
    })
    const first = update(f.normalizer, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'image', mimeType: 'image/png', data: 'AA==' },
    })
    const second = update(f.normalizer, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'image', mimeType: 'image/png', data: 'AQ==' },
    })
    try {
      await Promise.all(entered.map((g) => g.promise))
      gates[1]!.resolve()
      expect(events(await second)[0]).toMatchObject({ blockIndex: 1 })
      gates[0]!.resolve()
      expect(events(await first)[0]).toMatchObject({ blockIndex: 0 })
    } finally {
      gates.forEach((g) => g.resolve())
      await Promise.allSettled([first, second])
      await f.close()
    }
  })
  it('keeps the response identity captured before usage storage', async () => {
    const entered = deferred<void>(),
      gate = deferred<void>()
    const f = setup(async () => {
      entered.resolve()
      await gate.promise
    })
    const owner = { ...subject, responseId: 'original' }
    const pending = f.normalizer.usage(
      { inputTokens: 0 },
      'standard',
      captureNumbers('{"usage":{"inputTokens":0}}'),
      '/usage',
      owner,
      new AbortController().signal,
    )
    try {
      await entered.promise
      owner.responseId = 'changed'
      gate.resolve()
      expect(events(await pending)[0]).toMatchObject({ responseId: 'original' })
      expect(f.stored[0]!.owner.responseId).toBe('original')
    } finally {
      gate.resolve()
      await pending
      f.normalizer.retire({ ...subject, responseId: 'original' })
      await f.close()
    }
  })
  it('stores tool media as authorized blocks and preserves explicit null input', async () => {
    const f = setup()
    try {
      const result = events(
        await update(f.normalizer, {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool',
          title: 'Image',
          rawInput: null,
          content: [
            {
              type: 'content',
              content: {
                type: 'image',
                data: Buffer.alloc(1024 * 1024, 1).toString('base64'),
                mimeType: 'image/png',
              },
            },
          ],
        }),
      )
      expect(result[0]).toMatchObject({ type: 'tool_started', input: null })
      expect(result[1]).toMatchObject({
        type: 'tool_update',
        output: {
          content: [
            { block: { kind: 'image', bytes: 1024 * 1024 }, blockIndex: 0 },
          ],
        },
      })
      const json = f.stored
        .filter((entry) => entry.bytes[0] === 123)
        .map((entry) => Buffer.from(entry.bytes).toString())
      expect(
        json.every(
          (text) => !text.includes('base64') && !text.includes('AQEBAQEB'),
        ),
      ).toBe(true)
    } finally {
      await f.close()
    }
  })
  it('normalizes a valid multi-media tool snapshot within content-store concurrency', async () => {
    const f = setup()
    try {
      const result = events(
        await update(f.normalizer, {
          sessionUpdate: 'tool_call',
          toolCallId: 'media',
          title: 'Read images',
          content: [0, 1, 2].map((value) => ({
            type: 'content',
            content: {
              type: 'image',
              mimeType: 'image/png',
              data: Buffer.from([value]).toString('base64'),
            },
          })),
        }),
      )
      expect(result[1]).toMatchObject({
        type: 'tool_update',
        output: {
          content: [{ blockIndex: 0 }, { blockIndex: 1 }, { blockIndex: 2 }],
        },
      })
    } finally {
      await f.close()
    }
  })
  it('preserves outer metadata and inner media annotations separately', async () => {
    const f = setup()
    try {
      const result = events(
        await update(f.normalizer, {
          sessionUpdate: 'agent_message_chunk',
          _meta: { outer: 'signature' },
          content: {
            type: 'image',
            data: 'AA==',
            mimeType: 'image/png',
            annotations: { audience: ['assistant'] },
          },
        }),
      )
      expect(result.map((event) => event.type)).toEqual([
        'content_block',
        'source_reference',
      ])
      const metadata = f.stored
        .filter((entry) => entry.bytes[0] === 123)
        .map((entry) => JSON.parse(Buffer.from(entry.bytes).toString()))
      expect(metadata).toEqual(
        expect.arrayContaining([
          { annotations: { audience: ['assistant'] } },
          { _meta: { outer: 'signature' } },
        ]),
      )
    } finally {
      await f.close()
    }
  })
  it('charges retained nonbinary tool content against shared capacity', async () => {
    const f = setup(undefined, new AcpResourceHost({ retained: [8192, 8192] }))
    try {
      await expect(
        update(f.normalizer, {
          sessionUpdate: 'tool_call',
          toolCallId: 'large',
          title: 'Large',
          content: [
            {
              type: 'content',
              content: { type: 'text', text: 'x'.repeat(8192) },
            },
          ],
        }),
      ).rejects.toThrow('limit')
    } finally {
      await f.close()
    }
  })
  it('admits valid media above four MiB encoded and retains the decoded artifact bound', async () => {
    const f = setup()
    try {
      const result = events(
        await update(f.normalizer, {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'image',
            data: Buffer.alloc(4 * 1024 * 1024, 2).toString('base64'),
            mimeType: 'image/png',
          },
        }),
      )
      expect(result[0]).toMatchObject({
        type: 'content_block',
        block: { bytes: 4 * 1024 * 1024 },
      })
      await expect(
        update(f.normalizer, {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'image',
            data: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64'),
            mimeType: 'image/png',
          },
        }),
      ).rejects.toThrow()
    } finally {
      await f.close()
    }
  })
  it('merges sparse tool snapshots without adding another tool item', async () => {
    const f = setup()
    try {
      const first = events(
        await update(f.normalizer, {
          sessionUpdate: 'tool_call',
          toolCallId: 'native-tool',
          title: 'Read',
          rawInput: { path: 'file' },
          rawOutput: { text: 'one' },
          status: 'in_progress',
        }),
      )
      const second = events(
        await update(f.normalizer, {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'native-tool',
          status: 'completed',
          locations: null,
        }),
      )
      expect(
        first.filter((event) => event.type === 'tool_started'),
      ).toHaveLength(1)
      expect(second).toHaveLength(1)
      expect(second[0]).toMatchObject({
        type: 'tool_update',
        itemId: 'itemId' in first[0]! ? first[0].itemId : undefined,
        status: 'completed',
        output: { rawOutput: { text: 'one' }, locations: null, title: 'Read' },
      })
    } finally {
      await f.close()
    }
  })
  it('stages replay without persisted live root identities', async () => {
    const f = setup()
    const replay = {
      owner: {
        ...subject.owner,
        phase: 'load_replay' as const,
        loadId: 'load',
        requestedNativeSessionId: 'native',
      },
    }
    delete (replay.owner as Record<string, unknown>).runId
    delete (replay.owner as Record<string, unknown>).turnId
    try {
      const records = await update(
        f.normalizer,
        {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'history', _meta: { replay: true } },
        },
        replay,
      )
      expect(records[0]?.value).toMatchObject({
        kind: 'replay',
        event: { type: 'text_delta', role: 'user', text: 'history' },
      })
      expect(
        records[0]?.value.kind === 'replay' &&
          'runId' in records[0].value.event,
      ).toBe(false)
      expect(f.stored[0]?.owner.owner).toEqual(replay.owner)
    } finally {
      f.normalizer.retire(replay)
      await f.close()
    }
  })
  it('retains captured owner across held storage and rejects publication after cancellation', async () => {
    const entered = deferred<void>(),
      release = deferred<void>()
    const f = setup(async () => {
      entered.resolve()
      await release.promise
    })
    const controller = new AbortController()
    const result = update(
      f.normalizer,
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'held', _meta: { held: true } },
      },
      subject,
      controller.signal,
    )
    void result.catch(() => {})
    try {
      await entered.promise
      expect(() => f.normalizer.retire(subject)).toThrow('still owns')
      controller.abort()
      release.resolve()
      await expect(result).rejects.toThrow()
      expect(f.stored[0]?.owner.owner).toEqual(subject.owner)
    } finally {
      release.resolve()
      await result.catch(() => {})
      await f.close()
    }
  })
  it('retains invalid numeric context as exact source while publishing safe siblings', async () => {
    const f = setup()
    try {
      const text =
        '{"params":{"update":{"sessionUpdate":"usage_update","used":1e999,"size":10}}}'
      const records = await f.normalizer.update(
        JSON.parse(text).params.update,
        captureNumbers(text),
        subject,
        new AbortController().signal,
      )
      expect(events(records)[0]).toMatchObject({
        type: 'usage_snapshot',
        context: { capacity: 10 },
      })
      expect(
        JSON.parse(Buffer.from(f.stored[0]!.bytes).toString()),
      ).toMatchObject({ value: { used: '1e999' } })
    } finally {
      await f.close()
    }
  })
})
