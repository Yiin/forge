import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as acp from '@zed-industries/agent-client-protocol'
import { createProject, createSession, replaySince } from '../db/queries.js'
import { AcpNormalizer } from './normalize.js'

const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

function fixture() {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, path TEXT, created_at INTEGER);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT, harness TEXT, title TEXT, cwd TEXT, kind TEXT, retention TEXT NOT NULL DEFAULT 'permanent', parent_session_id TEXT, forked_at_seq INTEGER, fork_request_id TEXT, context_method TEXT, context_confidence TEXT, epic_run_id TEXT, account_id TEXT, status TEXT, auto_resume INTEGER, created_at INTEGER, last_activity_at INTEGER);
    CREATE TABLE messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, turn_id TEXT, item_id TEXT, role TEXT, type TEXT, content TEXT, created_at INTEGER);
    CREATE VIRTUAL TABLE messages_fts USING fts5(text, item_id UNINDEXED, seq UNINDEXED);
  `)
  const project = createProject(db, { name: 'Forge', path: '/tmp' })
  const session = createSession(db, {
    projectId: project.id,
    harness: 'mock',
    title: 'Chat',
    cwd: '/tmp',
  })
  return { db, session }
}

const notification = (sessionId: string, update: unknown) =>
  ({ sessionId, update }) as acp.SessionNotification

describe('ACP update normalization', () => {
  it('stamps and completes a subagent on every tool row', async () => {
    const { db, session } = fixture()
    const normalizer = new AcpNormalizer({ db })
    normalizer.beginTurn(session.id, 'subagent-turn')
    await normalizer.handle(
      notification(session.id, {
        sessionUpdate: 'tool_call',
        toolCallId: 'research-1',
        title: 'Research',
        kind: 'other',
        rawInput: { subagent_type: 'researcher' },
      }),
    )
    await normalizer.handle(
      notification(session.id, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'research-1',
        status: 'completed',
        content: [
          {
            type: 'content',
            content: {
              type: 'text',
              text: 'agent_id: agent-1\nactual_subagent_type: researcher\nstatus: completed',
            },
          },
        ],
      }),
    )
    normalizer.endTurn(session.id, { stopReason: 'end_turn' })
    const rows = replaySince(db, 0, [session.id]) as Array<{
      type: string
      content: string
    }>
    const tools = rows.filter((row) => row.type.startsWith('tool_'))
    const subagents = tools.map((row) => JSON.parse(row.content).subagent)
    expect(subagents.every(Boolean)).toBe(true)
    expect(new Set(subagents.map((item) => item.id)).size).toBe(1)
    expect(subagents.at(-1)!.status).toBe('completed')
  })

  it('marks an unfinished subagent as unknown in the final row', async () => {
    const { db, session } = fixture()
    const normalizer = new AcpNormalizer({ db })
    normalizer.beginTurn(session.id, 'unknown-turn')
    await normalizer.handle(
      notification(session.id, {
        sessionUpdate: 'tool_call',
        toolCallId: 'research-1',
        title: 'Task',
        rawInput: { prompt: 'investigate' },
      }),
    )
    normalizer.endTurn(session.id, { stopReason: 'end_turn' })
    const rows = replaySince(db, 0, [session.id]) as Array<{
      type: string
      content: string
    }>
    const results = rows.filter((row) => row.type === 'tool_result')
    expect(JSON.parse(results.at(-1)!.content).subagent.status).toBe('unknown')
  })

  it('closes unfinished tools at turn end with their call item', async () => {
    const { db, session } = fixture()
    const normalizer = new AcpNormalizer({ db })
    normalizer.beginTurn(session.id, 'unfinished-tool-turn')
    await normalizer.handle(
      notification(session.id, {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'Read',
        rawInput: { path: 'x' },
      }),
    )
    normalizer.endTurn(session.id, { stopReason: 'cancelled' })
    const rows = replaySince(db, 0, [session.id]) as Array<{
      type: string
      item_id: string
      content: string
    }>
    const result = rows.find((row) => row.type === 'tool_result')
    expect(result?.item_id).toBe('tool-1')
    expect(JSON.parse(result!.content)).toMatchObject({
      toolCallId: 'tool-1',
      isError: true,
    })
  })

  it('closes plan items immediately', async () => {
    const { db, session } = fixture()
    const normalizer = new AcpNormalizer({ db })
    normalizer.beginTurn(session.id, 'plan-turn')
    await normalizer.handle(
      notification(session.id, {
        sessionUpdate: 'plan',
        entries: [{ content: 'Read the file' }],
      }),
    )
    const rows = replaySince(db, 0, [session.id]) as Array<{
      type: string
      item_id: string
      content: string
    }>
    const planRows = rows.filter((row) => row.type.startsWith('tool_'))
    expect(planRows.map((row) => row.type)).toEqual([
      'tool_call',
      'tool_result',
    ])
    expect(planRows[0]?.item_id).toBe(planRows[1]?.item_id)
  })

  it('ignores malformed completion signals and finalizes them honestly', async () => {
    const { db, session } = fixture()
    const logger = { warn: vi.fn() }
    const normalizer = new AcpNormalizer({ db, logger })
    normalizer.beginTurn(session.id, 'malformed-turn')
    await normalizer.handle(
      notification(session.id, {
        sessionUpdate: 'tool_call',
        toolCallId: 'research-1',
        title: 'Task',
        rawInput: { prompt: 'investigate' },
      }),
    )
    await normalizer.handle(
      notification(session.id, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'research-1',
        status: 'completed',
        content: 'agent_id: missing fields',
      }),
    )
    normalizer.endTurn(session.id, { stopReason: 'end_turn' })
    expect(logger.warn).toHaveBeenCalled()
    const rows = replaySince(db, 0, [session.id]) as Array<{
      type: string
      content: string
    }>
    const result = rows.find((row) => row.type === 'tool_result')
    expect(JSON.parse(result!.content).subagent.status).toBe('unknown')
  })

  it('frames and coalesces text deltas into an exact replay', async () => {
    const { db, session } = fixture()
    const normalizer = new AcpNormalizer({ db, now: () => 1 })
    const turnId = normalizer.beginTurn(session.id, 'turn-1')
    await normalizer.handle(
      notification(session.id, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hel' },
      }),
    )
    await normalizer.handle(
      notification(session.id, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'lo' },
      }),
    )
    normalizer.endTurn(session.id, { stopReason: 'end_turn' })
    const rows = replaySince(db, 0, [session.id]) as Array<{
      type: string
      turn_id: string
      content: string
    }>
    expect(
      rows
        .filter((row) => row.type === 'text_delta')
        .map((row) => JSON.parse(row.content).text)
        .join(''),
    ).toBe('hello')
    expect(rows[0]?.type).toBe('turn_start')
    expect(rows.at(-1)?.type).toBe('turn_end')
    expect(rows.every((row) => row.turn_id === turnId)).toBe(true)
  })

  it('persists folded tool rows and drops unknown updates after interruption', async () => {
    const { db, session } = fixture()
    const logger = { warn: vi.fn() }
    const normalizer = new AcpNormalizer({ db, logger })
    normalizer.beginTurn(session.id, 'turn-2')
    await normalizer.handle(
      notification(session.id, {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'Read',
        rawInput: { path: 'x' },
      }),
    )
    await normalizer.handle(
      notification(session.id, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        status: 'completed',
        content: [],
      }),
    )
    await normalizer.handle(
      notification(session.id, { sessionUpdate: 'future_update' }),
    )
    normalizer.interrupt(session.id)
    await normalizer.handle(
      notification(session.id, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'late' },
      }),
    )
    const rows = replaySince(db, 0, [session.id]) as Array<{
      type: string
      item_id: string
    }>
    expect(
      rows.filter((row) => row.item_id === 'tool-1').map((row) => row.type),
    ).toEqual(['tool_call', 'tool_update', 'tool_result'])
    expect(rows.at(-1)?.type).toBe('turn_interrupted')
    expect(rows.some((row) => row.type === 'text_delta')).toBe(false)
    expect(logger.warn).toHaveBeenCalledWith(
      'Unknown ACP session update: future_update',
    )
  })

  it('splits a large chunk at the flush limit without changing its item', async () => {
    const { db, session } = fixture()
    const normalizer = new AcpNormalizer({ db })
    normalizer.beginTurn(session.id, 'turn-large')
    const text = 'x'.repeat(10_000)
    await normalizer.handle(
      notification(session.id, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
      }),
    )
    normalizer.flush(session.id, 'turn-large')
    const rows = replaySince(db, 0, [session.id]) as Array<{
      type: string
      item_id: string
      content: string
    }>
    const deltas = rows.filter((row) => row.type === 'text_delta')
    expect(deltas.length).toBe(5)
    expect(deltas.map((row) => JSON.parse(row.content).text).join('')).toBe(
      text,
    )
    expect(new Set(deltas.map((row) => row.item_id)).size).toBe(1)
  })

  it('keeps one item across timer flushes for delayed text deltas', async () => {
    vi.useFakeTimers()
    try {
      const { db, session } = fixture()
      const normalizer = new AcpNormalizer({ db })
      normalizer.beginTurn(session.id, 'turn-delayed')
      await normalizer.handle(
        notification(session.id, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hello ' },
        }),
      )
      await vi.advanceTimersByTimeAsync(501)
      await normalizer.handle(
        notification(session.id, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'world' },
        }),
      )
      normalizer.endTurn(session.id, { stopReason: 'end_turn' })
      const rows = replaySince(db, 0, [session.id]) as Array<{
        type: string
        item_id: string
        content: string
      }>
      const deltas = rows.filter((row) => row.type === 'text_delta')
      expect(deltas.map((row) => JSON.parse(row.content).text).join('')).toBe(
        'hello world',
      )
      expect(new Set(deltas.map((row) => row.item_id)).size).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts a new item after a tool call separates text', async () => {
    vi.useFakeTimers()
    const { db, session } = fixture()
    try {
      const normalizer = new AcpNormalizer({ db })
      normalizer.beginTurn(session.id, 'turn-separated')
      await normalizer.handle(
        notification(session.id, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'before' },
        }),
      )
      await vi.advanceTimersByTimeAsync(501)
      await normalizer.handle(
        notification(session.id, {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-1',
          title: 'Read',
          rawInput: { path: 'x' },
        }),
      )
      await normalizer.handle(
        notification(session.id, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'after' },
        }),
      )
      normalizer.endTurn(session.id, { stopReason: 'end_turn' })
      const rows = replaySince(db, 0, [session.id]) as Array<{
        type: string
        item_id: string
        content: string
      }>
      const deltas = rows.filter((row) => row.type === 'text_delta')
      expect(deltas.map((row) => JSON.parse(row.content).text)).toEqual([
        'before',
        'after',
      ])
      expect(deltas[0]?.item_id).not.toBe(deltas[1]?.item_id)
    } finally {
      vi.useRealTimers()
    }
  })
})
