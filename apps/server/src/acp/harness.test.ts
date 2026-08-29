import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
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
    const items: Array<{
      type: string
      text?: string
      itemId?: string
      turnId?: string
    }> = []
    const result = await process.spawn(
      { id: session.id, cwd: '/tmp', harness: 'mock' },
      (item) => items.push(item as { type: string; text?: string }),
      () => undefined,
    )
    handles.push(result)
    await result.prompt('hello')

    expect(items.filter((item) => item.type === 'text_delta')).toHaveLength(1)
    expect(items.filter((item) => item.type === 'turn_end')).toHaveLength(1)
    expect(items.every((item) => item.itemId && item.turnId)).toBe(true)
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

  it('publishes one Claude context frame after a completed turn', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const project = createProject(db, { name: 'test', path: '/tmp' })
    const session = createSession(db, {
      projectId: project.id,
      harness: 'claude',
      title: 'Chat',
      cwd: '/tmp',
      accountId: 'acct',
    })
    const homePath = await mkdtemp(join(tmpdir(), 'forge-claude-account-'))
    await mkdir(join(homePath, 'projects', '-tmp'), { recursive: true })
    await writeFile(
      join(homePath, 'projects', '-tmp', 'forge-mock-session.jsonl'),
      JSON.stringify({
        message: {
          role: 'assistant',
          usage: {
            input_tokens: 2,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 3,
            output_tokens: 1,
          },
        },
      }),
    )
    db.prepare(
      "INSERT INTO harness_accounts (id, harness_key, label, kind, home_path, created_at) VALUES ('acct', 'claude', 'Claude', 'claude', ?, 1)",
    ).run(homePath)
    const bus = new EventBus()
    const frames: unknown[] = []
    bus.subscribeEphemeral((event) => {
      if (event.type === 'contextWindow') frames.push(event)
    })
    const command = spawnMockAgent()
    const process = acpHarness(
      {
        name: 'claude',
        command: command.command,
        args: command.args,
        env: command.env as Record<string, string>,
        protocol: 'acp',
        enabled: true,
      },
      { db, bus, questions: new QuestionManager({ db }), accountId: 'acct' },
    )
    const handle = await process.spawn(
      { id: session.id, cwd: '/tmp', harness: 'claude' },
      () => undefined,
      () => undefined,
    )
    handles.push(handle)
    await handle.prompt('hello')

    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({
      type: 'contextWindow',
      sessionId: session.id,
    })
  })
})
