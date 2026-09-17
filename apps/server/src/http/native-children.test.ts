import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { migrate } from '../db/migrate.js'
import { appendMessage, createSession } from '../db/queries.js'
import { nativeChildRoutes } from './native-children.js'

it('pages original child rows within the byte cap and refuses foreign and deleted parents', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    migrate(db)
    const session = createSession(db, {
      harness: 'grok',
      cwd: '/tmp',
      title: 'Parent',
    })
    const foreign = createSession(db, {
      harness: 'grok',
      cwd: '/tmp',
      title: 'Foreign',
    })
    for (let index = 0; index < 3; index++)
      appendMessage(db, {
        sessionId: session.id,
        turnId: 'root',
        itemId: `item-${index}`,
        role: 'agent',
        type: 'text_delta',
        content: {
          type: 'text_delta',
          text: 'x'.repeat(4 * 1024 * 1024),
          childId: 'original-child',
        },
      })
    const app = nativeChildRoutes(db)
    const url = `/api/sessions/${session.id}/native-children/original-child/messages`
    const first = await app.request(url)
    const firstText = await first.text()
    expect(Buffer.byteLength(firstText)).toBeLessThan(8 * 1024 * 1024)
    const page = JSON.parse(firstText)
    expect(page.messages).toHaveLength(1)
    expect(page.hasMore).toBe(true)
    const next = await (await app.request(`${url}?after=${page.cursor}`)).json()
    expect(next.messages).toHaveLength(1)
    expect(next.cursor).toBeGreaterThan(page.cursor)
    expect(
      (await app.request(url.replace(session.id, foreign.id))).status,
    ).toBe(404)
    expect((await app.request(`${url}?limit=201`)).status).toBe(400)
    db.prepare('UPDATE sessions SET deleted_at=1 WHERE id=?').run(session.id)
    expect((await app.request(url)).status).toBe(404)
  } finally {
    db.close()
  }
})
