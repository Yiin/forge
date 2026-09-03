import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { migrate } from '../db/migrate.js'
import { createProject, createSession } from '../db/queries.js'
import { EventBus } from '../events/bus.js'
import { SessionManager } from './manager.js'
import type { HarnessFactory, HarnessHandle } from './harness.js'

describe('session harness selection', () => {
  it('uses the client item id for the user text row', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const project = createProject(db, { name: 'test', path: '/tmp' })
    const session = createSession(db, {
      projectId: project.id,
      harness: 'mock',
      title: 'Chat',
      cwd: '/tmp',
    })
    const manager = new SessionManager(db, new EventBus(), () => ({
      spawn: async () => ({
        prompt: async () => undefined,
        cancel: () => undefined,
        kill: () => undefined,
      }),
    }))
    await manager.prompt(
      session.id,
      'hello',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'client_1234567890abcdef1234567890abcdef',
    )
    expect(
      db
        .prepare(
          "SELECT item_id FROM messages WHERE session_id = ? AND type = 'text_delta'",
        )
        .get(session.id),
    ).toEqual({ item_id: 'client_1234567890abcdef1234567890abcdef' })
    manager.close()
  })

  it('changes and persists the ACP model before the prompt', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const project = createProject(db, { name: 'test', path: '/tmp' })
    const session = createSession(db, {
      projectId: project.id,
      harness: 'mock',
      title: 'Chat',
      cwd: '/tmp',
    })
    const calls: string[] = []
    const manager = new SessionManager(db, new EventBus(), () => ({
      spawn: async () => ({
        availableModels: [{ id: 'fast', displayName: 'Fast' }],
        prompt: async () => {
          calls.push('prompt')
        },
        setModel: async (model) => {
          calls.push(`model:${model}`)
        },
        cancel: () => undefined,
        kill: () => undefined,
      }),
    }))

    await manager.prompt(
      session.id,
      'hello',
      undefined,
      undefined,
      undefined,
      undefined,
      'fast',
    )
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(calls).toEqual(['model:fast', 'prompt'])
    expect(
      db.prepare('SELECT model FROM sessions WHERE id = ?').get(session.id),
    ).toEqual({ model: 'fast' })
    expect(manager.models(session.id)).toEqual([
      { id: 'fast', displayName: 'Fast' },
    ])
  })

  it('persists harness item and turn ids for one logical turn', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const project = createProject(db, { name: 'test', path: '/tmp' })
    const session = createSession(db, {
      projectId: project.id,
      harness: 'mock',
      title: 'Chat',
      cwd: '/tmp',
    })
    const factory: HarnessFactory = () => ({
      spawn: async (_session, onItem) => ({
        prompt: () => {
          onItem({
            type: 'tool_call',
            itemId: 'tool-1',
            turnId: 'turn-1',
            toolCallId: 'tool-1',
            name: 'Read',
            input: { path: 'x' },
          })
          onItem({
            type: 'tool_update',
            itemId: 'tool-1',
            turnId: 'turn-1',
            toolCallId: 'tool-1',
            status: 'completed',
          })
          onItem({
            type: 'text_delta',
            itemId: 'text-1',
            turnId: 'turn-1',
            text: 'hello ',
          })
          onItem({
            type: 'text_delta',
            itemId: 'text-1',
            turnId: 'turn-1',
            text: 'world',
          })
          onItem({ type: 'turn_end', itemId: 'end-1', turnId: 'turn-1' })
        },
        cancel: () => undefined,
        kill: () => undefined,
      }),
    })
    const manager = new SessionManager(db, new EventBus(), factory)

    await manager.prompt(session.id, 'one')
    await new Promise<void>((resolve) => setImmediate(resolve))

    const rows = db
      .prepare(
        "SELECT type, item_id, turn_id FROM messages WHERE session_id = ? AND role = 'agent' AND type IN ('tool_call', 'tool_update', 'text_delta') ORDER BY seq",
      )
      .all(session.id) as Array<{
      type: string
      item_id: string
      turn_id: string
    }>
    expect(rows.map((row) => row.item_id)).toEqual([
      'tool-1',
      'tool-1',
      'text-1',
      'text-1',
    ])
    expect(new Set(rows.map((row) => row.turn_id))).toEqual(new Set(['turn-1']))
  })

  it('leaves the running turn intact when an immediate prompt is rejected', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const project = createProject(db, { name: 'test', path: '/tmp' })
    const session = createSession(db, {
      projectId: project.id,
      harness: 'mock',
      title: 'Chat',
      cwd: '/tmp',
    })
    let release!: () => void
    const manager = new SessionManager(db, new EventBus(), () => ({
      spawn: async () => ({
        prompt: () => new Promise<void>((resolve) => (release = resolve)),
        cancel: () => undefined,
        kill: () => undefined,
      }),
    }))

    await manager.prompt(session.id, 'one')
    await expect(manager.prompt(session.id, 'two')).rejects.toThrow(
      'already running',
    )
    expect(
      db
        .prepare(
          "SELECT type FROM messages WHERE session_id = ? AND type IN ('turn_start', 'turn_interrupted', 'error')",
        )
        .all(session.id),
    ).toEqual([{ type: 'turn_start' }])

    release()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(
      db
        .prepare(
          "SELECT type FROM messages WHERE session_id = ? AND type IN ('turn_start', 'turn_end') ORDER BY seq",
        )
        .all(session.id),
    ).toEqual([{ type: 'turn_start' }, { type: 'turn_end' }])
    manager.close()
  })

  it('rejects a harness without a managed account', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const project = createProject(db, { name: 'test', path: '/tmp' })
    const manager = new SessionManager(db, new EventBus(), () => ({
      spawn: async () => {
        throw new Error('should not spawn')
      },
    }))

    expect(() =>
      manager.create({ projectId: project.id, harness: 'claude', cwd: '/tmp' }),
    ).toThrow('This harness has no account')
  })

  it('allows a kind-less harness to run without an account', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const project = createProject(db, { name: 'test', path: '/tmp' })
    const manager = new SessionManager(
      db,
      new EventBus(),
      () => ({
        spawn: async () => {
          throw new Error('should not spawn')
        },
      }),
      undefined,
      () => false,
    )

    const session = manager.create({
      projectId: project.id,
      harness: 'mock',
      cwd: '/tmp',
    })
    expect(session.accountId).toBeNull()
  })

  it('records a usage limit from a failed prompt', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const project = createProject(db, { name: 'test', path: '/tmp' })
    db.prepare(
      "INSERT INTO harness_accounts (id, harness_key, label, kind, home_path, created_at) VALUES ('acct', 'claude', 'Test', 'claude', '/tmp/acct', 1)",
    ).run()
    const session = createSession(db, {
      projectId: project.id,
      harness: 'claude',
      title: 'Chat',
      cwd: '/tmp',
      accountId: 'acct',
    })
    const factory: HarnessFactory = () => ({
      spawn: async () => ({
        prompt: async () => {
          throw new Error('Claude AI usage limit reached')
        },
        cancel: () => undefined,
        kill: () => undefined,
      }),
    })
    const manager = new SessionManager(db, new EventBus(), factory)
    await manager.prompt(session.id, 'one')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(
      db.prepare('SELECT account_id, kind FROM harness_account_limits').get(),
    ).toMatchObject({ account_id: 'acct', kind: 'usage-limit' })
    expect(
      db
        .prepare(
          'SELECT type, content FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT 1',
        )
        .get(session.id),
    ).toMatchObject({ type: 'error' })
    expect(
      db.prepare('SELECT status FROM sessions WHERE id = ?').get(session.id),
    ).toEqual({ status: 'errored' })
  })

  it('accepts a prompt before an asynchronous turn ends', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const project = createProject(db, { name: 'test', path: '/tmp' })
    const session = createSession(db, {
      projectId: project.id,
      harness: 'mock',
      title: 'Chat',
      cwd: '/tmp',
    })
    let resolvePrompt!: () => void
    const promptStarted = new Promise<void>((resolve) => {
      resolvePrompt = resolve
    })
    const manager = new SessionManager(db, new EventBus(), () => ({
      spawn: async () => ({
        prompt: () => promptStarted,
        cancel: () => undefined,
        kill: () => undefined,
      }),
    }))

    await manager.prompt(session.id, 'one', 'request-1')

    expect(
      db
        .prepare(
          "SELECT type FROM messages WHERE session_id = ? AND type = 'turn_start'",
        )
        .get(session.id),
    ).toEqual({ type: 'turn_start' })
    expect(
      db.prepare('SELECT status FROM sessions WHERE id = ?').get(session.id),
    ).toEqual({ status: 'running' })

    resolvePrompt()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(
      db
        .prepare(
          "SELECT type FROM messages WHERE session_id = ? AND type = 'turn_end'",
        )
        .get(session.id),
    ).toEqual({ type: 'turn_end' })
  })

  it('queues boundary prompts and drains one oldest prompt after each turn', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const project = createProject(db, { name: 'test', path: '/tmp' })
    const session = createSession(db, {
      projectId: project.id,
      harness: 'mock',
      title: 'Chat',
      cwd: '/tmp',
    })
    let release!: () => void
    let calls = 0
    const prompts: string[] = []
    const manager = new SessionManager(db, new EventBus(), () => ({
      spawn: async () => ({
        prompt: (content) => {
          prompts.push(
            typeof content === 'string'
              ? content
              : (content.find((item) => item.kind === 'text')?.text ?? ''),
          )
          calls += 1
          if (calls === 1)
            return new Promise<void>((resolve) => {
              release = resolve
            })
          return Promise.resolve()
        },
        cancel: () => undefined,
        kill: () => undefined,
      }),
    }))

    await manager.prompt(session.id, 'one', 'request-1')
    await manager.prompt(
      session.id,
      'two',
      'request-2',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'turn-boundary',
    )
    await manager.prompt(
      session.id,
      'three',
      'request-3',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'turn-boundary',
    )

    expect(prompts).toEqual(['one'])
    expect(
      db
        .prepare(
          'SELECT text FROM queued_prompts WHERE session_id = ? ORDER BY created_at, id',
        )
        .all(session.id),
    ).toEqual([{ text: 'two' }, { text: 'three' }])
    release()
    await new Promise<void>((resolve) => setImmediate(resolve))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(prompts).toEqual(['one', 'two'])
    expect(
      db
        .prepare('SELECT text FROM queued_prompts WHERE session_id = ?')
        .all(session.id),
    ).toEqual([{ text: 'three' }])
  })

  it('drains a queued prompt after the active prompt fails', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const project = createProject(db, { name: 'test', path: '/tmp' })
    const session = createSession(db, {
      projectId: project.id,
      harness: 'mock',
      title: 'Chat',
      cwd: '/tmp',
    })
    let calls = 0
    const prompts: string[] = []
    const manager = new SessionManager(db, new EventBus(), () => ({
      spawn: async () => ({
        prompt: async (content) => {
          prompts.push(
            typeof content === 'string'
              ? content
              : (content.find((item) => item.kind === 'text')?.text ?? ''),
          )
          calls += 1
          if (calls === 1) throw new Error('failed')
        },
        cancel: () => undefined,
        kill: () => undefined,
      }),
    }))
    await manager.prompt(session.id, 'one')
    await manager.prompt(
      session.id,
      'two',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'turn-boundary',
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(prompts).toEqual(['one', 'two'])
    expect(
      db.prepare('SELECT count(*) AS count FROM queued_prompts').get(),
    ).toEqual({ count: 0 })
  })

  it('publishes user rows before a cold harness finishes spawning', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const project = createProject(db, { name: 'test', path: '/tmp' })
    const session = createSession(db, {
      projectId: project.id,
      harness: 'mock',
      title: 'Chat',
      cwd: '/tmp',
    })
    const spawnStarted = new Promise<never>(() => undefined)
    const manager = new SessionManager(db, new EventBus(), () => ({
      spawn: async () => spawnStarted,
    }))

    await manager.prompt(session.id, 'hello')

    expect(
      db
        .prepare('SELECT type FROM messages WHERE session_id = ? ORDER BY seq')
        .all(session.id),
    ).toEqual([{ type: 'turn_start' }, { type: 'text_delta' }])
    expect(
      db.prepare('SELECT status FROM sessions WHERE id = ?').get(session.id),
    ).toEqual({ status: 'running' })
  })

  it('keeps an accepted session and records a spawn error', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const project = createProject(db, { name: 'test', path: '/tmp' })
    const session = createSession(db, {
      projectId: project.id,
      harness: 'mock',
      title: 'Chat',
      cwd: '/tmp',
    })
    const manager = new SessionManager(db, new EventBus(), () => ({
      spawn: async () => {
        throw new Error('spawn failed')
      },
    }))

    await manager.prompt(session.id, 'hello')
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(
      db.prepare('SELECT id FROM sessions WHERE id = ?').get(session.id),
    ).toEqual({ id: session.id })
    expect(
      db
        .prepare(
          "SELECT type, json_extract(content, '$.message') AS message FROM messages WHERE session_id = ? AND type = 'error'",
        )
        .all(session.id),
    ).toEqual([{ type: 'error', message: 'spawn failed' }])
    expect(
      db.prepare('SELECT status FROM sessions WHERE id = ?').get(session.id),
    ).toEqual({ status: 'errored' })
  })

  it('uses the selected harness and persists it before the prompt', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const project = createProject(db, { name: 'test', path: '/tmp' })
    db.prepare(
      "INSERT INTO harness_accounts (id, harness_key, label, kind, home_path, created_at) VALUES ('first-account', 'first', 'First', 'claude', '/tmp/first', 1), ('second-account', 'second', 'Second', 'claude', '/tmp/second', 1)",
    ).run()
    const session = createSession(db, {
      projectId: project.id,
      harness: 'first',
      accountId: 'first-account',
      title: 'Chat',
      cwd: '/tmp',
    })
    const spawned: string[] = []
    let killed = 0
    const handle = (): HarnessHandle => ({
      prompt: async () => undefined,
      cancel: () => undefined,
      kill: () => {
        killed += 1
      },
    })
    const factory: HarnessFactory = (harness) => ({
      spawn: async () => {
        spawned.push(harness)
        return handle()
      },
    })
    const manager = new SessionManager(db, new EventBus(), factory)

    await manager.prompt(session.id, 'one', undefined, undefined, 'first')
    await new Promise<void>((resolve) => setImmediate(resolve))
    await manager.prompt(
      session.id,
      'two',
      undefined,
      undefined,
      'second',
      'second-account',
    )

    expect(spawned).toEqual(['first', 'second'])
    expect(killed).toBe(1)
    expect(
      (
        db
          .prepare('SELECT harness FROM sessions WHERE id = ?')
          .get(session.id) as { harness: string }
      ).harness,
    ).toBe('second')
  })
})

describe('skill invocation', () => {
  it('rewrites a listed workspace skill only for harness dispatch', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const workspace = await mkdtemp(join(tmpdir(), 'forge-skill-invoke-'))
    const skillDir = join(workspace, '.agents', 'skills', 'beads')
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: beads\ndescription: Track work\n---\n\nUse bd for task tracking.\n',
    )
    const project = createProject(db, { name: 'test', path: workspace })
    const session = createSession(db, {
      projectId: project.id,
      harness: 'mock',
      title: 'Chat',
      cwd: workspace,
    })
    let dispatched = ''
    const manager = new SessionManager(db, new EventBus(), () => ({
      spawn: async () => ({
        prompt: (content) => {
          dispatched =
            typeof content === 'string'
              ? content
              : (content.find((item) => item.kind === 'text')?.text ?? '')
        },
        cancel: () => undefined,
        kill: () => undefined,
      }),
    }))

    await manager.prompt(session.id, '$beads inspect this')
    await new Promise<void>((resolve) => setTimeout(resolve, 25))

    expect(dispatched).toContain('The user invoked the /beads skill.')
    expect(dispatched).toContain('Use bd for task tracking.')
    expect(dispatched).toContain('ARGUMENTS: inspect this')
    expect(
      db
        .prepare(
          "SELECT json_extract(content, '$.text') AS text FROM messages WHERE type = 'text_delta'",
        )
        .get(),
    ).toEqual({ text: '$beads inspect this' })
  })

  it('passes unknown and indented dollar prompts through unchanged', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const workspace = await mkdtemp(join(tmpdir(), 'forge-skill-invoke-'))
    const project = createProject(db, { name: 'test', path: workspace })
    const session = createSession(db, {
      projectId: project.id,
      harness: 'mock',
      title: 'Chat',
      cwd: workspace,
    })
    const dispatched: string[] = []
    const manager = new SessionManager(db, new EventBus(), () => ({
      spawn: async () => ({
        prompt: (content) => {
          dispatched.push(
            typeof content === 'string'
              ? content
              : (content.find((item) => item.kind === 'text')?.text ?? ''),
          )
        },
        cancel: () => undefined,
        kill: () => undefined,
      }),
    }))

    await manager.prompt(session.id, '$missing')
    for (let attempt = 0; attempt < 10 && dispatched.length < 1; attempt += 1)
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
    for (
      let attempt = 0;
      attempt < 10 &&
      !db
        .prepare(
          "SELECT 1 FROM messages WHERE session_id = ? AND type = 'turn_end'",
        )
        .get(session.id);
      attempt += 1
    )
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
    await manager.prompt(session.id, ' $missing')
    for (let attempt = 0; attempt < 10 && dispatched.length < 2; attempt += 1)
      await new Promise<void>((resolve) => setTimeout(resolve, 10))

    expect(dispatched).toHaveLength(2)
    expect(dispatched).toEqual(
      expect.arrayContaining(['$missing', ' $missing']),
    )
  })
})

describe('draft promotion idempotency', () => {
  function setup() {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const project = createProject(db, { name: 'test', path: '/tmp' })
    const manager = new SessionManager(
      db,
      new EventBus(),
      () => ({
        spawn: async () => ({
          prompt: async () => undefined,
          cancel: () => undefined,
          kill: () => undefined,
        }),
      }),
      undefined,
      () => false,
    )
    const input = {
      draftId: `draft:${project.id}`,
      projectId: project.id,
      harness: 'mock',
      text: 'hello',
    }
    return { db, manager, input }
  }

  const textsOf = (db: DatabaseSync, sessionId: string) =>
    db
      .prepare(
        "SELECT json_extract(content, '$.text') AS text FROM messages WHERE session_id = ? AND type = 'text_delta' ORDER BY seq",
      )
      .all(sessionId)

  it('creates a new session per attempt when one draft is promoted twice', async () => {
    const { db, manager, input } = setup()

    const first = await manager.promoteDraft(input, 'attempt-1')
    const second = await manager.promoteDraft(
      { ...input, text: 'second message' },
      'attempt-2',
    )

    expect(second.sessionId).not.toBe(first.sessionId)
    expect(textsOf(db, first.sessionId)).toEqual([{ text: 'hello' }])
    expect(textsOf(db, second.sessionId)).toEqual([{ text: 'second message' }])
  })

  it('returns the same session when one attempt is retried', async () => {
    const { db, manager, input } = setup()

    const first = await manager.promoteDraft(input, 'attempt-1')
    const retry = await manager.promoteDraft(input, 'attempt-1')

    expect(retry.sessionId).toBe(first.sessionId)
    expect(textsOf(db, first.sessionId)).toEqual([{ text: 'hello' }])
  })

  it('promotes a draft before a cold harness finishes spawning', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const project = createProject(db, { name: 'test', path: '/tmp' })
    const spawnStarted = new Promise<never>(() => undefined)
    const manager = new SessionManager(
      db,
      new EventBus(),
      () => ({ spawn: async () => spawnStarted }),
      undefined,
      () => false,
    )

    const result = await manager.promoteDraft(
      {
        draftId: `draft:${project.id}`,
        projectId: project.id,
        harness: 'mock',
        text: 'hello',
      },
      'attempt-1',
    )

    expect(result.sessionId).toBeTruthy()
    expect(textsOf(db, result.sessionId)).toEqual([{ text: 'hello' }])
  })

  it('keeps a promoted draft when spawning fails', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const project = createProject(db, { name: 'test', path: '/tmp' })
    const manager = new SessionManager(
      db,
      new EventBus(),
      () => ({
        spawn: async () => {
          throw new Error('spawn failed')
        },
      }),
      undefined,
      () => false,
    )

    const result = await manager.promoteDraft(
      {
        draftId: `draft:${project.id}`,
        projectId: project.id,
        harness: 'mock',
        text: 'hello',
      },
      'attempt-1',
    )
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(
      db.prepare('SELECT id FROM sessions WHERE id = ?').get(result.sessionId),
    ).toEqual({ id: result.sessionId })
    expect(
      db
        .prepare('SELECT session_id FROM draft_promotions WHERE request_id = ?')
        .get('attempt-1'),
    ).toEqual({ session_id: result.sessionId })
    expect(
      db
        .prepare('SELECT status FROM sessions WHERE id = ?')
        .get(result.sessionId),
    ).toEqual({ status: 'errored' })
  })
})
