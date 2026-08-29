import {
  sessionResponseSchema,
  type SessionResponse,
} from '@forge/protocol/session'

type SessionRow = Record<string, unknown>

export function sessionResponse(row: SessionRow): SessionResponse {
  return sessionResponseSchema.parse({
    id: row.id,
    projectId: row.project_id,
    harness: row.harness,
    title: row.title,
    cwd: row.cwd,
    worktreePath: row.worktree_path ?? null,
    branch: row.branch ?? null,
    providerSessionId: row.provider_session_id ?? null,
    model: row.model ?? null,
    configOptions: parseConfigOptions(row.config_options),
    kind: row.kind,
    retention: row.retention,
    parentSessionId: row.parent_session_id ?? null,
    forkedAtSeq: row.forked_at_seq ?? null,
    spawnedBySeq: row.spawned_by_seq ?? null,
    epicRunId: row.epic_run_id ?? null,
    accountId: row.account_id ?? null,
    status: row.status,
    autoResume: row.auto_resume,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
    deletedAt: row.deleted_at ?? null,
  })
}

function parseConfigOptions(value: unknown) {
  if (typeof value !== 'string' || !value) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

export function sessionResponses(rows: SessionRow[]) {
  return rows.map(sessionResponse)
}
