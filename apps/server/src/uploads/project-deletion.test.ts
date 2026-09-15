import { DatabaseSync } from 'node:sqlite'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from '../db/migrate.js'
import { createProject, createSession, getSession } from '../db/queries.js'
import { EventBus } from '../events/bus.js'
import { SessionManager } from '../sessions/manager.js'
import { createFork } from '../sessions/fork.js'
import { sessionRoutes } from '../http/sessions.js'
import { projectRoutes } from '../http/projects.js'
import { workspaceRoutes } from '../http/workspace.js'
import { skillRoutes } from '../http/skills.js'
import { UploadStore } from './store.js'
import { createTestApp as createApp } from '../../test/app-fixture.js'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return {
    ...actual,
    mkdir: vi.fn(actual.mkdir),
    rm: vi.fn(actual.rm),
    rename: vi.fn(actual.rename),
    readFile: vi.fn(actual.readFile),
  }
})

const cleanups: Array<() => void | Promise<void>> = []
beforeEach(async () => {
  const actual =
    await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(fs.mkdir).mockImplementation(actual.mkdir)
  vi.mocked(fs.rm).mockImplementation(actual.rm)
  vi.mocked(fs.rename).mockImplementation(actual.rename)
  vi.mocked(fs.readFile).mockImplementation(actual.readFile)
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function fixture() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'forge-delete-owners-'))
  const db = new DatabaseSync(':memory:')
  migrate(db)
  const project = createProject(db, { name: 'Project', path: dir })
  const session = createSession(db, {
    projectId: project.id,
    harness: 'mock',
    title: 'Chat',
    cwd: dir,
  })
  const bus = new EventBus()
  const store = new UploadStore(db, { dataDir: dir, bus })
  const spawn = vi.fn(async () => ({
    prompt: async () => undefined,
    cancel: () => undefined,
    kill: () => undefined,
  }))
  const manager = new SessionManager(
    db,
    bus,
    () => ({ spawn }),
    undefined,
    () => false,
    dir,
  )
  cleanups.push(() => {
    manager.close()
    store.close()
    db.close()
  })
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }))
  return { dir, db, project, session, store, manager, spawn }
}

const upload = { filename: 'file.txt', mime: 'text/plain', sizeBytes: 1 }
const body = () =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array([1]))
      c.close()
    },
  })

describe('project deletion ownership', () => {
  it('holds real Git worktree provisioning until publication', async () => {
    const { manager, store, project, dir, db } = await fixture()
    execFileSync('git', ['init', '-b', 'main', dir])
    execFileSync('git', [
      '-C',
      dir,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    ])
    const mkdir = vi.mocked(fs.mkdir).getMockImplementation()!
    const entered = deferred()
    const release = deferred()
    vi.mocked(fs.mkdir).mockImplementationOnce(async (...args) => {
      entered.resolve()
      await release.promise
      return mkdir(...args)
    })
    const request = sessionRoutes(manager, store).request('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        harness: 'mock',
        kind: 'chat',
        cwd: dir,
        workspace: { mode: 'worktree', branch: 'topic' },
      }),
    })
    await entered.promise
    await expect(store.deleteProject(project.id)).rejects.toThrow(
      'Project has active operations',
    )
    release.resolve()
    const response = await request
    expect(response.status).toBe(201)
    const session = (await response.json()) as { id: string }
    const row = db
      .prepare('SELECT worktree_path FROM sessions WHERE id = ?')
      .get(session.id) as { worktree_path: string }
    expect(
      execFileSync(
        'git',
        ['-C', row.worktree_path, 'branch', '--show-current'],
        { encoding: 'utf8' },
      ).trim(),
    ).toBe('topic')
    await expect(store.deleteProject(project.id)).resolves.toBe(true)
  })

  it.each(['promote', 'rollback'] as const)(
    'holds %s filesystem moves against deletion',
    async (operation) => {
      const { store, project, session, dir } = await fixture()
      const draft = store.initDraft('draft', project.id, upload)
      await store.put(draft.attachmentId, body())
      if (operation === 'rollback')
        await store.promoteDraft('draft', session.id, project.id)
      const rename = vi.mocked(fs.rename).getMockImplementation()!
      const entered = deferred()
      const release = deferred()
      vi.mocked(fs.rename).mockImplementationOnce(async (...args) => {
        entered.resolve()
        await release.promise
        return rename(...args)
      })
      const pending =
        operation === 'promote'
          ? store.promoteDraft('draft', session.id, project.id)
          : store.rollbackPromotion('draft', session.id, project.id)
      await entered.promise
      await expect(store.deleteProject(project.id)).rejects.toThrow(
        'Project has active operations',
      )
      release.resolve()
      await pending
      await expect(store.deleteProject(project.id)).resolves.toBe(true)
      await expect(
        fs.stat(join(dir, 'projects', project.id)),
      ).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )

  it('excludes deletion while a prompt reads an image before starting its harness', async () => {
    const { store, manager, project, session, spawn } = await fixture()
    const attachment = store.init(session.id, { ...upload, mime: 'image/png' })
    await store.put(attachment.attachmentId, body())
    const readFile = vi.mocked(fs.readFile).getMockImplementation()!
    const entered = deferred()
    const release = deferred()
    vi.mocked(fs.readFile).mockImplementationOnce(async (...args) => {
      entered.resolve()
      await release.promise
      return readFile(...args)
    })
    const pending = manager.prompt(session.id, 'Image', undefined, [
      attachment.attachmentId,
    ])
    await entered.promise
    expect(spawn).not.toHaveBeenCalled()
    await expect(store.deleteProject(project.id)).rejects.toThrow(
      'Project has active operations',
    )
    release.resolve()
    await pending
    expect(spawn).toHaveBeenCalledOnce()
    await expect(store.deleteProject(project.id)).rejects.toThrow(
      'Project has active sessions',
    )
  })

  it('cancels a stalled body after write-open failure and waits for cancellation', async () => {
    const { store, project, session, dir } = await fixture()
    const attachment = store.init(session.id, upload)
    const path = join(
      dir,
      'projects',
      project.id,
      'sessions',
      session.id,
      'files',
      `${attachment.attachmentId}-file-txt`,
    )
    await fs.mkdir(join(path, '..'), { recursive: true })
    await fs.writeFile(path, 'existing')
    const cancelling = deferred()
    const release = deferred()
    const pending = store
      .put(
        attachment.attachmentId,
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelling.resolve()
            return release.promise
          },
        }),
      )
      .catch((error: Error) => error)
    await cancelling.promise
    await expect(store.deleteProject(project.id)).rejects.toThrow(
      'Project has active uploads',
    )
    release.resolve()
    expect(await pending).toMatchObject({ code: 'EEXIST' })
    expect(await fs.readFile(path, 'utf8')).toBe('existing')
    await expect(store.deleteProject(project.id)).resolves.toBe(true)
  })

  it('refuses deletion from mkdir admission through stream completion and permits a retry', async () => {
    const { store, db, project, session, dir } = await fixture()
    const mkdir = vi.mocked(fs.mkdir).getMockImplementation()!
    const releaseMkdir = deferred()
    vi.mocked(fs.mkdir).mockImplementationOnce(async (...args) => {
      await releaseMkdir.promise
      return mkdir(...args)
    })
    const reading = deferred()
    const releaseBody = deferred()
    const init = store.init(session.id, upload)
    const pending = store.put(
      init.attachmentId,
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          reading.resolve()
          await releaseBody.promise
          controller.enqueue(new Uint8Array([1]))
          controller.close()
        },
      }),
    )
    await expect(store.deleteProject(project.id)).rejects.toThrow(
      'Project has active uploads',
    )
    expect(
      db
        .prepare('SELECT deleted_at FROM projects WHERE id = ?')
        .get(project.id),
    ).toMatchObject({ deleted_at: null })
    releaseMkdir.resolve()
    await reading.promise
    await expect(store.deleteProject(project.id)).rejects.toThrow(
      'Project has active uploads',
    )
    releaseBody.resolve()
    await pending
    await expect(store.deleteProject(project.id)).resolves.toBe(true)
    await expect(
      fs.stat(join(dir, 'projects', project.id)),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains cleanup ownership after filesystem failure and removes old-session attachments on retry', async () => {
    const { store, db, project, session, dir } = await fixture()
    const init = store.init(session.id, upload)
    await store.put(init.attachmentId, body())
    vi.mocked(fs.rm).mockRejectedValueOnce(new Error('cleanup refused'))
    await expect(store.deleteProject(project.id)).rejects.toThrow(
      'cleanup refused',
    )
    expect(() => store.init(session.id, upload)).toThrow('Session not found')
    expect(() => store.initDraft('draft', project.id, upload)).toThrow(
      'Project not found',
    )
    db.prepare(
      "INSERT INTO attachments (id, session_id, filename, mime, size_bytes, status, created_at) VALUES ('old', ?, 'old', 'text/plain', 1, 'pending', 1)",
    ).run(session.id)
    await expect(store.put('old', body())).rejects.toThrow('Session not found')
    await expect(store.deleteProject(project.id)).resolves.toBe(true)
    expect(store.attachment('old')).toBeUndefined()
    await expect(
      fs.stat(join(dir, 'projects', project.id)),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects active operations for retained owners while keeping history and other projects', async () => {
    const { store, db, project, session, manager, spawn, dir } = await fixture()
    const sibling = createProject(db, { name: 'Sibling', path: dir })
    const siblingSession = createSession(db, {
      projectId: sibling.id,
      harness: 'mock',
      title: 'Other',
      cwd: dir,
    })
    createSession(db, {
      projectId: project.id,
      harness: 'mock',
      title: 'Child',
      cwd: dir,
      parentSessionId: session.id,
    })
    db.prepare('UPDATE projects SET archived_at = 1 WHERE id = ?').run(
      sibling.id,
    )
    await store.deleteProject(project.id)
    const app = createApp(
      store,
      { db, bus: store.eventBus, version: 'test' },
      undefined,
      manager,
    )
    for (const query of [
      '',
      `?projectId=${project.id}`,
      `?parentSessionId=${session.id}`,
      `?projectId=${project.id}&parentSessionId=${session.id}`,
    ]) {
      const response = await app.request(`/api/sessions${query}`)
      expect(response.status).toBe(200)
      const rows = (await response.json()) as Array<{ id: string }>
      expect(rows.map((row) => row.id)).toEqual(
        query ? [] : [siblingSession.id],
      )
    }
    expect(getSession(db, session.id)).toBeDefined()
    expect(() =>
      createSession(db, {
        projectId: project.id,
        harness: 'mock',
        title: 'No',
        cwd: dir,
      }),
    ).toThrow('Project not found')
    await expect(manager.prompt(session.id, 'No')).rejects.toThrow(
      'Session not found',
    )
    expect(() =>
      createFork(db, {
        sessionId: session.id,
        messageSeq: 1,
        text: 'No',
        requestId: 'fork',
        includeSource: true,
      }),
    ).toThrow('Session not found')
    expect(spawn).not.toHaveBeenCalled()
    const projectApp = projectRoutes(db, store)
    expect(
      (
        await projectApp.request(`/api/projects/${project.id}/rename`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'No' }),
        })
      ).status,
    ).toBe(404)
    const workspaceApp = workspaceRoutes(db, store)
    expect(
      (
        await workspaceApp.request(`/api/sessions/${session.id}/settle`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ settled: false }),
        })
      ).status,
    ).toBe(404)
    expect(
      (await skillRoutes(db).request(`/api/sessions/${session.id}/skills`))
        .status,
    ).toBe(404)
    expect(store.init(siblingSession.id, upload).attachmentId).toBeTruthy()
    expect(
      (await projectApp.request('/api/projects?includeArchived=1')).status,
    ).toBe(200)
    expect(
      await (
        await projectApp.request('/api/projects?includeArchived=1')
      ).json(),
    ).toMatchObject([{ id: sibling.id }])
  })

  it.each(['create', 'promote'] as const)(
    'excludes deletion and rechecks %s after workspace resolution',
    async (operation) => {
      const { manager, store, project, db, dir } = await fixture()
      const resolving = deferred()
      const release = deferred()
      vi.spyOn(manager, 'resolveWorkspace').mockImplementationOnce(async () => {
        resolving.resolve()
        await release.promise
        return { cwd: dir, worktreePath: null, branch: null }
      })
      const count = db.prepare('SELECT COUNT(*) AS count FROM sessions').get()
      const result =
        operation === 'create'
          ? sessionRoutes(manager, store).request('/api/sessions', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                projectId: project.id,
                harness: 'mock',
                kind: 'chat',
                cwd: dir,
              }),
            })
          : manager
              .promoteDraft(
                {
                  draftId: 'draft',
                  projectId: project.id,
                  harness: 'mock',
                  text: 'No',
                },
                'request',
                store,
              )
              .catch((error: Error) => error)
      await resolving.promise
      await expect(store.deleteProject(project.id)).rejects.toThrow(
        'Project has active operations',
      )
      db.prepare('UPDATE projects SET deleted_at = 1 WHERE id = ?').run(
        project.id,
      )
      release.resolve()
      const response = await result
      if (response instanceof Response) expect(response.status).toBe(400)
      else expect(response).toMatchObject({ message: 'Project not found' })
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM sessions').get(),
      ).toEqual(count)
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM draft_promotions').get(),
      ).toMatchObject({ count: 0 })
    },
  )
})
