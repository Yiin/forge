import { KeyedQueue } from '../keyed-queue.js'
import { lstat, realpath, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type {
  ResolvedWorkspace,
  WorkspaceTarget,
} from '@forge/protocol/workspace'
import { runGit } from '../git/exec.js'
import { listWorktrees } from '../git/worktrees.js'
import {
  fileRevision,
  hash,
  identity,
  WorkspaceError,
  type OwnedTemporary,
} from './paths.js'
import { WorkspaceOperations } from './operations.js'

export type WorkspaceResolution = ResolvedWorkspace & {
  rootIdentity: string
  checkoutKey: string
  gateKey: string
  gitDirectory: string | null
  checkoutState: string
  fingerprint: string
}
type Observation = Omit<
  WorkspaceResolution,
  'target' | 'projectId' | 'workspaceRevision'
>
export type WorkspaceObservations = {
  targets: Map<string, Observation>
  checkouts: Map<string, string>
}
type StoredTarget = {
  projectId: string
  projectPath: string
  cwd: string
  worktreePath: string | null
}
type RevisionRow = {
  target_key: string
  workspace_id: string
  checkout_key: string
  fingerprint: string
  revision: number
}
export const targetKey = (target: WorkspaceTarget) =>
  target.kind === 'session'
    ? `session:${target.sessionId}`
    : target.kind === 'project'
      ? `project:${target.projectId}`
      : 'none'
export function publicWorkspace(value: WorkspaceResolution): ResolvedWorkspace {
  const {
    target,
    projectId,
    cwd,
    worktreePath,
    workspaceId,
    workspaceRevision,
  } = value
  return {
    target,
    projectId,
    cwd,
    worktreePath,
    workspaceId,
    workspaceRevision,
  }
}

export class WorkspaceTargets {
  readonly mutations = new KeyedQueue()
  readonly temporaryPaths = new Map<string, OwnedTemporary>()
  constructor(
    readonly db: DatabaseSync,
    private readonly operations = new WorkspaceOperations(),
  ) {}
  private stored(target: WorkspaceTarget): StoredTarget {
    if (target.kind === 'none')
      throw new WorkspaceError(
        'no_workspace',
        404,
        'Select a project to browse files',
      )
    if (target.kind === 'project') {
      const row = this.db
        .prepare(
          'SELECT id, path FROM projects WHERE id = ? AND archived_at IS NULL AND deleted_at IS NULL',
        )
        .get(target.projectId) as { id: string; path: string } | undefined
      if (!row)
        throw new WorkspaceError('target_not_found', 404, 'Project not found')
      return {
        projectId: row.id,
        projectPath: row.path,
        cwd: row.path,
        worktreePath: null,
      }
    }
    const row = this.db
      .prepare(
        `SELECT s.project_id, s.cwd, s.worktree_path, p.path FROM sessions s JOIN projects p ON s.project_id = p.id AND p.deleted_at IS NULL WHERE s.id = ? AND s.deleted_at IS NULL`,
      )
      .get(target.sessionId) as
      | {
          project_id: string
          cwd: string
          worktree_path: string | null
          path: string
        }
      | undefined
    if (!row)
      throw new WorkspaceError('target_not_found', 404, 'Session not found')
    return {
      projectId: row.project_id,
      projectPath: row.path,
      cwd: row.cwd,
      worktreePath: row.worktree_path,
    }
  }
  async checkoutState(cwd: string, gitDirectory: string, signal?: AbortSignal) {
    const options = { signal, readOnly: true, maxOutputBytes: 64 * 1024 }
    const head = await runGit(
      cwd,
      ['symbolic-ref', '-q', 'HEAD'],
      false,
      options,
    )
    const oid = await runGit(
      cwd,
      ['rev-parse', '--verify', 'HEAD'],
      false,
      options,
    )
    if (head.code > 1 || (oid.code !== 0 && head.code !== 0))
      throw new WorkspaceError(
        'unavailable',
        503,
        'Git checkout state is unavailable',
      )
    return hash(
      JSON.stringify([
        head.stdout.trim(),
        oid.code === 0 ? oid.stdout.trim() : 'unborn',
        fileRevision(await stat(join(gitDirectory, 'HEAD'), { bigint: true })),
      ]),
    )
  }
  private async probe(
    stored: StoredTarget,
    signal?: AbortSignal,
    checkoutStates?: Map<string, string>,
  ) {
    signal?.throwIfAborted()
    let cwd: string, projectPath: string
    try {
      cwd = await realpath(stored.cwd)
      projectPath = await realpath(stored.projectPath)
    } catch {
      throw new WorkspaceError(
        'root_unavailable',
        503,
        'Workspace root is unavailable',
      )
    }
    const root = await stat(cwd, { bigint: true })
    const project = await stat(projectPath, { bigint: true })
    if (!root.isDirectory() || !project.isDirectory())
      throw new WorkspaceError(
        'root_unavailable',
        503,
        'Workspace root is unavailable',
      )
    const options = { signal, readOnly: true, maxOutputBytes: 1024 * 1024 }
    let ancestor = projectPath
    let isGit = false
    while (true) {
      const marker = await lstat(join(ancestor, '.git')).catch((error) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (marker) {
        isGit = true
        break
      }
      const parent = dirname(ancestor)
      if (parent === ancestor) break
      ancestor = parent
    }
    let worktreePath: string | null = null
    if (cwd !== projectPath) {
      if (!isGit)
        throw new WorkspaceError(
          'invalid_target',
          403,
          'Session does not belong to this project',
        )
      const worktrees = await listWorktrees(projectPath, options)
      let member = false
      for (const worktree of worktrees) {
        try {
          if ((await realpath(worktree.path)) === cwd) member = true
        } catch {
          /* A different worktree may be unavailable. */
        }
      }
      if (!member)
        throw new WorkspaceError(
          'invalid_target',
          403,
          'Session does not belong to a registered worktree',
        )
      worktreePath = cwd
    }
    let gitDirectory: string | null = null
    let checkoutState = 'plain'
    let checkoutKey = hash(`${cwd}:${identity(root)}`)
    let gateKey = checkoutKey
    if (isGit) {
      gitDirectory = await realpath(
        (
          await runGit(cwd, ['rev-parse', '--absolute-git-dir'], true, options)
        ).stdout.replace(/\n$/, ''),
      )
      checkoutKey = hash(
        `${gitDirectory}:${identity(await stat(gitDirectory, { bigint: true }))}`,
      )
      const common = await realpath(
        (
          await runGit(
            cwd,
            ['rev-parse', '--path-format=absolute', '--git-common-dir'],
            true,
            options,
          )
        ).stdout.replace(/\n$/, ''),
      )
      gateKey = hash(
        `${common}:${identity(await stat(common, { bigint: true }))}`,
      )
      if (gitDirectory !== common && !worktreePath)
        worktreePath = await realpath(
          (
            await runGit(cwd, ['rev-parse', '--show-toplevel'], true, options)
          ).stdout.replace(/\n$/, ''),
        )
      checkoutState =
        checkoutStates?.get(checkoutKey) ??
        (await this.checkoutState(cwd, gitDirectory, signal))
      checkoutStates?.set(checkoutKey, checkoutState)
    }
    if (stored.worktreePath) {
      let hint: string
      try {
        hint = await realpath(stored.worktreePath)
      } catch {
        throw new WorkspaceError(
          'invalid_target',
          403,
          'Stored worktree is unavailable',
        )
      }
      if (hint !== worktreePath)
        throw new WorkspaceError(
          'invalid_target',
          403,
          'Stored worktree contradicts checkout membership',
        )
    }
    const workspaceId = hash(
      `${cwd}:${identity(root)}:${isGit ? checkoutKey : ''}`,
    )
    const fingerprint = JSON.stringify({
      cwd,
      projectPath,
      projectIdentity: identity(project),
      workspaceId,
      worktreePath,
      checkoutState,
    })
    return {
      cwd,
      worktreePath,
      rootIdentity: identity(root),
      workspaceId,
      checkoutKey,
      gateKey,
      gitDirectory,
      checkoutState,
      fingerprint,
    }
  }
  async resolve(
    target: WorkspaceTarget,
    signal?: AbortSignal,
    observations?: WorkspaceObservations,
  ): Promise<WorkspaceResolution> {
    if (target.kind === 'none')
      throw new WorkspaceError(
        'no_workspace',
        404,
        'Select a project to browse files',
      )
    for (let attempt = 0; attempt < 2; attempt++) {
      const stored = this.stored(target)
      const before = this.row(targetKey(target))
      const key = JSON.stringify(stored)
      const cached = observations?.targets.get(key)
      const observation =
        cached ?? (await this.probe(stored, signal, observations?.checkouts))
      const confirmed =
        cached ?? (await this.probe(stored, signal, observations?.checkouts))
      signal?.throwIfAborted()
      if (
        observation.fingerprint !== confirmed.fingerprint ||
        JSON.stringify(stored) !== JSON.stringify(this.stored(target)) ||
        JSON.stringify(before) !== JSON.stringify(this.row(targetKey(target)))
      )
        continue
      observations?.targets.set(key, observation)
      // No awaits between reading revision rows and publishing this observation.
      // Update every alias when a checkout change is observed.
      this.db.exec('SAVEPOINT workspace_observation')
      try {
        const aliases = this.db
          .prepare(
            'SELECT * FROM workspace_target_revisions WHERE checkout_key = ?',
          )
          .all(observation.checkoutKey) as RevisionRow[]
        for (const alias of aliases) {
          const fingerprint = JSON.parse(alias.fingerprint) as {
            checkoutState: string
          }
          if (fingerprint.checkoutState !== observation.checkoutState) {
            fingerprint.checkoutState = observation.checkoutState
            this.db
              .prepare(
                'UPDATE workspace_target_revisions SET fingerprint = ?, revision = revision + 1 WHERE target_key = ?',
              )
              .run(JSON.stringify(fingerprint), alias.target_key)
          }
        }
        this.db
          .prepare(
            `INSERT INTO workspace_target_revisions (target_key, workspace_id, checkout_key, fingerprint, revision) VALUES (?, ?, ?, ?, 1)
        ON CONFLICT(target_key) DO UPDATE SET workspace_id = excluded.workspace_id, checkout_key = excluded.checkout_key, fingerprint = excluded.fingerprint,
        revision = workspace_target_revisions.revision + 1
        WHERE workspace_target_revisions.workspace_id != excluded.workspace_id
          OR workspace_target_revisions.checkout_key != excluded.checkout_key
          OR workspace_target_revisions.fingerprint != excluded.fingerprint`,
          )
          .run(
            targetKey(target),
            observation.workspaceId,
            observation.checkoutKey,
            observation.fingerprint,
          )
        const revision = this.row(targetKey(target))!.revision
        this.db.exec('RELEASE workspace_observation')
        return {
          target,
          projectId: stored.projectId,
          ...observation,
          workspaceRevision: revision,
        }
      } catch (error) {
        this.db.exec(
          'ROLLBACK TO workspace_observation; RELEASE workspace_observation',
        )
        throw error
      }
    }
    throw new WorkspaceError(
      'stale_read',
      409,
      'Workspace changed during resolution',
    )
  }
  private row(key: string) {
    return this.db
      .prepare('SELECT * FROM workspace_target_revisions WHERE target_key = ?')
      .get(key) as RevisionRow | undefined
  }
  invalidateCheckout(checkoutKey: string) {
    this.db
      .prepare(
        'UPDATE workspace_target_revisions SET revision = revision + 1 WHERE checkout_key = ?',
      )
      .run(checkoutKey)
  }
  invalidateTarget(target: WorkspaceTarget) {
    this.db
      .prepare(
        'UPDATE workspace_target_revisions SET revision = revision + 1 WHERE target_key = ?',
      )
      .run(targetKey(target))
  }
  checkExpected(
    workspace: WorkspaceResolution,
    expected: {
      expectedWorkspaceId?: string
      expectedWorkspaceRevision?: number
    },
  ) {
    if (
      (expected.expectedWorkspaceId !== undefined &&
        workspace.workspaceId !== expected.expectedWorkspaceId) ||
      (expected.expectedWorkspaceRevision !== undefined &&
        workspace.workspaceRevision !== expected.expectedWorkspaceRevision)
    )
      throw new WorkspaceError(
        'conflict',
        409,
        'Workspace changed',
        publicWorkspace(workspace),
        'workspace_changed',
      )
  }
  mutate<T>(
    target: WorkspaceTarget,
    operation: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ) {
    return this.operations.operation(signal, (signal) =>
      this.performMutation(target, operation, signal),
    )
  }
  close() {
    return this.operations.close()
  }
  private async performMutation<T>(
    target: WorkspaceTarget,
    operation: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ) {
    const owner = async () => {
      const stored = this.stored(target)
      const project = await this.probe(
        { ...stored, cwd: stored.projectPath, worktreePath: null },
        signal,
      )
      return { stored, project }
    }
    const initial = await owner()
    return this.mutations.run(
      initial.project.gateKey,
      async () => {
        const current = await owner()
        if (current.project.gateKey !== initial.project.gateKey)
          throw new WorkspaceError(
            'conflict',
            409,
            'Project repository changed',
            undefined,
            'workspace_changed',
          )
        const affected = new Set([current.project.checkoutKey])
        const old = this.row(targetKey(target))
        if (old) affected.add(old.checkout_key)
        try {
          const workspace = await this.probe(current.stored, signal)
          if (workspace.gateKey !== current.project.gateKey)
            throw new WorkspaceError(
              'invalid_target',
              403,
              'Workspace repository changed',
            )
          affected.add(workspace.checkoutKey)
        } catch {
          // Explicit selection can recover filesystem or Git discovery failures.
          // Ordinary file operations still require strict resolution.
          signal.throwIfAborted()
        }
        signal.throwIfAborted()
        if (
          JSON.stringify(current.stored) !== JSON.stringify(this.stored(target))
        )
          throw new WorkspaceError(
            'conflict',
            409,
            'Workspace changed',
            undefined,
            'workspace_changed',
          )
        for (const checkoutKey of affected) this.invalidateCheckout(checkoutKey)
        this.invalidateTarget(target)
        return operation(signal)
      },
      signal,
    )
  }
}
