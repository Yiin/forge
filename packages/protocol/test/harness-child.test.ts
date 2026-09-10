import { describe, expect, it } from 'vitest'
import {
  completionResultSchema,
  confirmedNativeBindingSchema,
  harnessEventSchema,
  nativeBindingSchema,
} from '../src/harness.js'

const root = {
  runId: 'forge-root-run',
  turnId: 'forge-root-turn',
  runtimeGeneration: 'runtime-1',
  deliveryId: 'delivery-1',
  itemId: 'item-1',
  providerRunId: 'native-run',
  providerTurnId: 'native-turn',
  providerItemId: 'native-item',
}
const binding = {
  provider: 'claude-personal',
  accountId: 'account-1',
  cwd: '/work/forge',
  providerSessionId: 'native-session-1',
}
const ownedItems = [
  { type: 'text_delta', text: 'hello', role: 'user' },
  { type: 'thought_delta', text: 'thinking' },
  {
    type: 'tool_started',
    toolCallId: 'forge-tool',
    name: 'Bash',
    input: { command: 'pwd' },
  },
  {
    type: 'tool_update',
    toolCallId: 'forge-tool',
    status: 'completed',
    output: '/work/forge',
  },
  { type: 'usage', inputTokens: 4, outputTokens: 3, totalTokens: 7 },
  {
    type: 'plan',
    steps: [{ id: 'step-1', title: 'Inspect source', status: 'completed' }],
  },
  { type: 'file_change', path: 'src/main.ts', kind: 'modified' },
  {
    type: 'permission_requested',
    request: {
      requestId: 'forge-permission',
      toolCallId: 'forge-tool',
      title: 'Run command',
      options: [{ id: 'deny', label: 'Deny' }],
    },
  },
  {
    type: 'question_requested',
    request: {
      requestId: 'forge-question',
      isBlocking: true,
      questions: [
        {
          id: 'question-1',
          question: 'Which file?',
          options: [],
          allowFreeInput: true,
          multiSelect: false,
        },
      ],
    },
  },
  {
    type: 'request_cancelled',
    requestId: 'forge-question',
    reason: 'The provider no longer needs this answer',
  },
]

const roundTrip = (value: unknown) =>
  harnessEventSchema.parse(JSON.parse(JSON.stringify(value)))

describe('confirmed native binding', () => {
  it.each(['account-1', null])(
    'preserves confirmed scope with account %s',
    (accountId) => {
      const input = { ...binding, accountId }
      const parsed = confirmedNativeBindingSchema.parse(input)
      expect(parsed).toEqual(input)
      expect(Object.isFrozen(parsed)).toBe(true)
      for (const key of Object.keys(parsed)) {
        expect(Reflect.set(parsed, key, 'replacement')).toBe(false)
      }
      expect(parsed).toEqual(input)
    },
  )

  it('keeps nullable input session identity separate from confirmed output', () => {
    const input = { ...binding, providerSessionId: null }
    expect(nativeBindingSchema.parse(input)).toEqual(input)
    expect(confirmedNativeBindingSchema.safeParse(input).success).toBe(false)
    expect(confirmedNativeBindingSchema.safeParse(null).success).toBe(false)
  })

  it.each(['provider', 'cwd', 'providerSessionId'])(
    'requires nonempty %s in confirmed output',
    (field) => {
      for (const value of [undefined, null, '', 42, [], {}]) {
        expect(
          confirmedNativeBindingSchema.safeParse({ ...binding, [field]: value })
            .success,
        ).toBe(false)
      }
    },
  )

  it('requires an explicit account scope', () => {
    for (const accountId of [undefined, '', 42, [], {}]) {
      expect(
        confirmedNativeBindingSchema.safeParse({ ...binding, accountId })
          .success,
      ).toBe(false)
    }
  })
})

describe('child event contracts', () => {
  it.each(ownedItems)(
    'preserves $type with child ownership or root ownership',
    (item) => {
      for (const owner of [{}, { childId: 'forge-child-b' }]) {
        const input = { ...root, ...item, ...owner }
        expect(roundTrip(input)).toEqual(input)
      }
    },
  )

  it.each(ownedItems)('rejects invalid child ownership on $type', (item) => {
    for (const childId of ['', null, 42, [], {}]) {
      expect(
        harnessEventSchema.safeParse({ ...root, ...item, childId }).success,
      ).toBe(false)
    }
  })

  it('keeps nested child, spawning tool, native agent, and parent child IDs separate', () => {
    const started = {
      ...root,
      type: 'child_started',
      childId: 'forge-child-b',
      parentToolCallId: 'forge-child-a-spawning-tool',
      providerChildId: 'native-agent-b',
      parentChildId: 'forge-child-a',
      description: 'Inspect the parser',
    }
    expect(roundTrip(started)).toEqual(started)
    const update = {
      ...root,
      type: 'child_updated',
      childId: 'forge-child-b',
      parentToolCallId: 'forge-child-a-spawning-tool',
      providerChildId: 'native-agent-b',
      parentChildId: 'forge-child-a',
    }
    expect(roundTrip(update)).toEqual(update)
    for (const key of [
      'parentToolCallId',
      'providerChildId',
      'parentChildId',
    ]) {
      for (const value of ['', null, 42, [], {}]) {
        for (const item of [started, update]) {
          expect(
            harnessEventSchema.safeParse({ ...item, [key]: value }).success,
          ).toBe(false)
        }
      }
    }
  })

  it.each(['child_started', 'child_updated', 'child_finished'])(
    'requires the child subject on %s',
    (type) => {
      const item = {
        ...root,
        type,
        ...(type === 'child_started' ? { description: 'Inspect source' } : {}),
        ...(type === 'child_finished'
          ? { outcome: { status: 'completed' } }
          : {}),
      }
      expect(roundTrip({ ...item, childId: 'forge-child' })).toEqual({
        ...item,
        childId: 'forge-child',
      })
      for (const childId of [undefined, null, '', 42]) {
        expect(harnessEventSchema.safeParse({ ...item, childId }).success).toBe(
          false,
        )
      }
    },
  )

  it('leaves omitted child metadata absent and rejects lifecycle or arbitrary update fields', () => {
    const update = {
      ...root,
      type: 'child_updated',
      childId: 'forge-child-b',
      providerChildId: 'native-agent-b',
    }
    expect(roundTrip(update)).toEqual(update)
    for (const extra of [
      { status: 'running' },
      { outcome: { status: 'completed' } },
      { description: 'Renamed child' },
      { data: { nativeId: 'native-agent-b' } },
    ]) {
      expect(
        harnessEventSchema.safeParse({ ...update, ...extra }).success,
      ).toBe(false)
    }
  })

  it.each([undefined, 'assistant', 'user'])(
    'preserves text role %s without inventing an explicit role',
    (role) => {
      const input = {
        ...root,
        type: 'text_delta',
        text: 'hello',
        ...(role === undefined ? {} : { role }),
      }
      expect(roundTrip(input)).toEqual(input)
    },
  )

  it.each([null, '', 'system', 'tool', 42])(
    'rejects unsupported text role %j',
    (role) => {
      expect(
        harnessEventSchema.safeParse({
          ...root,
          type: 'text_delta',
          text: 'hello',
          role,
        }).success,
      ).toBe(false)
    },
  )

  it('requires a Forge request ID and keeps cancellation separate from completion', () => {
    const event = {
      ...root,
      type: 'request_cancelled',
      requestId: 'forge-permission',
    }
    expect(roundTrip(event)).toEqual(event)
    expect(completionResultSchema.safeParse(event).success).toBe(false)
    for (const requestId of [undefined, null, '', 42]) {
      expect(
        harnessEventSchema.safeParse({ ...event, requestId }).success,
      ).toBe(false)
    }
    for (const reason of [null, 42, []]) {
      expect(harnessEventSchema.safeParse({ ...event, reason }).success).toBe(
        false,
      )
    }
  })
})
