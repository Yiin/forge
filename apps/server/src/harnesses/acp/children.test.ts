import { describe, expect, it } from 'vitest'
import { harnessEventSchema } from '@forge/protocol/harness'
import {
  AcpChildren,
  type AcpChildAdmission,
  type AcpChildHistory,
} from './children.js'
import type { AcpLiveOwner, AcpRecordOwner } from './ingestion.js'
import { captureNumbers } from './numbers.js'
import { AcpResourceHost } from './limits.js'
const root = (runId = 'root'): AcpLiveOwner => ({
  phase: 'live',
  sessionId: 'forge',
  providerInstanceId: 'provider',
  account: { kind: 'native-default', configurationId: 'config' },
  runtimeGeneration: 'generation',
  runId,
  turnId: runId,
  binding: {
    provider: 'provider',
    accountId: null,
    providerSessionId: 'native',
    cwd: '/workspace',
  },
})
function children(
  profile: 'grok' | 'devin' = 'grok',
  history: 'new' | 'unavailable' | AcpChildHistory = 'new',
  rail: 'public' | 'comet' = 'public',
) {
  return new AcpChildren({
    profile,
    host: new AcpResourceHost(),
    instanceId: 'provider',
    restoredHistory: history,
    grokRail: rail,
    makeEvent: (owner, body) =>
      harnessEventSchema.parse({
        ...body,
        deliveryId: 'delivery',
        sessionId: owner.sessionId,
        runId: owner.runId,
        turnId: owner.turnId,
        runtimeGeneration: owner.runtimeGeneration,
        emittedAt: 1,
      }),
  })
}
let ordinal = 0
function frame(
  params: unknown,
  fallbackOwner: AcpRecordOwner = root(),
  method = '_x.ai/session/update',
  extra: Partial<AcpChildAdmission> = {},
) {
  const strings: Record<string, string> = {}
  const numbers = captureNumbers(
    JSON.stringify({ method, params }),
    (path, value) => {
      if (
        path === '/method' ||
        /\/(sessionId|parent_session_id|child_session_id|subagent_id|agentId|parentAgentId|attempt_id|parent_prompt_id|sessionUpdate)$/.test(
          path,
        )
      )
        strings[path] = value
    },
  )
  const admission: AcpChildAdmission = {
    strings,
    numbers,
    fallbackOwner,
    exclusiveSubmittedRoot: true,
    wireOrdinal: ++ordinal,
    transportGeneration: 'generation',
    rootForPrompt: (id) =>
      id === 'root' ? root() : id === 'next' ? root('next') : null,
    ...extra,
  }
  return { params, method, admission }
}
const grok = (
  kind: string,
  attemptId?: string,
  extra: Record<string, unknown> = {},
) => ({
  sessionId: 'native',
  update: {
    sessionUpdate: `subagent_${kind}`,
    subagent_id: 'native-child',
    child_session_id: 'child-session',
    ...(kind === 'spawned'
      ? { parent_session_id: 'native', description: 'Same title' }
      : {}),
    ...(attemptId ? { attempt_id: attemptId } : {}),
    ...extra,
  },
})
function publish(c: AcpChildren, f: ReturnType<typeof frame>) {
  const owner = c.route(f.admission)
  return owner
    ? c.update(f.method, f.params, owner, f.admission.wireOrdinal, f.admission)
    : null
}
function event(records: ReturnType<typeof publish>) {
  const value = records?.[0]?.value
  return value?.kind === 'event' &&
    (value.event.type === 'child_started' ||
      value.event.type === 'child_finished')
    ? value.event
    : undefined
}
const devin = (
  kind: 'started' | 'completed' | 'context',
  value: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({
  sessionId: 'native',
  update: {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'native-tool',
    _meta: { [`cognition.ai/subagent_${kind}`]: value, ...extra },
  },
})
describe('ACP exact child intervals', () => {
  it('retains private transport evidence without changing the public owner generation', () => {
    const c = children()
    const f = frame(grok('spawned', 'attempt'), root(), undefined, {
      transportGeneration: 'private-one',
    })
    publish(c, f)
    const history = c.snapshot()
    expect(history.intervals[0]).toMatchObject({
      sourceGeneration: 'private-one',
      owner: { runtimeGeneration: root().runtimeGeneration },
    })
    const restored = children('grok', history)
    expect(restored.snapshot()).toEqual(history)
    c.close()
    restored.close()
  })
  it('attributes first use only with exclusive submitted parent proof', () => {
    const c = children()
    expect(
      c.route(
        frame(grok('spawned'), root(), undefined, {
          exclusiveSubmittedRoot: false,
        }).admission,
      ),
    ).toBeNull()
    const started = event(publish(c, frame(grok('spawned'))))
    expect(started).toMatchObject({
      type: 'child_started',
      runId: 'root',
      providerChildId: 'native-child',
      description: 'Same title',
    })
    expect(started).not.toHaveProperty('parentToolCallId')
    expect(started).not.toHaveProperty('parentChildId')
    expect(started?.childId).not.toBe('native-child')
    expect(c.snapshot().intervals[0]!.intervalId).not.toBe(started?.childId)
    const finished = event(
      publish(
        c,
        frame(
          grok('finished', undefined, { status: 'cancelled' }),
          root('next'),
        ),
      ),
    )
    expect(finished).toMatchObject({
      type: 'child_finished',
      runId: 'root',
      outcome: { status: 'interrupted' },
      childId: started?.childId,
    })
  })
  it('retains both attempts and routes a late original finish before reservation', () => {
    const c = children()
    const first = event(publish(c, frame(grok('spawned', 'a'))))!
    const second = event(publish(c, frame(grok('spawned', 'b'), root('next'))))!
    expect(first.childId).not.toBe(second.childId)
    const late = frame(
      grok('finished', 'a', { status: 'completed' }),
      root('next'),
    )
    expect(c.route(late.admission)).toEqual(root())
    expect(event(publish(c, late))).toMatchObject({
      childId: first.childId,
      runId: 'root',
      outcome: { status: 'completed' },
    })
    expect(c.hasLive(root('next'))).toBe(true)
    expect(
      c.route(
        frame(grok('finished', undefined, { status: 'failed' }), root('next'))
          .admission,
      ),
    ).toBeNull()
    expect(publish(c, frame(grok('spawned', 'a'), root('next')))).toEqual([])
  })
  it('keeps reused no-attempt spawns visible but quarantines ambiguous finish after closure and restore', () => {
    const c = children()
    publish(c, frame(grok('spawned')))
    publish(c, frame(grok('finished', undefined, { status: 'completed' })))
    publish(c, frame(grok('spawned'), root('next')))
    const restored = children('grok', c.snapshot())
    expect(restored.snapshot().intervals).toHaveLength(2)
    expect(
      restored.route(
        frame(
          grok('finished', undefined, { status: 'completed' }),
          root('next'),
        ).admission,
      ),
    ).toBeNull()
    expect(restored.hasLive(root('next'))).toBe(true)
  })
  it('captures parent prompt ownership once and rejects conflicting queued parameters', () => {
    const c = children()
    let current = root()
    const original = frame(
      grok('spawned', 'a', { parent_prompt_id: 'exact' }),
      root('next'),
      undefined,
      { rootForPrompt: () => current },
    )
    expect(c.route(original.admission)).toEqual(root())
    current = root('next')
    expect(event(publish(c, original))).toMatchObject({ runId: 'root' })
    const altered = frame(grok('progress', 'a'))
    const owner = c.route(altered.admission)!
    const params = grok('progress', 'b')
    expect(() =>
      c.update(
        altered.method,
        params,
        owner,
        altered.admission.wireOrdinal,
        altered.admission,
      ),
    ).toThrow('admission changed')
  })
  it('routes captured dependent frames but withholds context until the introducing frame validates', () => {
    const c = children(),
      spawn = frame(grok('spawned', 'a'))
    c.route(spawn.admission)
    const content = frame(
      {
        sessionId: 'child-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'child' },
        },
      },
      root('next'),
      'session/update',
    )
    expect(c.route(content.admission)).toEqual(root())
    expect(c.context(content.params, content.admission)).toBeNull()
    expect(() => c.snapshot()).toThrow('introduction is pending')
    publish(c, spawn)
    expect(c.context(content.params, content.admission)).toMatchObject({
      owner: root(),
      childId: c.snapshot().intervals[0]!.childId,
    })
  })
  it('does not infer success from an unknown status or repeat queued terminal events', () => {
    const c = children()
    publish(c, frame(grok('spawned', 'a')))
    expect(
      publish(c, frame(grok('finished', 'a', { status: 'unknown' }))),
    ).toEqual([])
    expect(c.hasLive(root())).toBe(true)
    const one = frame(grok('finished', 'a', { status: 'completed' })),
      two = frame(grok('finished', 'a', { status: 'completed' }))
    c.route(one.admission)
    c.route(two.admission)
    expect(event(publish(c, one))).toMatchObject({
      outcome: { status: 'completed' },
    })
    expect(publish(c, two)).toEqual([])
  })
  it('keeps public and Comet rails explicit and rejects foreign parent and numeric identities', () => {
    const c = children()
    expect(
      event(
        publish(
          c,
          frame(grok('spawned'), root(), '_x.ai/session_notification'),
        ),
      ),
    ).toBeUndefined()
    const comet = children('grok', 'new', 'comet')
    expect(
      event(
        publish(
          comet,
          frame(grok('spawned'), root(), '_x.ai/session_notification'),
        ),
      ),
    ).toMatchObject({ type: 'child_started' })
    expect(
      c.route(
        frame(grok('spawned', undefined, { parent_session_id: 'foreign' }))
          .admission,
      ),
    ).toBeNull()
    expect(
      c.route(
        frame(grok('spawned', undefined, { attempt_id: 9007199254740992 }))
          .admission,
      ),
    ).toBeNull()
  })
  it('does not use missing persisted history as proof of unique first use', () => {
    const c = children('grok', 'unavailable')
    publish(c, frame(grok('spawned')))
    expect(
      c.route(
        frame(grok('finished', undefined, { status: 'completed' })).admission,
      ),
    ).toBeNull()
    publish(c, frame(grok('spawned', 'exact'), root('next')))
    expect(
      event(
        publish(
          c,
          frame(grok('finished', 'exact', { status: 'failed' }), root('next')),
        ),
      ),
    ).toMatchObject({ runId: 'next', outcome: { status: 'failed' } })
  })
  it('routes Devin context and nested lifecycle without inventing tool ancestry', () => {
    const c = children('devin')
    const first = event(
      publish(
        c,
        frame(
          devin('started', {
            agentId: 'agent',
            title: 'Title',
            profile: 'worker',
          }),
          root(),
          'session/update',
        ),
      ),
    )!
    const content = frame(
      devin('context', { parentAgentId: 'agent' }),
      root('next'),
      'session/update',
    )
    expect(c.route(content.admission)).toEqual(root())
    expect(c.context(content.params, content.admission)?.childId).toBe(
      first.childId,
    )
    const nested = event(
      publish(
        c,
        frame(
          devin(
            'started',
            { agentId: 'nested', title: 'Nested' },
            { 'cognition.ai/subagent_context': { parentAgentId: 'agent' } },
          ),
          root('next'),
          'session/update',
        ),
      ),
    )!
    expect(nested).toMatchObject({
      runId: 'root',
      parentChildId: first.childId,
    })
    expect(nested).not.toHaveProperty('parentToolCallId')
    expect(
      publish(
        c,
        frame(
          devin('completed', { agentId: 'agent' }),
          root('next'),
          'session/update',
        ),
      ),
    ).toEqual([])
    expect(
      event(
        publish(
          c,
          frame(
            devin('completed', { agentId: 'agent', success: false }),
            root('next'),
            'session/update',
          ),
        ),
      ),
    ).toMatchObject({ runId: 'root', outcome: { status: 'failed' } })
  })
  it('quarantines reused Devin lifecycle IDs and unknown context', () => {
    const c = children('devin')
    publish(
      c,
      frame(
        devin('started', { agentId: 'agent', title: 'Same' }),
        root(),
        'session/update',
      ),
    )
    publish(
      c,
      frame(
        devin('started', { agentId: 'agent', title: 'Same' }),
        root('next'),
        'session/update',
      ),
    )
    expect(
      c.route(
        frame(
          devin('completed', { agentId: 'agent', success: true }),
          root('next'),
          'session/update',
        ).admission,
      ),
    ).toBeNull()
    expect(
      c.route(
        frame(
          devin('context', { parentAgentId: 'missing' }),
          root('next'),
          'session/update',
        ).admission,
      ),
    ).toBeNull()
  })
  it('does not clone binary content or confuse payload IDs with routing IDs', () => {
    const c = children()
    publish(c, frame(grok('spawned')))
    const params = {
      sessionId: 'child-session',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'image',
          data: 'a'.repeat(2 * 1024 * 1024),
          _meta: { agentId: 9007199254740992 },
        },
      },
    }
    const child = frame(params, root('next'), 'session/update')
    expect(c.route(child.admission)).toEqual(root())
    expect(c.context(params, child.admission)?.owner).toEqual(root())
  })
  it('rejects malformed restored owners and profile changes before using history', () => {
    const c = children()
    publish(c, frame(grok('spawned')))
    const history = c.snapshot()
    expect(() => children('devin', history)).toThrow('profile')
    const invalid = {
      ...history,
      intervals: [
        {
          ...history.intervals[0]!,
          owner: {
            ...root(),
            binding: { ...root().binding, accountId: 'foreign' },
          },
        },
      ],
    }
    expect(() => children('grok', invalid)).toThrow('account')
    const foreign = {
      ...history,
      intervals: [
        {
          ...history.intervals[0]!,
          owner: {
            ...root(),
            providerInstanceId: 'foreign',
            binding: { ...root().binding, provider: 'foreign' },
          },
        },
      ],
    }
    expect(() => children('grok', foreign)).toThrow(
      'Foreign ACP child registry',
    )
    let reads = 0
    const hostile = {
      ...history,
      get absenceKnown() {
        reads++
        return true
      },
    }
    expect(() => children('grok', hostile)).toThrow('accessors')
    expect(reads).toBe(0)
  })
  it('fences content when its introducing lifecycle frame fails validation', () => {
    const c = children(),
      spawn = frame(grok('spawned', 'a', { description: 7 }))
    c.route(spawn.admission)
    const child = frame(
      {
        sessionId: 'child-session',
        update: { sessionUpdate: 'agent_message_chunk' },
      },
      root('next'),
      'session/update',
    )
    c.route(child.admission)
    expect(() => publish(c, spawn)).toThrow('description')
    expect(c.context(child.params, child.admission)).toBeNull()
    expect(() => c.snapshot()).toThrow('introduction is pending')
  })
  it('preserves parent session replay ownership without creating child context', () => {
    const c = children()
    const { runId: _run, turnId: _turn, ...base } = root()
    const replay: AcpRecordOwner = {
      ...base,
      phase: 'load_replay',
      loadId: 'load',
      requestedNativeSessionId: 'native',
    }
    const update = frame(
      { sessionId: 'native', update: { sessionUpdate: 'agent_message_chunk' } },
      replay,
      'session/update',
    )
    expect(c.route(update.admission)).toEqual(replay)
    expect(c.isChild(update.admission)).toBe(false)
    expect(c.context(update.params, update.admission)).toBeNull()
    expect(publish(c, update)).toEqual([])
    expect(c.snapshot().intervals).toEqual([])
  })
  it('closes new content admission while preserving an earlier captured context', () => {
    const c = children()
    publish(c, frame(grok('spawned', 'a')))
    const params = {
      sessionId: 'child-session',
      update: { sessionUpdate: 'agent_message_chunk' },
    }
    const earlier = frame(params, root('next'), 'session/update')
    c.route(earlier.admission)
    publish(c, frame(grok('finished', 'a', { status: 'completed' })))
    const later = frame(params, root('next'), 'session/update')
    expect(c.route(later.admission)).toEqual(root())
    expect(c.context(later.params, later.admission)).toBeNull()
    expect(c.isChild(later.admission)).toBe(true)
    expect(c.context(earlier.params, earlier.admission)?.owner).toEqual(root())
  })
  it('quarantines contradictory prompt ownership even for an exact retained attempt', () => {
    const c = children()
    publish(c, frame(grok('spawned', 'a')))
    let resolutions = 0
    const contradiction = frame(
      grok('spawned', 'a', { parent_prompt_id: 'next' }),
      root('next'),
      undefined,
      {
        rootForPrompt: () => {
          resolutions++
          return root('next')
        },
      },
    )
    expect(c.route(contradiction.admission)).toBeNull()
    expect(c.route(contradiction.admission)).toBeNull()
    expect(resolutions).toBe(1)
    expect(c.snapshot().intervals).toHaveLength(1)
  })
  it('charges retained registry capacity until explicit close and releases failed restoration', () => {
    const host = new AcpResourceHost()
    const options = {
      profile: 'grok' as const,
      grokRail: 'public' as const,
      host,
      instanceId: 'provider',
      restoredHistory: 'new' as const,
      makeEvent: () => {
        throw Error('unused')
      },
    }
    const c = new AcpChildren(options)
    expect(() =>
      host.reserve('provider', 'retained', 128 * 1024 * 1024),
    ).toThrow('limit')
    c.close()
    c.close()
    host.reserve('provider', 'retained', 128 * 1024 * 1024)()
    expect(
      () =>
        new AcpChildren({
          ...options,
          restoredHistory: {
            profile: 'devin',
            absenceKnown: true,
            intervals: [],
          },
        }),
    ).toThrow('profile')
    host.reserve('provider', 'retained', 128 * 1024 * 1024)()
    expect(() => c.route(frame(grok('spawned')).admission)).toThrow('closed')
  })
  it('refuses live child overflow without removing existing tombstones', () => {
    const c = children()
    for (let index = 0; index < 32; index++)
      publish(
        c,
        frame(
          grok('spawned', String(index), {
            subagent_id: `child-${index}`,
            child_session_id: `session-${index}`,
          }),
        ),
      )
    expect(() => publish(c, frame(grok('spawned', 'overflow')))).toThrow(
      'state limit',
    )
    expect(c.snapshot().intervals).toHaveLength(32)
  })
})
