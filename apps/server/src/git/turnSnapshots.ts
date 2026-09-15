import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { runGit } from './exec.js'
import { WorkspaceTargets } from '../workspace/target.js'
import type { WorkspaceTarget } from '@forge/protocol/workspace'

export type TurnSnapshot = {
  id: string
  sessionId: string
  turnId: string
  workspaceId: string
  workspaceRevision: number
  checkoutKey: string
  treeId: string | null
  state: 'ready' | 'partial' | 'unavailable'
  error: string | null
  createdAt: number
}
export async function captureTurnSnapshot(input: {
  db: DatabaseSync
  sessionId: string
  turnId: string
  target?: WorkspaceTarget
  targets?: WorkspaceTargets
}): Promise<TurnSnapshot> {
  const targets = input.targets ?? new WorkspaceTargets(input.db)
  const target = input.target ?? { kind: 'session', sessionId: input.sessionId }
  const workspace = await targets.resolve(target)
  const id = randomUUID()
  const createdAt = Date.now()
  let treeId: string | null = null
  let state: TurnSnapshot['state'] = 'ready'
  let error: string | null = null
  const temp = await mkdtemp(join(workspace.cwd, '.forge-snapshot-'))
  const index = join(temp, 'index')
  try {
    const env = { GIT_INDEX_FILE: index }
    const existingHead = await runGit(
      workspace.cwd,
      ['rev-parse', '--verify', 'HEAD'],
      false,
      { readOnly: true, maxOutputBytes: 64 * 1024 },
    )
    const read = await runGit(
      workspace.cwd,
      ['read-tree', existingHead.code === 0 ? 'HEAD' : '--empty'],
      false,
      { env, readOnly: true, maxOutputBytes: 64 * 1024 },
    )
    if (read.code !== 0)
      throw new Error(read.stderr || 'Cannot prepare snapshot index')
    const add = await runGit(
      workspace.cwd,
      ['add', '--all', '--', '.'],
      false,
      { env, readOnly: true, maxOutputBytes: 64 * 1024 },
    )
    if (add.code !== 0)
      throw new Error(add.stderr || 'Cannot capture snapshot files')
    const tree = await runGit(workspace.cwd, ['write-tree'], false, {
      env,
      readOnly: true,
      maxOutputBytes: 64 * 1024,
    })
    if (tree.code !== 0)
      throw new Error(tree.stderr || 'Cannot retain snapshot tree')
    treeId = tree.stdout.trim()
    const retained = await runGit(
      workspace.cwd,
      ['update-ref', `refs/forge/turn-snapshots/${id}`, treeId],
      false,
      { readOnly: false, maxOutputBytes: 64 * 1024 },
    )
    if (retained.code !== 0)
      throw new Error(retained.stderr || 'Cannot retain snapshot tree ref')
  } catch (cause) {
    state = 'unavailable'
    error = cause instanceof Error ? cause.message : String(cause)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
  input.db
    .prepare(
      `INSERT INTO git_turn_snapshots (id, session_id, turn_id, workspace_id, workspace_revision, checkout_key, tree_id, state, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.sessionId,
      input.turnId,
      workspace.workspaceId,
      workspace.workspaceRevision,
      workspace.checkoutKey,
      treeId,
      state,
      error,
      createdAt,
    )
  return {
    id,
    sessionId: input.sessionId,
    turnId: input.turnId,
    workspaceId: workspace.workspaceId,
    workspaceRevision: workspace.workspaceRevision,
    checkoutKey: workspace.checkoutKey,
    treeId,
    state,
    error,
    createdAt,
  }
}
export function latestTurnSnapshot(
  db: DatabaseSync,
  sessionId: string,
): TurnSnapshot | null {
  const row = db
    .prepare(
      'SELECT * FROM git_turn_snapshots WHERE session_id = ? ORDER BY created_at DESC LIMIT 1',
    )
    .get(sessionId) as Record<string, unknown> | undefined
  if (!row) return null
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    turnId: row.turn_id as string,
    workspaceId: row.workspace_id as string,
    workspaceRevision: row.workspace_revision as number,
    checkoutKey: row.checkout_key as string,
    treeId: row.tree_id as string | null,
    state: row.state as TurnSnapshot['state'],
    error: row.error as string | null,
    createdAt: row.created_at as number,
  }
}
