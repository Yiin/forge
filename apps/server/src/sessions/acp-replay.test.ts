import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { migrate } from '../db/migrate.js'
import { createSession } from '../db/queries.js'
import { projectAcpReplay } from './acp-replay.js'
import type {
  AcpReplayOwner,
  AcpReplayEventBody,
} from '../harnesses/acp/ingestion.js'

it('deduplicates native tool identity across changed snapshots without hiding unseen history', () => {
  const db = new DatabaseSync(':memory:')
  try {
    migrate(db)
    const session = createSession(db, {
      harness: 'custom',
      cwd: '/tmp',
      title: 'Replay',
    })
    const base = {
      sessionId: session.id,
      providerInstanceId: 'custom',
      account: { kind: 'native-default' as const, configurationId: 'custom' },
      runtimeGeneration: 'generation',
      phase: 'load_replay' as const,
      binding: {
        provider: 'custom',
        accountId: null,
        cwd: '/tmp',
        providerSessionId: 'native',
      },
      requestedNativeSessionId: 'native',
    }
    let seq = 0
    const load = (
      id: string,
      text: string,
      status: 'in_progress' | 'completed',
    ) => {
      const owner: AcpReplayOwner = { ...base, loadId: id }
      const events: AcpReplayEventBody[] = [
        {
          type: 'tool_started',
          itemId: `${id}-local-tool`,
          toolCallId: 'original-native-tool',
          name: 'shell',
          input: { command: 'echo original' },
        },
        {
          type: 'tool_update',
          itemId: `${id}-local-tool`,
          toolCallId: 'original-native-tool',
          status,
          output: status === 'completed' ? 'done' : undefined,
        },
        { type: 'text_delta', itemId: `${id}-local-text`, text },
      ]
      for (const event of events) {
        seq++
        db.prepare('INSERT INTO acp_records VALUES (?,?,?,?,?)').run(
          `record-${seq}`,
          session.id,
          seq,
          0,
          JSON.stringify({
            owner,
            subject: {},
            value: { kind: 'replay', event },
          }),
        )
      }
      db.exec('BEGIN')
      try {
        const result = projectAcpReplay(db, owner)
        db.exec('COMMIT')
        return result
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }
    load('first', 'Old history', 'in_progress')
    load('second', 'Unseen history', 'in_progress')
    expect(
      db
        .prepare("SELECT count(*) AS n FROM messages WHERE type='tool_call'")
        .get(),
    ).toEqual({ n: 1 })
    expect(
      db
        .prepare(
          "SELECT count(*) AS n FROM messages WHERE json_extract(content,'$.text')='Unseen history'",
        )
        .get(),
    ).toEqual({ n: 1 })
    load('third', 'Unseen history', 'completed')
    const tools = db
      .prepare(
        "SELECT DISTINCT turn_id,item_id FROM messages WHERE type IN ('tool_call','tool_update')",
      )
      .all()
    expect(tools).toHaveLength(1)
    expect(
      db
        .prepare(
          "SELECT count(*) AS n FROM messages WHERE json_extract(content,'$.status')='completed'",
        )
        .get(),
    ).toEqual({ n: 1 })
    const before = db.prepare('SELECT count(*) AS n FROM messages').get()
    load('fourth', 'Unseen history', 'completed')
    expect(db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual(
      before,
    )
  } finally {
    db.close()
  }
})

it('preserves delta-only native child identity and requires committed live message proof', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    migrate(db)
    const session = createSession(db, {
      harness: 'custom',
      cwd: '/tmp',
      title: 'Child replay',
    })
    const binding = {
      provider: 'custom',
      accountId: null,
      cwd: '/tmp',
      providerSessionId: 'native',
    }
    const owner: AcpReplayOwner = {
      sessionId: session.id,
      providerInstanceId: 'custom',
      account: { kind: 'native-default', configurationId: 'custom' },
      runtimeGeneration: 'generation',
      phase: 'load_replay',
      binding,
      requestedNativeSessionId: 'native',
      loadId: 'first',
    }
    const event = {
      type: 'text_delta',
      itemId: 'original-item',
      providerItemId: 'native-item',
      text: 'Child only',
      childId: 'child',
    } as const
    const subject = {
      itemId: 'original-item',
      childId: 'child',
      intervalId: 'interval',
    }
    const insert = (id: string, record: unknown) =>
      db
        .prepare('INSERT INTO acp_records VALUES (?,?,?,?,?)')
        .run(id, session.id, Number(id), 0, JSON.stringify(record))
    const liveEvent = {
      ...event,
      runId: 'original-run',
      turnId: 'original-turn',
      runtimeGeneration: 'generation',
      deliveryId: 'delivery',
    }
    insert('1', {
      owner: {
        ...owner,
        phase: 'live',
        runId: 'original-run',
        turnId: 'original-turn',
      },
      subject,
      value: { kind: 'event', event: liveEvent },
    })
    insert('2', { owner, subject, value: { kind: 'replay', event } })
    const imported = projectAcpReplay(db, owner)
    expect(imported).toHaveLength(1)
    expect(imported[0]!.content).toMatchObject({
      type: 'content_snapshot',
      childId: 'child',
      text: 'Child only',
    })
    expect(
      imported.filter(
        (message) =>
          !(
            typeof message.content === 'object' &&
            message.content !== null &&
            'childId' in message.content
          ),
      ),
    ).toHaveLength(0)
    const { nativeChildRoutes } = await import('../http/native-children.js')
    const response = await nativeChildRoutes(db).request(
      `/api/sessions/${session.id}/native-children/child/messages`,
    )
    expect(response.status).toBe(200)
    expect((await response.json()).messages[0].content.childId).toBe('child')
    // The durable journal alone was insufficient. Add its original committed message now.
    const { appendMessage } = await import('../db/queries.js')
    appendMessage(db, {
      sessionId: session.id,
      turnId: 'original-turn',
      itemId: 'original-item',
      role: 'agent',
      type: 'text_delta',
      content: { type: 'text_delta', text: 'Child only', childId: 'child' },
    })
    const next = { ...owner, loadId: 'second' }
    insert('3', { owner: next, subject, value: { kind: 'replay', event } })
    insert('4', {
      owner: next,
      subject: {},
      value: {
        kind: 'replay',
        event: { type: 'text_delta', itemId: 'unseen', text: 'Unseen' },
      },
    })
    const second = projectAcpReplay(db, next)
    expect(second).toHaveLength(1)
    expect(second[0]!.content).toMatchObject({ text: 'Unseen' })
  } finally {
    db.close()
  }
})

it('rejects replay UTF-8 bytes above the bound before parsing records', () => {
  const db = new DatabaseSync(':memory:')
  try {
    migrate(db)
    const session = createSession(db, {
      harness: 'custom',
      cwd: '/tmp',
      title: 'Byte bound',
    })
    const owner = {
      sessionId: session.id,
      loadId: 'load',
      runtimeGeneration: 'generation',
    } as AcpReplayOwner
    const value = JSON.stringify({
      owner,
      value: { kind: 'replay', event: { text: '界'.repeat(12 * 1024 * 1024) } },
    })
    db.prepare('INSERT INTO acp_records VALUES (?,?,?,?,?)').run(
      'large',
      session.id,
      1,
      0,
      value,
    )
    expect(() => projectAcpReplay(db, owner)).toThrow(
      'projection exceeds limit',
    )
  } finally {
    db.close()
  }
})

it('reuses the proved live tool turn and item for a later native status', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    migrate(db)
    const session = createSession(db, {
      harness: 'custom',
      cwd: '/tmp',
      title: 'Live tool',
    })
    const binding = {
      provider: 'custom',
      accountId: null,
      cwd: '/tmp',
      providerSessionId: 'native',
    }
    const owner: AcpReplayOwner = {
      sessionId: session.id,
      providerInstanceId: 'custom',
      account: { kind: 'native-default', configurationId: 'custom' },
      runtimeGeneration: 'generation',
      phase: 'load_replay',
      binding,
      requestedNativeSessionId: 'native',
      loadId: 'first',
    }
    const start = {
      type: 'tool_started',
      itemId: 'live-item',
      toolCallId: 'native-tool',
      name: 'shell',
      input: { command: 'echo ok' },
    } as const
    const update = {
      type: 'tool_update',
      itemId: 'live-item',
      toolCallId: 'native-tool',
      status: 'in_progress',
    } as const
    const { nativeItem } = await import('./native.js')
    const { appendMessage } = await import('../db/queries.js')
    let seq = 0
    const insert = (record: unknown) => {
      seq++
      db.prepare('INSERT INTO acp_records VALUES (?,?,?,?,?)').run(
        String(seq),
        session.id,
        seq,
        0,
        JSON.stringify(record),
      )
    }
    for (const body of [start, update]) {
      const event = {
        ...body,
        runId: 'live-run',
        turnId: 'live-turn',
        runtimeGeneration: 'generation',
        deliveryId: String(seq),
      }
      insert({
        owner: {
          ...owner,
          phase: 'live',
          runId: 'live-run',
          turnId: 'live-turn',
        },
        subject: { itemId: 'live-item' },
        value: { kind: 'event', event },
      })
      const { itemId: _item, turnId: _turn, ...content } = nativeItem(event)!
      appendMessage(db, {
        sessionId: session.id,
        turnId: 'live-turn',
        itemId: 'live-item',
        role: 'agent',
        type: content.type,
        content,
      })
    }
    for (const event of [start, update])
      insert({
        owner,
        subject: { itemId: 'live-item' },
        value: { kind: 'replay', event: { ...event, itemId: 'replay-local' } },
      })
    expect(projectAcpReplay(db, owner)).toHaveLength(0)
    const next = { ...owner, loadId: 'second' }
    for (const event of [
      start,
      { ...update, status: 'completed', output: 'ok' },
    ])
      insert({
        owner: next,
        subject: { itemId: 'replay-local' },
        value: { kind: 'replay', event: { ...event, itemId: 'replay-local' } },
      })
    const changed = projectAcpReplay(db, next)
    expect(changed).toHaveLength(2)
    for (const message of changed) {
      expect(message.turnId).toBe('live-turn')
      expect(message.itemId).toBe('live-item')
      expect(message.content).not.toHaveProperty('itemId')
      expect(message.content).not.toHaveProperty('turnId')
    }
    expect(changed[1]!.content).toMatchObject({
      status: 'completed',
      output: 'ok',
    })
  } finally {
    db.close()
  }
})
