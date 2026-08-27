import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrate } from '../db/migrate.js'
import { createProject, createSession } from '../db/queries.js'
import { EventBus } from '../events/bus.js'
import { QuestionManager } from './questions.js'
import { acpHarness } from './harness.js'
import { spawnMockAgent } from '../../test/helpers/mock-agent.js'

describe('ACP harness adapter', () => {
  const handles: Array<{ kill(): Promise<void> | void }> = []

  afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.kill()
  })

  it('streams normalized messages and persists the provider session', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const project = createProject(db, { name: 'test', path: '/tmp' })
    const session = createSession(db, {
      projectId: project.id,
      harness: 'mock',
      title: 'Chat',
      cwd: '/tmp',
    })
    const command = spawnMockAgent()
    const process = acpHarness(
      {
        name: 'mock',
        command: command.command,
        args: command.args,
        env: command.env as Record<string, string>,
        protocol: 'acp',
        enabled: true,
      },
      { db, bus: new EventBus(), questions: new QuestionManager({ db }) },
    )
    const items: Array<{ type: string; text?: string }> = []
    const result = await process.spawn(
      { id: session.id, cwd: '/tmp', harness: 'mock' },
      (item) => items.push(item as { type: string; text?: string }),
      () => undefined,
    )
    handles.push(result)
    await result.prompt('hello')

    expect(items.filter((item) => item.type === 'text_delta')).toHaveLength(1)
    expect(items.filter((item) => item.type === 'turn_end')).toHaveLength(1)
    expect(
      db
        .prepare('SELECT provider_session_id FROM sessions WHERE id = ?')
        .get(session.id),
    ).toMatchObject({ provider_session_id: 'forge-mock-session' })
  })

  it('uses the session cwd for every ACP lifecycle operation', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const project = createProject(db, { name: 'test', path: '/tmp' })
    const cwd = await mkdtemp(join(tmpdir(), 'forge-acp-harness-'))
    const requestLogPath = join(cwd, 'requests.jsonl')
    const command = spawnMockAgent({
      ADVERTISE_SESSION_FORK: '1',
      REQUEST_LOG_PATH: requestLogPath,
    })
    const process = acpHarness(
      {
        name: 'mock',
        command: command.command,
        args: command.args,
        env: command.env as Record<string, string>,
        protocol: 'acp',
        enabled: true,
      },
      { db, bus: new EventBus(), questions: new QuestionManager({ db }) },
    )
    const makeSession = (providerSessionId?: string) => {
      const session = createSession(db, {
        projectId: project.id,
        harness: 'mock',
        title: 'Chat',
        cwd,
      })
      return { id: session.id, cwd, harness: 'mock', providerSessionId }
    }
    const onItem = () => undefined
    const onExit = () => undefined

    const spawned = await process.spawn(makeSession(), onItem, onExit)
    handles.push(spawned)
    const created = await process.newSession!(makeSession(), onItem, onExit)
    handles.push(created.handle)
    const loaded = await process.loadSession!(
      makeSession('forge-mock-session'),
      onItem,
      onExit,
    )
    handles.push(loaded.handle)
    const forked = await process.fork!(
      makeSession('forge-mock-session'),
      onItem,
      onExit,
    )
    handles.push(forked.handle)

    const lines = (await readFile(requestLogPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { params?: { processCwd?: string } })
    expect(
      lines
        .filter((line) => line.params?.processCwd)
        .map((line) => line.params?.processCwd),
    ).toEqual([cwd, cwd, cwd, cwd])
  })
})
