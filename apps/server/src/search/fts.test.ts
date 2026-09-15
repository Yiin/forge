import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { migrate } from '../db/migrate.js'
import { createProject, createSession, appendMessage } from '../db/queries.js'
import { searchRoutes } from '../http/search.js'

function fixture() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, project_id TEXT);
    CREATE TABLE messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, item_id TEXT,
      type TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER
    );
    CREATE TABLE epic_runs (
      id TEXT PRIMARY KEY, title TEXT, epic_bead_id TEXT, error TEXT, status TEXT
    );
    INSERT INTO sessions VALUES ('ses-1', 'Garden notes', 'project');
    INSERT INTO epic_runs VALUES ('run-1', 'Garden run', 'forge-1', 'green garden', 'failed');
    INSERT INTO messages (session_id, item_id, type, content) VALUES
      ('ses-1', 'item-final', 'text', '{"text":"Plant basil in the garden"}'),
      ('ses-1', 'item-delta', 'text_delta', '{"text":"Plant basil"}'),
      ('ses-1', 'item-tool', 'tool_result', '{"output":"Garden command finished"}');
  `)
  const app = searchRoutes(db)
  return { db, app }
}

describe('FTS5 search', () => {
  it('indexes finalized text, groups hits, and includes marks', async () => {
    const { db, app } = fixture()
    const response = await app.request('/api/search?q=gard')
    expect(response.status).toBe(200)
    const result = (await response.json()) as {
      sessions: unknown[]
      messages: Array<{ itemId: string; snippet: string }>
      runs: unknown[]
    }
    expect(result.sessions).toHaveLength(1)
    expect(new Set(result.messages.map((hit) => hit.itemId))).toEqual(
      new Set(['item-final', 'item-tool']),
    )
    expect(result.messages[0].snippet).toContain('<mark>')
    expect(result.runs).toHaveLength(1)
    expect(
      (
        db.prepare('SELECT count(*) AS count FROM messages_fts').get() as {
          count: number
        }
      ).count,
    ).toBe(2)
  })

  it('handles malformed MATCH input and empty queries', async () => {
    const { app } = fixture()
    const malformed = await app.request('/api/search?q=a%22%20OR%20b')
    expect(malformed.status).toBe(200)
    expect(await malformed.json()).toEqual({
      sessions: [],
      messages: [],
      runs: [],
    })
    const empty = await app.request('/api/search?q=')
    expect(empty.status).toBe(200)
    expect(await empty.json()).toEqual({ sessions: [], messages: [], runs: [] })
  })

  it('keeps session title updates searchable', async () => {
    const { db, app } = fixture()
    db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(
      'Kitchen plans',
      'ses-1',
    )
    const response = await app.request('/api/search?q=kitch')
    expect((await response.json()).sessions).toHaveLength(1)
  })
})

it('returns marked snippets from migrated indexes and preserves history on replay', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    migrate(db)
    const project = createProject(db, { name: 'search', path: '/tmp' })
    const session = createSession(db, {
      projectId: project.id,
      harness: 'mock',
      title: 'Garden history',
      cwd: '/tmp',
    })
    appendMessage(db, {
      sessionId: session.id,
      turnId: 'turn',
      itemId: 'item',
      role: 'agent',
      type: 'text_delta',
      content: { type: 'text_delta', text: 'A garden with basil' },
    })
    appendMessage(db, {
      sessionId: session.id,
      turnId: 'turn',
      itemId: 'end',
      role: 'system',
      type: 'turn_end',
      content: { type: 'turn_end' },
    })
    const app = searchRoutes(db)
    const verify = async () => {
      const result = await (await app.request('/api/search?q=garden')).json()
      expect(result.sessions).toHaveLength(1)
      expect(result.sessions[0].snippet).toContain('<mark>Garden</mark>')
      expect(result.messages).toHaveLength(1)
      expect(result.messages[0].snippet).toContain('<mark>garden</mark>')
    }
    await verify()
    db.prepare('DELETE FROM schema_migrations WHERE name=?').run(
      '0029_search_snippet_content.sql',
    )
    migrate(db)
    await verify()
    expect(db.prepare('SELECT count(*) AS n FROM messages').get()?.n).toBe(2)
  } finally {
    db.close()
  }
})

it('searches authoritative snapshots and visible replay with original item anchors', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    migrate(db)
    const session = createSession(db, {
      harness: 'custom',
      cwd: '/tmp',
      title: 'Authoritative',
    })
    const add = (itemId: string, type: string, content: unknown) =>
      appendMessage(db, {
        sessionId: session.id,
        turnId: 'turn',
        itemId,
        role: 'agent',
        type,
        content,
      })
    const original = add('parent', 'text_delta', { text: 'obsoleteword' })
    const child = add('parent', 'text_delta', {
      text: 'oldchild',
      childId: 'native-child',
    })
    add('parent', 'content_snapshot', {
      contentType: 'text',
      text: 'authoritativeword',
    })
    add('parent', 'content_snapshot', {
      contentType: 'text',
      text: 'childword',
      childId: 'native-child',
    })
    add('parent', 'text_delta', { text: ' appendedword' })
    add('thought', 'content_snapshot', {
      contentType: 'thought',
      text: 'privateword',
    })
    add('end', 'turn_end', {})
    const app = searchRoutes(db)
    const hits = async (q: string) =>
      (await (await app.request(`/api/search?q=${q}&scope=messages`)).json())
        .messages
    expect(await hits('obsoleteword')).toHaveLength(0)
    expect(await hits('oldchild')).toHaveLength(0)
    expect(await hits('privateword')).toHaveLength(0)
    expect(await hits('authoritativeword')).toMatchObject([
      { seq: original.seq, itemId: 'parent' },
    ])
    expect(await hits('appendedword')).toMatchObject([
      { seq: original.seq, itemId: 'parent' },
    ])
    expect(await hits('childword')).toMatchObject([
      { seq: child.seq, itemId: 'parent' },
    ])
    const before = db
      .prepare('SELECT rowid,text FROM messages_fts ORDER BY rowid')
      .all()
    db.prepare(
      "DELETE FROM schema_migrations WHERE name='0030_authoritative_search.sql'",
    ).run()
    migrate(db)
    expect(
      db.prepare('SELECT rowid,text FROM messages_fts ORDER BY rowid').all(),
    ).toEqual(before)
    const { projectAcpReplay } = await import('../sessions/acp-replay.js')
    const owner = {
      sessionId: session.id,
      providerInstanceId: 'custom',
      account: { kind: 'native-default' as const, configurationId: 'custom' },
      runtimeGeneration: 'generation',
      phase: 'load_replay' as const,
      loadId: 'load',
      requestedNativeSessionId: 'native',
      binding: {
        provider: 'custom',
        accountId: null,
        cwd: '/tmp',
        providerSessionId: 'native',
      },
    }
    db.prepare('INSERT INTO acp_records VALUES (?,?,?,?,?)').run(
      'replay',
      session.id,
      1,
      0,
      JSON.stringify({
        owner,
        subject: {},
        value: {
          kind: 'replay',
          event: {
            type: 'text_delta',
            itemId: 'native-text',
            text: 'replayword',
          },
        },
      }),
    )
    db.exec('BEGIN')
    projectAcpReplay(db, owner)
    db.exec('COMMIT')
    expect(await hits('replayword')).toHaveLength(1)
    expect(
      db
        .prepare(
          "SELECT count(*) AS n FROM messages WHERE turn_id LIKE 'acp-import:%' AND type='turn_end'",
        )
        .get(),
    ).toEqual({ n: 0 })
    add('parent', 'content_snapshot', { contentType: 'text', text: '' })
    expect(await hits('authoritativeword')).toHaveLength(0)
  } finally {
    db.close()
  }
})

it('removes derived rows before SQLite can reuse original row identities', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    migrate(db)
    const first = createSession(db, {
      harness: 'custom',
      cwd: '/tmp',
      title: 'oldsessionword',
    })
    const rowid = (
      db.prepare('SELECT rowid FROM sessions WHERE id=?').get(first.id) as {
        rowid: number
      }
    ).rowid
    db.prepare('DELETE FROM sessions WHERE id=?').run(first.id)
    const next = createSession(db, {
      harness: 'custom',
      cwd: '/tmp',
      title: 'newsessionword',
    })
    expect(
      db.prepare('SELECT rowid FROM sessions WHERE id=?').get(next.id),
    ).toEqual({ rowid })
    const message = appendMessage(db, {
      sessionId: next.id,
      turnId: 'turn',
      itemId: 'item',
      role: 'agent',
      type: 'tool_result',
      content: { output: 'oldmessageword' },
    })
    db.prepare('DELETE FROM messages WHERE seq=?').run(message.seq)
    const project = createProject(db, {
      name: 'epic',
      path: '/tmp/epic-search',
    })
    const insertEpic = db.prepare(
      "INSERT INTO epic_runs(id,project_id,epic_bead_id,status,mode,worker_count,base_branch,config,started_at) VALUES (?,?,?,'running','serial',1,'main','{}',1)",
    )
    insertEpic.run('old-run', project.id, 'oldepicword')
    const oldRun = db
      .prepare('SELECT rowid FROM epic_runs WHERE id=?')
      .get('old-run')
    db.prepare('DELETE FROM epic_runs WHERE id=?').run('old-run')
    insertEpic.run('new-run', project.id, 'newepicword')
    expect(
      db.prepare('SELECT rowid FROM epic_runs WHERE id=?').get('new-run'),
    ).toEqual(oldRun)
    const app = searchRoutes(db)
    expect((await app.request('/api/search?q=oldepicword')).status).toBe(200)
    expect(
      (await (await app.request('/api/search?q=oldepicword')).json()).runs,
    ).toHaveLength(0)
    expect(
      (await (await app.request('/api/search?q=newepicword')).json()).runs,
    ).toHaveLength(1)
    expect(
      (await (await app.request('/api/search?q=oldsessionword')).json())
        .sessions,
    ).toHaveLength(0)
    expect(
      (await (await app.request('/api/search?q=newsessionword')).json())
        .sessions,
    ).toHaveLength(1)
    expect(
      db
        .prepare('SELECT rowid FROM messages_fts WHERE rowid=?')
        .get(message.seq),
    ).toBeUndefined()
  } finally {
    db.close()
  }
})
