import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
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
