import { describe, expect, it } from 'vitest'
import { OpenCodeEvents, partInfo, tuple } from './opencode-events.js'
import { RetainedBudget, limitsOf } from './opencode-http.js'

const owner = {
  runId: 'run',
  turnId: 'turn',
  userId: 'msg_user',
  sessionId: 'ses_root',
}

describe('OpenCode part admission before publication', () => {
  it.each(['text', 'tool'])(
    'O5: %s count rejection preserves the previous part and emits nothing',
    (type) => {
      const limits = limitsOf({ partCount: 1 })
      const events: Record<string, unknown>[] = []
      const mapper = new OpenCodeEvents(
        limits,
        new RetainedBudget(limits.retainedBytes),
        (_owner, event) => events.push(event),
        () => undefined,
      )
      const part = partInfo(
        {
          id: 'prt_first',
          messageID: 'msg_assistant',
          sessionID: 'ses_root',
          ...(type === 'text'
            ? { type, text: 'first' }
            : {
                type,
                tool: 'fixture',
                callID: 'call',
                state: { status: 'running', input: {} },
              }),
        },
        limits,
      )
      mapper.part(part, owner, 'assistant')
      const state = mapper.parts.get(
        tuple(part.sessionID, part.messageID, part.id),
      )
      const count = events.length
      expect(() =>
        mapper.part({ ...part, id: 'prt_second' }, owner, 'assistant'),
      ).toThrow(/retained limit/)
      expect(events).toHaveLength(count)
      expect([...mapper.parts.values()]).toEqual([state])
      mapper.clear()
    },
  )

  it.each(['text', 'tool'])(
    'O5: %s replacement byte rejection preserves state and emits nothing',
    (type) => {
      const limits = limitsOf({ partBytes: 1024 })
      const events: Record<string, unknown>[] = []
      const mapper = new OpenCodeEvents(
        limits,
        new RetainedBudget(limits.retainedBytes),
        (_owner, event) => events.push(event),
        () => undefined,
      )
      const part = partInfo(
        {
          id: 'prt_first',
          messageID: 'msg_assistant',
          sessionID: 'ses_root',
          ...(type === 'text'
            ? { type, text: 'first' }
            : {
                type,
                tool: 'fixture',
                callID: 'call',
                state: { status: 'running', input: {} },
              }),
        },
        limits,
      )
      mapper.part(part, owner, 'assistant')
      const key = tuple(part.sessionID, part.messageID, part.id)
      const state = mapper.parts.get(key)
      const bytes = mapper.parts.retainedSize(key)
      const count = events.length
      const replacement = partInfo(
        {
          ...part,
          ...(type === 'text'
            ? { text: 'x'.repeat(700) }
            : {
                state: {
                  status: 'completed',
                  input: {},
                  output: 'x'.repeat(750),
                },
              }),
        },
        limits,
      )
      expect(() => mapper.part(replacement, owner, 'assistant')).toThrow(
        /retained limit/,
      )
      expect(events).toHaveLength(count)
      expect(mapper.parts.get(key)).toBe(state)
      expect(mapper.parts.retainedSize(key)).toBe(bytes)
      mapper.clear()
    },
  )
})
