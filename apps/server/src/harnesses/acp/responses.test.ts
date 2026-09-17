import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { harnessEventSchema } from '@forge/protocol/harness'
import { AcpResponses } from './responses.js'
import { createAcpContent } from './content.js'
import { AcpResourceHost } from './limits.js'
import { captureNumbers } from './numbers.js'
import type { AcpContentOwner, AcpRecordInput } from './ingestion.js'
import { deferred } from '../transport-test-helpers.js'
const subject: Omit<AcpContentOwner, 'itemId'> = {
  owner: {
    phase: 'live',
    sessionId: 's',
    providerInstanceId: 'instance',
    account: { kind: 'native-default', configurationId: 'config' },
    runtimeGeneration: 'g',
    binding: {
      provider: 'instance',
      accountId: null,
      cwd: '/var/tmp',
      providerSessionId: 'native',
    },
    runId: 'r',
    turnId: 't',
  },
}
function setup(beforePut?: () => Promise<void>) {
  const host = new AcpResourceHost(),
    sources: Array<{ owner: AcpContentOwner; data: unknown }> = []
  let thought: string | undefined
  const content = createAcpContent({
    host,
    instanceId: 'instance',
    store: {
      async put(input) {
        await beforePut?.()
        sources.push({
          owner: input.owner,
          data: JSON.parse(Buffer.from(input.bytes).toString()),
        })
        return {
          artifactId: `a-${sources.length}`,
          mime: input.mime,
          bytes: input.bytes.byteLength,
          sha256: createHash('sha256').update(input.bytes).digest('hex'),
        }
      },
      async discard() {},
    },
  })
  const responses = new AcpResponses({
    content,
    host,
    instanceId: 'instance',
    item: () => thought,
    record(owner, body, sourceRefs) {
      return {
        value: {
          kind: 'event',
          event: harnessEventSchema.parse({
            ...body,
            runId: 'r',
            turnId: 't',
            runtimeGeneration: 'g',
            deliveryId: 'd',
          }),
        },
        subject: { responseId: owner.responseId },
        sourceRefs,
      }
    },
  })
  const update = (value: unknown, owner = subject) => {
    const wire = JSON.stringify({
      params: { sessionId: 'native', update: value },
    })
    return responses.update(
      JSON.parse(wire).params,
      captureNumbers(wire),
      owner,
      'native',
      new AbortController().signal,
    )
  }
  return {
    responses,
    sources,
    update,
    setThought(value: string) {
      thought = value
    },
    async close() {
      responses.close()
      await content.close()
    },
  }
}
const events = (records: AcpRecordInput[]) =>
  records.flatMap((record) =>
    record.value.kind === 'event' ? [record.value.event] : [],
  )
describe('public Grok response boundaries', () => {
  it('quarantines a foreign session before creating response authority', async () => {
    const f = setup()
    try {
      const params = {
        sessionId: 'foreign',
        update: { sessionUpdate: 'response_started', message_id: 'one' },
      }
      const result = await f.responses.update(
        params,
        captureNumbers(JSON.stringify({ params })),
        subject,
        'native',
        new AbortController().signal,
      )
      expect(result.map((record) => record.value.kind)).toEqual(['disposition'])
      expect({ owner: subject.owner, ...result[0]!.subject }).toEqual(
        f.sources[0]!.owner,
      )
      expect(f.responses.owner('foreign', 'one')).toBeNull()
      expect(f.responses.current(subject, 'assistant')).toBeNull()
      await expect(
        f.responses.update(
          params,
          captureNumbers(JSON.stringify({ params })),
          subject,
          'foreign',
          new AbortController().signal,
        ),
      ).rejects.toThrow('Foreign Grok response rail')
    } finally {
      await f.close()
    }
  })
  it('keeps two model responses distinct and never creates root completion', async () => {
    const f = setup()
    try {
      const first = events(
        await f.update({
          sessionUpdate: 'response_started',
          message_id: 'one',
          input_tokens: 1,
        }),
      )
      const firstOwner = f.responses.current(subject, 'assistant')!
      await f.update({
        sessionUpdate: 'response_completed',
        message_id: 'one',
        stop_reason: 'tool_use',
      })
      const second = events(
        await f.update({
          sessionUpdate: 'response_started',
          message_id: 'two',
          input_tokens: 2,
        }),
      )
      const secondOwner = f.responses.current(subject, 'assistant')!
      expect(firstOwner.responseId).not.toBe(secondOwner.responseId)
      expect([...first, ...second].map((event) => event.type)).toEqual([
        'source_reference',
        'usage_snapshot',
        'source_reference',
        'usage_snapshot',
      ])
      expect(f.responses.owner('native', 'one')).toEqual(firstOwner)
      expect(first[1]).toMatchObject({
        type: 'usage_snapshot',
        tokens: { inputTokens: 1 },
        tokenScope: 'call',
        inputTokenBasis: 'excludes_cache_reads',
      })
    } finally {
      await f.close()
    }
  })
  it('preserves signatures without inventing empty thought text', async () => {
    const f = setup()
    try {
      await f.update({ sessionUpdate: 'response_started' })
      const response = f.responses.current(subject, 'assistant')!
      const records = events(
        await f.update({
          sessionUpdate: 'reasoning_completed',
          signature: 'encrypted',
        }),
      )
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({
        type: 'source_reference',
        boundary: 'reasoning_closed',
        subject: { kind: 'response', responseId: response.responseId },
      })
      expect(f.responses.current(subject, 'thought')).toBeNull()
      expect(f.sources.at(-1)!.data).toMatchObject({
        native: { update: { signature: 'encrypted' } },
      })
    } finally {
      await f.close()
    }
  })
  it('links an existing thought item and closes only the exact native response', async () => {
    const f = setup()
    try {
      await f.update({ sessionUpdate: 'response_started', message_id: 'first' })
      f.setThought('thought-item')
      expect(
        events(
          await f.update({
            sessionUpdate: 'reasoning_completed',
            signature: 'opaque',
          }),
        )[0],
      ).toMatchObject({ subject: { kind: 'item', itemId: 'thought-item' } })
      expect(f.sources.at(-1)!.owner).toMatchObject({
        itemId: 'thought-item',
        responseId: f.responses.current(subject, 'assistant')!.responseId,
      })
      await f.update({
        sessionUpdate: 'response_completed',
        message_id: 'first',
      })
      await f.update({
        sessionUpdate: 'response_started',
        message_id: 'second',
      })
      const current = f.responses.current(subject, 'assistant')
      const late = events(
        await f.update({
          sessionUpdate: 'response_completed',
          message_id: 'first',
          usage: { output_tokens: 0 },
        }),
      )
      expect(f.responses.current(subject, 'assistant')).toEqual(current)
      expect(late[1]).toMatchObject({
        type: 'usage_snapshot',
        responseId: f.responses.owner('native', 'first')?.responseId,
        tokens: { outputTokens: 0 },
      })
    } finally {
      await f.close()
    }
  })
  it('quarantines a conflicting native message instead of closing the current response', async () => {
    const f = setup()
    try {
      await f.update({ sessionUpdate: 'response_started', message_id: 'owned' })
      const current = f.responses.current(subject, 'assistant')
      const result = await f.update({
        sessionUpdate: 'response_completed',
        message_id: 'foreign',
        stop_sequence: 'secret marker',
      })
      expect(result[0]?.value).toEqual({
        kind: 'disposition',
        status: 'ignored',
        code: 'grok_response_identity_unproved',
      })
      expect(result[0]?.sourceRefs).toHaveLength(1)
      expect(f.responses.current(subject, 'assistant')).toEqual(current)
    } finally {
      await f.close()
    }
  })
  it('retains exact unsafe counts and response stop metadata', async () => {
    const f = setup()
    try {
      await f.update({ sessionUpdate: 'response_started', message_id: 'owned' })
      const wire =
        '{"params":{"sessionId":"native","update":{"sessionUpdate":"response_completed","message_id":"owned","signature":"sig","stop_sequence":null,"usage":{"input_tokens":9007199254740993,"output_tokens":0}}}}'
      const records = events(
        await f.responses.update(
          JSON.parse(wire).params,
          captureNumbers(wire),
          subject,
          'native',
          new AbortController().signal,
        ),
      )
      expect(records[1]).toMatchObject({ tokens: { outputTokens: 0 } })
      expect(f.sources.at(-1)!.data).toMatchObject({
        native: {
          update: {
            signature: 'sig',
            stop_sequence: null,
            usage: { input_tokens: '9007199254740993' },
          },
        },
      })
    } finally {
      await f.close()
    }
  })
  it('captures response and thought subjects before storage yields', async () => {
    const entered = deferred<void>(),
      gate = deferred<void>()
    let hold = false
    const f = setup(async () => {
      if (hold) {
        entered.resolve()
        await gate.promise
      }
    })
    try {
      await f.update({ sessionUpdate: 'response_started', message_id: 'owned' })
      hold = true
      const result = f.update({
        sessionUpdate: 'reasoning_completed',
        signature: 'sig',
      })
      await entered.promise
      f.setThought('too-late')
      expect(() => f.responses.close()).toThrow('still owns')
      gate.resolve()
      expect(events(await result)[0]).toMatchObject({
        subject: { kind: 'response' },
      })
    } finally {
      gate.resolve()
      await f.close()
    }
  })
})
