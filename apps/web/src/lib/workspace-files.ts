import type {
  ResolvedWorkspace,
  WorkspaceEntry,
  WorkspaceErrorCode,
  WorkspaceSearch,
  WorkspaceSnapshot,
} from '@forge/protocol/workspace'

export type WorkspaceSelection = {
  sessionId: string
  workspaceId?: string | null
  workspaceRevision?: number | null
}

export class WorkspaceFilesError extends Error {
  constructor(
    message: string,
    readonly code?: WorkspaceErrorCode,
    readonly current?: unknown,
  ) {
    super(message)
    this.name = 'WorkspaceFilesError'
  }
}

function query(selection: WorkspaceSelection, extra: Record<string, string>) {
  const params = new URLSearchParams({
    kind: 'session',
    sessionId: selection.sessionId,
    ...extra,
  })
  if (selection.workspaceId)
    params.set('expectedWorkspaceId', selection.workspaceId)
  if (selection.workspaceRevision)
    params.set('expectedWorkspaceRevision', String(selection.workspaceRevision))
  return params
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (response.ok) return (await response.json()) as T
  const body = (await response.json().catch(() => null)) as {
    message?: string
    error?: WorkspaceErrorCode
    current?: WorkspaceSnapshot['file']
  } | null
  throw new WorkspaceFilesError(
    body?.message ?? `Workspace request failed (${response.status})`,
    body?.error,
    body?.current,
  )
}

export async function listWorkspaceFiles(
  selection: WorkspaceSelection,
  path = '',
  includeIgnored = false,
) {
  return request<{
    workspace: ResolvedWorkspace
    entries: WorkspaceEntry[]
    nextCursor: string | null
    truncated: boolean
    partialReasons: string[]
  }>(
    `/api/workspace/files?${query(selection, {
      path,
      includeHidden: 'true',
      includeIgnored: String(includeIgnored),
    })}`,
  )
}

export async function searchWorkspaceFiles(
  selection: WorkspaceSelection,
  text: string,
  includeIgnored = false,
) {
  return request<WorkspaceSearch>(
    `/api/workspace/search?${query(selection, {
      query: text,
      includeHidden: 'true',
      includeIgnored: String(includeIgnored),
    })}`,
  )
}

export function workspaceFileUrl(selection: WorkspaceSelection, path: string) {
  return `/api/workspace/file?${query(selection, { path })}`
}

export async function readWorkspaceFile(
  selection: WorkspaceSelection,
  path: string,
) {
  return request<WorkspaceSnapshot>(workspaceFileUrl(selection, path))
}

export async function saveWorkspaceFile(
  selection: WorkspaceSelection,
  snapshot: WorkspaceSnapshot,
  text: string,
) {
  return request<WorkspaceSnapshot>('/api/workspace/file', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      target: { kind: 'session', sessionId: selection.sessionId },
      path: snapshot.file.path,
      expectedWorkspaceId: snapshot.workspace.workspaceId,
      expectedWorkspaceRevision: snapshot.workspace.workspaceRevision,
      expectedContentHash: snapshot.file.contentHash,
      expectedFileRevision: snapshot.file.fileRevision,
      text: text.replaceAll('\r\n', '\n').replaceAll('\r', '\n'),
    }),
  })
}
