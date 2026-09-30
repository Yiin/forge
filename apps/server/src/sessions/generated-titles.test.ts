import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendMessage, createProject, createSession } from '../db/queries.js'
import { migrate } from '../db/migrate.js'
import { EventBus } from '../events/bus.js'
import { SessionTitler, type TitleGenerator } from './generated-titles.js'

const databases: DatabaseSync[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

function setup() {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  migrate(db)
  const project = createProject(db, { name: 'Project', path: '/tmp/project' })
  const session = createSession(db, {
    projectId: project.id,
    harness: 'fake',
    cwd: '/tmp/project',
    title: 'Fix the sidebar',
  })
  const say = (role: 'user' | 'agent', turnId: string, text: string) =>
    appendMessage(db, {
      sessionId: session.id,
      turnId,
      itemId: `${role}-${turnId}-${text.length}`,
      role,
      type: 'text_delta',
      content: { type: 'text_delta', text },
    })
  return { db, session, say, bus: new EventBus() }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('SessionTitler', () => {
  it('sends the opening request and the latest exchange, then saves the title', async () => {
    const { db, session, say, bus } = setup()
    say('user', 't1', 'The sidebar rows are hard to read')
    say('agent', 't1', 'Made them two lines.')
    say('user', 't2', 'Now add a settings page for titles')
    say('agent', 't2', 'Added the ')
    say('agent', 't2', 'titles page.')
    const generate = vi.fn<TitleGenerator>().mockResolvedValue('Title settings')
    const published = vi.spyOn(bus, 'publishEphemeral')
    new SessionTitler(db, bus, generate).request(session.id)
    await vi.waitFor(() => expect(published).toHaveBeenCalled())
    expect(generate).toHaveBeenCalledWith({
      kind: 'chat',
      current: 'Fix the sidebar',
      messages: [
        { role: 'user', text: 'The sidebar rows are hard to read' },
        { role: 'user', text: 'Now add a settings page for titles' },
        { role: 'assistant', text: 'Added the titles page.' },
      ],
    })
    expect(
      db.prepare('SELECT title FROM sessions WHERE id = ?').get(session.id),
    ).toEqual({ title: 'Title settings' })
  })

  it('never overwrites a title the user chose', async () => {
    const { db, session, say, bus } = setup()
    say('user', 't1', 'hello')
    db.prepare('UPDATE sessions SET user_titled = 1 WHERE id = ?').run(
      session.id,
    )
    const generate = vi.fn<TitleGenerator>().mockResolvedValue('Other')
    new SessionTitler(db, bus, generate).request(session.id)
    await settle()
    expect(generate).not.toHaveBeenCalled()
  })

  it('runs once more when a turn ends during a request', async () => {
    const { db, session, say, bus } = setup()
    say('user', 't1', 'hello')
    let release!: (value: string) => void
    const generate = vi
      .fn<TitleGenerator>()
      .mockImplementationOnce(
        () => new Promise<string>((resolve) => (release = resolve)),
      )
      .mockResolvedValue('Second title')
    const titler = new SessionTitler(db, bus, generate)
    titler.request(session.id)
    titler.request(session.id)
    titler.request(session.id)
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1))
    release('First title')
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2))
    await vi.waitFor(() =>
      expect(
        db.prepare('SELECT title FROM sessions WHERE id = ?').get(session.id),
      ).toEqual({ title: 'Second title' }),
    )
  })
})
