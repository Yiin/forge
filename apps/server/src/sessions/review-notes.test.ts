import { MessageContent } from '@forge/protocol/message'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { migrate } from '../db/migrate.js'
import { createProject, createSession } from '../db/queries.js'
import { EventBus } from '../events/bus.js'
import { SessionManager } from './manager.js'
import { WorkspaceTargets } from '../workspace/target.js'
import { serializeReviewNotes, type ReviewNote } from '@forge/protocol/review'

it('persists exact structured anchors and sends one citation through a queued turn', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'forge-review-'))
  const db = new DatabaseSync(':memory:')
  migrate(db)
  const project = createProject(db, { name: 'Review', path: cwd })
  const session = createSession(db, {
    projectId: project.id,
    harness: 'mock',
    title: 'Review',
    cwd,
  })
  const targets = new WorkspaceTargets(db)
  const w = await targets.resolve({ kind: 'session', sessionId: session.id })
  const note: ReviewNote = {
    id: 'note-1',
    body: 'Keep old-side evidence',
    anchor: {
      workspaceId: w.workspaceId,
      workspaceRevision: w.workspaceRevision,
      revision: { kind: 'git', scope: 'working', revision: 'original-diff' },
      oldPath: 'before.ts',
      newPath: 'after.ts',
      side: 'old',
      line: 3,
    },
  }
  await writeFile(join(cwd, 'note.txt'), 'x')
  db.prepare(
    "INSERT INTO attachments(id,session_id,filename,mime,size_bytes,rel_path,status,created_at) VALUES(?,?,'note.txt','text/plain',1,'note.txt','complete',?)",
  ).run('attachment-review', session.id, Date.now())
  let release!: () => void
  const prompts: string[] = []
  const manager = new SessionManager(
    db,
    new EventBus(),
    () => ({
      spawn: async () => ({
        prompt: (content) => {
          prompts.push(
            typeof content === 'string'
              ? content
              : (content.find((item) => item.kind === 'text')?.text ?? ''),
          )
          return prompts.length === 1
            ? new Promise<void>((resolve) => {
                release = resolve
              })
            : Promise.resolve()
        },
        cancel: () => {},
        kill: () => {
          release?.()
        },
      }),
    }),
    undefined,
    () => false,
    cwd,
    targets,
  )
  try {
    await manager.prompt(session.id, 'held')
    await vi.waitFor(() => expect(prompts).toHaveLength(1))
    await manager.prompt(
      session.id,
      '',
      undefined,
      ['attachment-review'],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'turn-boundary',
      false,
      [note],
    )
    expect(
      JSON.parse(
        (
          db
            .prepare('SELECT review_references FROM queued_prompts')
            .get() as any
        ).review_references,
      ),
    ).toEqual([note])
    release()
    await vi.waitFor(() => expect(prompts).toHaveLength(2))
    expect(
      db
        .prepare(
          "SELECT count(*) AS n FROM messages WHERE type='attachment_ref'",
        )
        .get(),
    ).toEqual({ n: 1 })
    expect(prompts[1]).toContain('before.ts:3 (old; workspace')
    expect(prompts[1]?.match(/Review notes:/g)).toHaveLength(1)
    const row = db
      .prepare(
        "SELECT content FROM messages WHERE role='user' AND type='text_delta' AND json_extract(content,'$.reviewReferences[0].id')='note-1'",
      )
      .get() as any
    expect(JSON.parse(row.content).reviewReferences).toEqual([note])
    expect(MessageContent.parse(JSON.parse(row.content))).toMatchObject({
      reviewReferences: [note],
    })
    expect(JSON.parse(row.content).text).toBe(prompts[1])
    await expect(
      manager.prompt(
        session.id,
        'foreign',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        [{ ...note, anchor: { ...note.anchor, workspaceId: 'foreign' } }],
      ),
    ).rejects.toThrow(/another workspace/)
    expect(
      db
        .prepare("SELECT count(*) AS n FROM messages WHERE type='turn_start'")
        .get(),
    ).toEqual({ n: 2 })
  } finally {
    release?.()
    await manager.close()
    db.close()
    await rm(cwd, { recursive: true, force: true })
  }
})

it('sends the serialized citation through native steering', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'forge-review-'))
  const db = new DatabaseSync(':memory:')
  migrate(db)
  const project = createProject(db, { name: 'Review', path: cwd })
  const session = createSession(db, {
    projectId: project.id,
    harness: 'mock',
    title: 'Review',
    cwd,
  })
  const targets = new WorkspaceTargets(db)
  const w = await targets.resolve({ kind: 'session', sessionId: session.id })
  const note: ReviewNote = {
    id: 'note-1',
    body: 'Keep old-side evidence',
    anchor: {
      workspaceId: w.workspaceId,
      workspaceRevision: w.workspaceRevision,
      revision: { kind: 'git', scope: 'working', revision: 'original-diff' },
      oldPath: 'before.ts',
      newPath: 'after.ts',
      side: 'old',
      line: 3,
    },
  }
  let release!: () => void
  const prompts: unknown[] = []
  const steered: unknown[] = []
  const manager = new SessionManager(
    db,
    new EventBus(),
    () => ({
      spawn: async () => ({
        prompt: (input: unknown) => {
          prompts.push(input)
          return new Promise<void>((resolve) => {
            release = resolve
          })
        },
        steer: (input: unknown) => {
          steered.push(input)
          return Promise.resolve()
        },
        cancel: () => {},
        kill: () => {
          release?.()
        },
      }),
    }),
    undefined,
    () => false,
    cwd,
    targets,
  )
  try {
    await manager.prompt(session.id, 'held')
    await vi.waitFor(() => expect(prompts).toHaveLength(1))
    await manager.prompt(
      session.id,
      'Fix this',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'immediate',
      false,
      [note],
    )
    expect(steered).toEqual(['Fix this' + serializeReviewNotes([note])])
    const row = db
      .prepare(
        "SELECT content FROM messages WHERE role='user' AND type='text_delta' AND json_extract(content,'$.reviewReferences[0].id')='note-1'",
      )
      .get() as any
    expect(JSON.parse(row.content).text).toBe(steered[0])
  } finally {
    release?.()
    await manager.close()
    db.close()
    await rm(cwd, { recursive: true, force: true })
  }
})

it('accepts a notes-only steer without text or attachments', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'forge-review-'))
  const db = new DatabaseSync(':memory:')
  migrate(db)
  const project = createProject(db, { name: 'Review', path: cwd })
  const session = createSession(db, {
    projectId: project.id,
    harness: 'mock',
    title: 'Review',
    cwd,
  })
  const targets = new WorkspaceTargets(db)
  const w = await targets.resolve({ kind: 'session', sessionId: session.id })
  const note: ReviewNote = {
    id: 'note-1',
    body: 'Keep old-side evidence',
    anchor: {
      workspaceId: w.workspaceId,
      workspaceRevision: w.workspaceRevision,
      revision: { kind: 'git', scope: 'working', revision: 'original-diff' },
      oldPath: 'before.ts',
      newPath: 'after.ts',
      side: 'old',
      line: 3,
    },
  }
  let release!: () => void
  const prompts: unknown[] = []
  const steered: unknown[] = []
  const manager = new SessionManager(
    db,
    new EventBus(),
    () => ({
      spawn: async () => ({
        prompt: (input: unknown) => {
          prompts.push(input)
          return new Promise<void>((resolve) => {
            release = resolve
          })
        },
        steer: (input: unknown) => {
          steered.push(input)
          return Promise.resolve()
        },
        cancel: () => {},
        kill: () => {
          release?.()
        },
      }),
    }),
    undefined,
    () => false,
    cwd,
    targets,
  )
  try {
    await manager.prompt(session.id, 'held')
    await vi.waitFor(() => expect(prompts).toHaveLength(1))
    await manager.prompt(
      session.id,
      '',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'immediate',
      false,
      [note],
    )
    expect(steered).toEqual([serializeReviewNotes([note])])
    expect(steered[0]).toContain('before.ts:3 (old; workspace')
  } finally {
    release?.()
    await manager.close()
    db.close()
    await rm(cwd, { recursive: true, force: true })
  }
})
