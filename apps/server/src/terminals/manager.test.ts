import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { migrate } from '../db/migrate.js'
import { WorkspaceTargets } from '../workspace/target.js'
import { TerminalManager } from './manager.js'
import { LinuxPty } from './linux-pty.js'
import type { TerminalLimitValues } from './limits.js'
import { EventEmitter } from 'node:events'
import type { WebSocket } from 'ws'
import { SessionManager } from '../sessions/manager.js'
import { UploadStore } from '../uploads/store.js'
import { EventBus } from '../events/bus.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const supported = {
  apiVersion: 1 as const,
  supported: true,
  cleanupComplete: true,
  linux: true,
  pidfdOpen: true,
  pidfdSendSignal: true,
  retainedChildWait: true,
  reason: null,
}
const fixtures: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.useRealTimers()
  for (const close of fixtures.splice(0)) await close()
})

function fixture(limits: Partial<TerminalLimitValues> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-terminal-manager-'))
  const db = new DatabaseSync(':memory:')
  migrate(db)
  db.prepare(
    'INSERT INTO projects(id,name,path,created_at) VALUES(?,?,?,?)',
  ).run('project', 'Synthetic', directory, Date.now())
  for (const id of ['first', 'second'])
    db.prepare(
      "INSERT INTO sessions(id,project_id,harness,cwd,title,status,created_at,last_activity_at,kind,auto_resume) VALUES(?,'project','synthetic',?,'Synthetic','idle',?,?,'chat',0)",
    ).run(id, directory, Date.now(), Date.now())
  const targets = new WorkspaceTargets(db)
  const instances: FakeNative[] = []
  let capability: Promise<typeof supported> = Promise.resolve(supported)
  class FakeNative {
    static capabilities = vi.fn(() => capability)
    static drainCapabilities = vi.fn(
      async () => (await capability).cleanupComplete,
    )
    readonly exit = deferred<{
      exitCode: number | null
      signal: number | null
    }>()
    readonly receipt = { leaderExit: this.exit.promise }
    readonly socket = { closed: false }
    cleanupComplete = true
    outputComplete = true
    readonly fence = vi.fn()
    readonly release = vi.fn()
    readonly ready = vi.fn(async () => {})
    readonly joinCleanup = vi.fn(async () => {})
    readonly write = vi.fn(
      (_bytes: Buffer, _offset: number, count: number) => count,
    )
    readonly resize = vi.fn()
    readonly checkMaster = () => true
    constructor(
      _file: string,
      _args: string[],
      _cwd: string,
      _env: unknown,
      _cols: number,
      _rows: number,
      _limits: unknown,
      readonly output: (bytes: Buffer) => void,
    ) {
      instances.push(this)
    }
    cleanup = vi.fn(async () => {
      this.socket.closed = this.cleanupComplete
      return this.cleanupComplete
    })
  }
  const manager = new TerminalManager(db, targets, {
    native: FakeNative as unknown as typeof LinuxPty,
    limits,
    environment: () => ({
      SHELL: '/bin/sh',
      HOME: directory,
      PATH: '/usr/bin:/bin',
    }),
  })
  fixtures.push(async () => {
    capability = Promise.resolve(supported)
    for (const instance of instances) instance.cleanupComplete = true
    await manager.closeAll()
    targets.close()
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const create = async (sessionId = 'first') => {
    const workspace = await targets.resolve({ kind: 'session', sessionId })
    return manager.create(sessionId, {
      expectedWorkspaceId: workspace.workspaceId,
      expectedWorkspaceRevision: workspace.workspaceRevision,
    })
  }
  return {
    directory,
    db,
    manager,
    targets,
    instances,
    FakeNative,
    create,
    setCapability: (value: Promise<typeof supported>) => {
      capability = value
    },
  }
}

describe('terminal manager lifecycle and resource admission', () => {
  it('shuts down without admitting a capability probe', async () => {
    const { manager, FakeNative } = fixture()
    expect(await manager.closeAll()).toBe(true)
    expect(FakeNative.capabilities).not.toHaveBeenCalled()
    expect(await LinuxPty.drainCapabilities()).toBe(true)
  })

  it('refuses capability startup by deadline while shutdown joins the original work', async () => {
    const { manager, targets, FakeNative, setCapability } = fixture()
    const workspace = await targets.resolve({
      kind: 'session',
      sessionId: 'first',
    })
    const pending = deferred<typeof supported>()
    setCapability(pending.promise)
    vi.useFakeTimers()
    const create = manager.create('first', {
      expectedWorkspaceId: workspace.workspaceId,
      expectedWorkspaceRevision: workspace.workspaceRevision,
    })
    const refused = expect(create).rejects.toThrow(
      'Terminal capability check timed out',
    )
    await vi.advanceTimersByTimeAsync(1001)
    await refused
    expect(FakeNative.capabilities).toHaveBeenCalledTimes(1)
    let stopped = false
    const shutdown = manager.closeAll().then((value) => {
      stopped = true
      return value
    })
    await vi.advanceTimersByTimeAsync(50)
    expect(stopped).toBe(false)
    pending.resolve(supported)
    expect(await shutdown).toBe(true)
    expect(manager.resourceState().startups).toBe(0)
  })

  it('retains failed cleanup capacity and refuses destructive work until explicit recovery', async () => {
    const { manager, instances, create } = fixture({
      terminals: 1,
      startups: 1,
    })
    const terminal = await create()
    instances[0]!.cleanupComplete = false
    const action = vi.fn(async () => 'removed')
    await expect(manager.removeSession('first', action)).rejects.toThrow(
      'Terminal cleanup prevents deletion',
    )
    expect(action).not.toHaveBeenCalled()
    expect(manager.resourceState().terminals).toBe(1)
    await expect(create('second')).rejects.toThrow('Terminal capacity reached')
    instances[0]!.cleanupComplete = true
    expect(await manager.removeSession('first', action)).toBe('removed')
    expect(action).toHaveBeenCalledTimes(1)
    expect(() => manager.get('first', terminal.id)).toThrow(
      'Terminal not found',
    )
  })

  it('holds the project gate through deletion and prevents racing terminal release', async () => {
    const { manager, instances, create } = fixture()
    await create()
    const held = deferred<void>()
    const entered = deferred<void>()
    const remove = manager.removeProject('project', async () => {
      entered.resolve()
      await held.promise
    })
    await entered.promise
    const racing = create('second')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(instances).toHaveLength(1)
    held.resolve()
    await remove
    await racing
    expect(instances).toHaveLength(2)
    expect(instances[1]!.release).toHaveBeenCalledTimes(1)
  })

  it('keeps archived owners running and refuses new terminals', async () => {
    const { db, manager, instances, create } = fixture()
    const terminal = await create()
    db.prepare("UPDATE sessions SET status='archived' WHERE id='first'").run()
    expect(manager.get('first', terminal.id).state).toBe('running')
    expect(instances[0]!.cleanup).not.toHaveBeenCalled()
    await expect(create()).rejects.toThrow(
      'Archived sessions cannot create terminals',
    )
    expect(
      (await manager.input('first', terminal.id, 'YQ==')).writtenBytes,
    ).toBe(1)
    await manager.close('first', terminal.id)
  })

  it('keeps output bytes and cursor ownership separate between terminals', async () => {
    const { manager, instances, create } = fixture({
      batchBytes: 4,
      batchMs: 1,
      replayEvents: 3,
    })
    const first = await create(),
      second = await create('second')
    instances[0]!.output(Buffer.from([0, 255, 27, 65]))
    instances[1]!.output(Buffer.from([240, 159, 152, 128]))
    expect(manager.get('first', first.id).lastSeq).toBe(1)
    expect(manager.get('second', second.id).lastSeq).toBe(1)
    expect(() => manager.get('first', second.id)).toThrow('Terminal not found')
    instances[0]!.output(Buffer.alloc(16, 65))
    expect(manager.get('first', first.id).firstRetainedSeq).toBe(4)
    expect(() => manager.reserveSubscription('first', first.id, 99)).toThrow(
      'Terminal cursor is ahead of output',
    )
    await manager.close('first', first.id)
    expect(manager.get('second', second.id).state).toBe('running')
  })

  it('joins concurrent shutdown and retries a settled capability cleanup refusal without a replacement spawn', async () => {
    const { manager, FakeNative, setCapability, create, instances } = fixture()
    setCapability(
      Promise.resolve({
        ...supported,
        supported: false,
        cleanupComplete: false,
      } as typeof supported),
    )
    await expect(create()).rejects.toThrow(
      'Owned terminal support is unavailable',
    )
    const first = manager.closeAll()
    expect(manager.closeAll()).toBe(first)
    expect(await first).toBe(false)
    expect(instances).toHaveLength(0)
    setCapability(Promise.resolve(supported))
    expect(await manager.closeAll()).toBe(true)
    expect(FakeNative.capabilities).toHaveBeenCalledTimes(1)
    expect(FakeNative.drainCapabilities).toHaveBeenCalledTimes(2)
  })

  it('does not admit a shell when capability support is cleanly unavailable', async () => {
    const { manager, setCapability, create, instances } = fixture()
    setCapability(
      Promise.resolve({ ...supported, supported: false } as typeof supported),
    )
    await expect(create()).rejects.toThrow(
      'Owned terminal support is unavailable',
    )
    expect(instances).toHaveLength(0)
    expect(manager.resourceState().startups).toBe(0)
    expect(await manager.closeAll()).toBe(true)
  })

  it('rejects deleted and changed workspace owners before native startup', async () => {
    const { manager, targets, instances, db } = fixture()
    const workspace = await targets.resolve({
      kind: 'session',
      sessionId: 'first',
    })
    await expect(
      manager.create('first', {
        expectedWorkspaceId: workspace.workspaceId,
        expectedWorkspaceRevision: workspace.workspaceRevision + 1,
      }),
    ).rejects.toThrow('Workspace changed')
    db.prepare('UPDATE sessions SET deleted_at=? WHERE id=?').run(
      Date.now(),
      'first',
    )
    await expect(
      manager.create('first', {
        expectedWorkspaceId: workspace.workspaceId,
        expectedWorkspaceRevision: workspace.workspaceRevision,
      }),
    ).rejects.toThrow('Session not found')
    expect(instances).toHaveLength(0)
  })

  it('captures an existing shell workspace and refuses new creation after project archive', async () => {
    const { manager, create, db, instances } = fixture()
    const terminal = await create()
    db.prepare('UPDATE sessions SET cwd=? WHERE id=?').run(
      '/unavailable-new-workspace',
      'first',
    )
    db.prepare('UPDATE projects SET archived_at=? WHERE id=?').run(
      Date.now(),
      'project',
    )
    expect(manager.get('first', terminal.id).workspace).toEqual(
      terminal.workspace,
    )
    expect(
      (await manager.input('first', terminal.id, 'YQ==')).writtenBytes,
    ).toBe(1)
    expect(instances[0]!.cleanup).not.toHaveBeenCalled()
    await expect(
      manager.create('first', {
        expectedWorkspaceId: terminal.workspace.workspaceId,
        expectedWorkspaceRevision: terminal.workspace.workspaceRevision,
      }),
    ).rejects.toThrow('Archived sessions cannot create terminals')
  })

  it('expires only cleaned natural exits and refreshes their accepted rename activity', async () => {
    const { manager, create, instances } = fixture({ exitedTtlMs: 100 })
    const ended = await create(),
      live = await create('second'),
      unknown = await create('second')
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'],
    })
    instances[0]!.exit.resolve({ exitCode: 0, signal: null })
    instances[2]!.cleanupComplete = false
    instances[2]!.exit.resolve({ exitCode: 1, signal: null })
    await vi.advanceTimersByTimeAsync(60)
    expect(manager.get('first', ended.id).state).toBe('exited')
    manager.rename('first', ended.id, { title: 'retained' })
    await vi.advanceTimersByTimeAsync(60)
    expect(manager.get('first', ended.id).title).toBe('retained')
    await vi.advanceTimersByTimeAsync(41)
    expect(() => manager.get('first', ended.id)).toThrow('Terminal not found')
    expect(manager.get('second', live.id).state).toBe('running')
    expect(manager.get('second', unknown.id).cleanup).toBe('unknown')
  })

  it('keeps a failed cleanup fenced through concurrent close, then releases the same terminal on retry', async () => {
    const { manager, create, instances } = fixture({
      terminals: 1,
      startups: 1,
    })
    const terminal = await create()
    const pending = deferred<boolean>()
    instances[0]!.cleanup.mockImplementationOnce(() => pending.promise)
    const first = manager.close('first', terminal.id),
      second = manager.close('first', terminal.id)
    const failures = Promise.all([
      expect(first).rejects.toThrow('Terminal cleanup is unknown'),
      expect(second).rejects.toThrow('Terminal cleanup is unknown'),
    ])
    await expect(create('second')).rejects.toThrow('Terminal capacity reached')
    expect(instances[0]!.cleanup).toHaveBeenCalledTimes(1)
    pending.resolve(false)
    await failures
    expect(manager.get('first', terminal.id).cleanup).toBe('unknown')
    expect(await manager.close('first', terminal.id)).toEqual({ closed: true })
    expect(manager.resourceState().terminals).toBe(0)
    expect(instances).toHaveLength(1)
  })

  it('holds opening and closing subscriptions and removed replay until the original transport closes', async () => {
    const { manager, create, instances } = fixture({
      subscriptions: 1,
      terminals: 1,
      startups: 1,
      writeDeadlineMs: 20,
      socketCloseMs: 10,
    })
    const terminal = await create()
    const opening = manager.reserveSubscription('first', terminal.id, 0)
    expect(() => manager.reserveSubscription('first', terminal.id, 0)).toThrow(
      'Terminal subscription capacity reached',
    )
    class HeldSocket extends EventEmitter {
      OPEN = 1
      CLOSED = 3
      readyState = 1
      bufferedAmount = 0
      send = vi.fn((text: string) => {
        this.bufferedAmount = Buffer.byteLength(text)
      })
      close = vi.fn(() => {
        this.readyState = 2
      })
      terminate = vi.fn()
    }
    const socket = new HeldSocket()
    vi.useFakeTimers()
    opening.open(socket as unknown as WebSocket)
    instances[0]!.output(Buffer.from('last'))
    await manager.close('first', terminal.id)
    expect(() => manager.get('first', terminal.id)).toThrow(
      'Terminal not found',
    )
    await vi.advanceTimersByTimeAsync(31)
    expect(socket.close).toHaveBeenCalledTimes(1)
    expect(socket.terminate).toHaveBeenCalledTimes(1)
    expect(manager.resourceState()).toMatchObject({
      terminals: 1,
      subscriptions: 1,
    })
    expect(manager.resourceState().subscriptionBytes).toBeGreaterThan(0)
    await expect(create('second')).rejects.toThrow('Terminal capacity reached')
    socket.readyState = socket.CLOSED
    socket.bufferedAmount = 0
    socket.emit('close')
    await opening.closed
    expect(manager.resourceState()).toMatchObject({
      terminals: 0,
      subscriptions: 0,
      subscriptionBytes: 0,
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps every promotion rollback mutation behind cleanup and retries the original failed promotion', async () => {
    const { manager, db, directory, create, instances } = fixture()
    const sessions = new SessionManager(
      db,
      new EventBus(),
      () => {
        throw new Error('Unexpected harness')
      },
      undefined,
      () => false,
      directory,
    )
    sessions.setTerminalManager(manager)
    const uploads = new UploadStore(db, { dataDir: join(directory, 'uploads') })
    uploads.setTerminalManager(manager)
    fixtures.push(async () => {
      sessions.close()
      uploads.close()
    })
    const input = {
      draftId: 'draft',
      projectId: 'project',
      harness: 'synthetic',
      text: 'synthetic',
    }
    const attachment = uploads.initDraft('draft', 'project', {
      filename: 'proof.txt',
      mime: 'text/plain',
      sizeBytes: 5,
    })
    await uploads.put(attachment.attachmentId, new Response('proof').body)
    const entered = deferred<string>(),
      fail = deferred<void>()
    const original = new Error('Original promotion failure')
    const prompt = vi
      .spyOn(sessions, 'prompt')
      .mockImplementation(async (sessionId) => {
        entered.resolve(sessionId)
        await fail.promise
        throw original
      })
    const promotion = sessions.promoteDraft(input, 'request', uploads)
    const sessionId = await entered.promise
    const terminal = await create(sessionId)
    const row = () =>
      db
        .prepare(
          'SELECT session_id,draft_id,rel_path FROM attachments WHERE id=?',
        )
        .get(attachment.attachmentId) as {
        session_id: string | null
        draft_id: string | null
        rel_path: string
      }
    const promoted = row(),
      promotedPath = join(uploads.dataDir, promoted.rel_path)
    const rollback = vi.spyOn(uploads, 'rollbackPromotion')
    instances[0]!.cleanupComplete = false
    fail.resolve()
    const failure = await promotion.catch((error) => error)
    expect(failure).toMatchObject({
      code: 'rollback_cleanup_unknown',
      details: { sessionId },
    })
    expect(failure.cause.errors[0]).toBe(original)
    expect(rollback).not.toHaveBeenCalled()
    expect(row()).toEqual(promoted)
    expect(readFileSync(promotedPath, 'utf8')).toBe('proof')
    expect(
      db.prepare('SELECT status FROM sessions WHERE id=?').get(sessionId),
    ).toEqual({ status: 'idle' })
    expect(
      db
        .prepare('SELECT session_id FROM draft_promotions WHERE request_id=?')
        .get('request'),
    ).toEqual({ session_id: sessionId })
    expect(manager.get(sessionId, terminal.id).cleanup).toBe('unknown')
    const held = deferred<boolean>()
    instances[0]!.cleanup.mockImplementationOnce(() => held.promise)
    const retry = sessions.promoteDraft(input, 'request', uploads)
    const joined = sessions.promoteDraft(input, 'request', uploads)
    const outcomes = Promise.all([
      expect(retry).rejects.toBe(original),
      expect(joined).rejects.toBe(original),
    ])
    await vi.waitFor(() =>
      expect(instances[0]!.cleanup).toHaveBeenCalledTimes(2),
    )
    const racing = create(sessionId)
    const refused = expect(racing).rejects.toThrow('Session not found')
    expect(rollback).not.toHaveBeenCalled()
    instances[0]!.socket.closed = true
    held.resolve(true)
    await outcomes
    await refused
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(instances).toHaveLength(1)
    expect(rollback).toHaveBeenCalledTimes(1)
    expect(row()).toMatchObject({ session_id: null, draft_id: 'draft' })
    expect(readFileSync(join(uploads.dataDir, row().rel_path), 'utf8')).toBe(
      'proof',
    )
    expect(existsSync(promotedPath)).toBe(false)
    expect(
      db.prepare('SELECT id FROM sessions WHERE id=?').get(sessionId),
    ).toBeUndefined()
    expect(
      db
        .prepare('SELECT session_id FROM draft_promotions WHERE request_id=?')
        .get('request'),
    ).toBeUndefined()
    expect(manager.resourceState()).toMatchObject({
      terminals: 0,
      startups: 0,
      removals: 0,
    })
  })

  it('holds project ownership after failed rollback until the original cleanup succeeds', async () => {
    const { db, directory } = fixture()
    const sessions = new SessionManager(
      db,
      new EventBus(),
      () => {
        throw new Error('Unexpected harness')
      },
      undefined,
      () => false,
      directory,
    )
    const uploads = new UploadStore(db, { dataDir: join(directory, 'uploads') })
    fixtures.push(async () => {
      sessions.close()
      uploads.close()
    })
    const input = {
      draftId: 'draft',
      projectId: 'project',
      harness: 'synthetic',
      text: 'synthetic',
    }
    const original = new Error('Original prompt failure')
    vi.spyOn(sessions, 'prompt').mockRejectedValue(original)
    vi.spyOn(uploads, 'rollbackPromotion').mockRejectedValueOnce(
      new Error('Filesystem cleanup refused'),
    )
    await expect(
      sessions.promoteDraft(input, 'request', uploads),
    ).rejects.toMatchObject({ code: 'rollback_cleanup_unknown' })
    await expect(uploads.deleteProject('project')).rejects.toThrow(
      'Project has active operations',
    )
    expect(
      db.prepare('SELECT deleted_at FROM projects WHERE id=?').get('project'),
    ).toEqual({ deleted_at: null })
    await expect(sessions.promoteDraft(input, 'request', uploads)).rejects.toBe(
      original,
    )
    await expect(uploads.deleteProject('project')).resolves.toBe(true)
  })

  it('bounds retained rollback owners before another promotion can create a session', async () => {
    const { manager, db, directory, create, instances } = fixture({ http: 1 })
    const sessions = new SessionManager(
      db,
      new EventBus(),
      () => {
        throw new Error('Unexpected harness')
      },
      undefined,
      () => false,
      directory,
    )
    sessions.setTerminalManager(manager)
    fixtures.push(async () => sessions.close())
    const original = new Error('Promotion failed')
    vi.spyOn(sessions, 'prompt').mockImplementation(async (sessionId) => {
      await create(sessionId)
      instances.at(-1)!.cleanupComplete = false
      throw original
    })
    const input = {
      draftId: 'draft',
      projectId: 'project',
      harness: 'synthetic',
      text: 'synthetic',
    }
    await expect(
      sessions.promoteDraft(input, 'first-request'),
    ).rejects.toMatchObject({ code: 'rollback_cleanup_unknown' })
    const count = db.prepare('SELECT COUNT(*) AS count FROM sessions').get()
    await expect(
      sessions.promoteDraft(input, 'second-request'),
    ).rejects.toThrow('Draft promotion capacity reached')
    expect(db.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual(
      count,
    )
    instances[0]!.cleanupComplete = true
    await expect(sessions.promoteDraft(input, 'first-request')).rejects.toBe(
      original,
    )
    vi.mocked(sessions.prompt).mockResolvedValue(undefined)
    expect(
      (await sessions.promoteDraft(input, 'second-request')).sessionId,
    ).toBeTruthy()
  })

  it('guards project attachment deletion once without recursively entering the project gate', async () => {
    const { manager, db, directory, create, instances } = fixture()
    const uploads = new UploadStore(db, { dataDir: join(directory, 'uploads') })
    uploads.setTerminalManager(manager)
    fixtures.push(async () => uploads.close())
    await create()
    await create('second')
    const attachment = uploads.init('first', {
      filename: 'proof.txt',
      mime: 'text/plain',
      sizeBytes: 5,
    })
    await uploads.put(attachment.attachmentId, new Response('proof').body)
    const file = db
      .prepare('SELECT rel_path FROM attachments WHERE id=?')
      .get(attachment.attachmentId) as { rel_path: string }
    instances[1]!.cleanupComplete = false
    await expect(uploads.deleteProject('project')).rejects.toThrow(
      'Terminal cleanup prevents deletion',
    )
    expect(
      db.prepare('SELECT id FROM projects WHERE id=?').get('project'),
    ).toBeTruthy()
    expect(existsSync(join(uploads.dataDir, file.rel_path))).toBe(true)
    instances[1]!.cleanupComplete = true
    await uploads.deleteProject('project')
    expect(
      db
        .prepare('SELECT id, deleted_at FROM projects WHERE id=?')
        .get('project'),
    ).toMatchObject({ id: 'project', deleted_at: expect.any(Number) })
    expect(
      db.prepare('SELECT id, deleted_at FROM sessions WHERE id=?').get('first'),
    ).toMatchObject({ id: 'first', deleted_at: expect.any(Number) })
    expect(existsSync(join(uploads.dataDir, file.rel_path))).toBe(false)
    expect(manager.resourceState()).toMatchObject({ terminals: 0, removals: 0 })
  })

  it('cleans another project sharing the same physical workspace before workspace removal', async () => {
    const { manager, db, directory, create, instances } = fixture()
    db.prepare(
      'INSERT INTO projects(id,name,path,created_at) VALUES(?,?,?,?)',
    ).run('alias', 'Alias', directory, Date.now())
    db.prepare("UPDATE sessions SET project_id='alias' WHERE id='second'").run()
    await create()
    await create('second')
    instances[1]!.cleanupComplete = false
    const remove = vi.fn(async () => 'removed')
    await expect(manager.removeWorkspace('first', remove)).rejects.toThrow(
      'Terminal cleanup prevents deletion',
    )
    expect(remove).not.toHaveBeenCalled()
    expect(instances[0]!.cleanup).toHaveBeenCalledTimes(1)
    expect(instances[1]!.cleanup).toHaveBeenCalledTimes(1)
    instances[1]!.cleanupComplete = true
    expect(await manager.removeWorkspace('first', remove)).toBe('removed')
    expect(manager.resourceState().terminals).toBe(0)
  })
})
