import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import { Hono } from 'hono'
import { createProject, createSession } from '../db/queries.js'
import { migrate } from '../db/migrate.js'
import { runGit } from '../git/exec.js'
import { workspaceFileRoutes } from '../http/workspaceFiles.js'
import { WorkspaceFiles, type FileHooks } from './files.js'
import type { WorkspaceSave, WorkspaceTarget } from '@forge/protocol/workspace'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
export async function fixture(git = false, hooks: FileHooks = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'forge-workspace-files-'))
  const root = join(dir, 'repo')
  await mkdir(root)
  const db = new DatabaseSync(join(dir, 'forge.db'))
  migrate(db)
  const project = createProject(db, { name: 'Fixture', path: root })
  const session = createSession(db, {
    projectId: project.id,
    cwd: root,
    harness: 'unavailable-test-provider',
    title: 'Fixture',
  })
  const target: WorkspaceTarget = { kind: 'session', sessionId: session.id }
  await writeFile(join(root, 'file.txt'), 'original\n')
  if (git) {
    await runGit(root, ['init', '-b', 'main'])
    await runGit(root, ['config', 'user.email', 'fixture@example.test'])
    await runGit(root, ['config', 'user.name', 'Fixture'])
    await runGit(root, ['add', '.'])
    await runGit(root, ['commit', '-m', 'initial'])
  }
  const service = new WorkspaceFiles(db, hooks)
  const app = new Hono().route('/', workspaceFileRoutes(service))
  cleanup.push(async () => {
    await service.close()
    db.close()
    await rm(dir, { recursive: true, force: true })
  })
  const url = (
    route: string,
    fields: Record<string, string> = {},
    selected: WorkspaceTarget = target,
  ) =>
    `/api/workspace/${route}?${new URLSearchParams({ ...selected, ...fields })}`
  const snapshot = async (
    path = 'file.txt',
    selected: WorkspaceTarget = target,
  ) => {
    const response = await app.request(url('file', { path }, selected))
    if (response.status !== 200)
      throw new Error(
        `Read failed: ${response.status} ${await response.text()}`,
      )
    return response.json() as ReturnType<WorkspaceFiles['read']>
  }
  const save = (input: WorkspaceSave) =>
    app.request('/api/workspace/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
  const input = async (
    text: string,
    path = 'file.txt',
    selected = target,
  ): Promise<WorkspaceSave> => {
    const snap = await snapshot(path, selected)
    if (selected.kind !== 'session') throw new Error('Session required')
    return {
      target: selected,
      path,
      text,
      expectedWorkspaceId: snap.workspace.workspaceId,
      expectedWorkspaceRevision: snap.workspace.workspaceRevision,
      expectedContentHash: snap.file.contentHash!,
      expectedFileRevision: snap.file.fileRevision,
    }
  }
  return {
    dir,
    root,
    db,
    project,
    session,
    target,
    service,
    app,
    url,
    snapshot,
    save,
    input,
  }
}
export function barrier() {
  let entered!: () => void, release!: () => void
  const reached = new Promise<void>((resolve) => {
    entered = resolve
  })
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    reached,
    release,
    hook: async () => {
      entered()
      await wait
    },
  }
}
export async function until<T>(
  action: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  timeout = 5000,
) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await action()
    if (predicate(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Condition did not become true')
}
