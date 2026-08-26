import type { NavigateFn } from '@tanstack/react-router'
import { api } from './api'
import { useDraftsStore } from '../stores/drafts'
import {
  useSessionsStore,
  type ProjectSummary,
  type SessionSummary,
} from '../stores/sessions'

type WireProject = ProjectSummary & {
  created_at?: number
  archived_at?: number | null
  deleted_at?: number | null
}

type WireSession = SessionSummary & {
  project_id?: string | null
  parent_session_id?: string | null
  last_activity_at?: number
  deleted_at?: number | null
}

export type DraftEntryResult =
  | { kind: 'draft'; draftId: string }
  | { kind: 'empty' }

function normalizeProject(value: WireProject): ProjectSummary & { createdAt?: number } {
  return {
    id: String(value.id),
    name: value.name,
    path: value.path,
    createdAt: value.createdAt ?? value.created_at,
    archivedAt: value.archivedAt ?? value.archived_at ?? value.deleted_at,
  }
}

export function normalizeSession(value: WireSession): SessionSummary {
  return {
    ...value,
    id: String(value.id),
    projectId: value.projectId ?? value.project_id,
    parentSessionId: value.parentSessionId ?? value.parent_session_id,
    lastActivityAt: value.lastActivityAt ?? value.last_activity_at,
    deletedAt: value.deletedAt ?? value.deleted_at,
  }
}

export function selectDraftProject(
  projects: Array<ProjectSummary & { createdAt?: number }>,
  sessions: SessionSummary[],
) {
  const active = projects.filter(
    (project) => project.id && project.archivedAt == null,
  )
  const ids = new Set(active.map((project) => project.id))
  const recent = sessions
    .filter(
      (session) =>
        session.projectId &&
        ids.has(session.projectId) &&
        (!session.kind || session.kind === 'chat') &&
        !session.parentSessionId &&
        session.deletedAt == null,
    )
    .sort((a, b) => activityTime(b) - activityTime(a))[0]
  if (recent?.projectId) return active.find((project) => project.id === recent.projectId)
  return [...active].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0]
}

function activityTime(session: SessionSummary) {
  const value = session.lastActivityAt ?? session.createdAt ?? session.created_at
  if (typeof value === 'number') return value
  return value ? Date.parse(value) || 0 : 0
}

export async function openNewDraft(navigate: NavigateFn): Promise<DraftEntryResult> {
  const [projectData, sessionData] = await Promise.all([
    api.listProjects(),
    api.listSessions(),
  ])
  const projectValues = Array.isArray(projectData)
    ? projectData
    : ((projectData as { projects?: unknown[] }).projects ?? [])
  const sessionValues = Array.isArray(sessionData)
    ? sessionData
    : ((sessionData as { sessions?: unknown[] }).sessions ?? [])
  const projects = projectValues.map((value) => normalizeProject(value as WireProject))
  const sessions = sessionValues.map((value) => normalizeSession(value as WireSession))
  useSessionsStore.getState().setProjects(projects)
  useSessionsStore.getState().setSessions(sessions)
  useDraftsStore.getState().hydrate()
  useDraftsStore.getState().removeInvalid(projects.map((project) => project.id))
  const project = selectDraftProject(projects, sessions)
  if (!project) return { kind: 'empty' }
  const draft = useDraftsStore.getState().getOrCreate(project.id)
  await navigate({ to: '/draft/$draftId', params: { draftId: draft.id }, replace: true })
  return { kind: 'draft', draftId: draft.id }
}
