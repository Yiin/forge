import { useEffect, useState } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { Composer } from '../components/chat/Composer'
import { api } from '../lib/api'
import { useDraftsStore } from '../stores/drafts'
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select'
import type { ProjectSummary } from '../stores/sessions'

export function DraftRoute() {
  const { draftId } = useParams({ from: '/draft/$draftId' })
  const navigate = useNavigate()
  const draft = useDraftsStore((state) => state.drafts[draftId])
  const hydrate = useDraftsStore((state) => state.hydrate)
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    hydrate()
    void api
      .listProjects()
      .then((value) => {
        const projects = Array.isArray(value)
          ? value
          : ((value as { projects?: unknown[] }).projects ?? [])
        const normalized = projects.map((project) => ({
          id: String((project as { id: string }).id),
          name: String(
            (project as { name?: string }).name ?? 'Unnamed project',
          ),
          path: (project as { path?: string }).path,
        }))
        setProjects(normalized)
        const ids = normalized.map((project) => project.id)
        useDraftsStore.getState().removeInvalid(ids)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [draftId, hydrate])
  if (loading)
    return (
      <section className="empty-panel" role="status">
        <p>Loading draft…</p>
      </section>
    )
  if (!draft || !projects.some((project) => project.id === draft.projectId))
    return (
      <section className="empty-panel">
        <h1>Draft not found</h1>
        <p>This local draft is no longer available.</p>
      </section>
    )
  return (
    <section className="session-view draft-view" aria-label="Local draft">
      <header className="draft-hero">
        <span className="session-context-label">Local draft</span>
        <h1>What do you want to build?</h1>
        <label className="draft-project-label" htmlFor="draft-project">
          Project
        </label>
        <Select
          value={draft.projectId}
          onValueChange={(value) => {
            if (typeof value !== 'string' || value === draft.projectId) return
            const next = useDraftsStore.getState().getOrCreate(value)
            void navigate({
              to: '/draft/$draftId',
              params: { draftId: next.id },
              replace: true,
            })
          }}
        >
          <SelectTrigger id="draft-project" aria-label="Draft project">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </header>
      <Composer
        sessionId={draft.id}
        draftProjectId={draft.projectId}
        harness={draft.harness}
        draftMode
        initialText={draft.prompt}
        onTextChange={(prompt) =>
          useDraftsStore.getState().update(draft.id, { prompt })
        }
        onSend={async (text, attachmentIds, selectedHarness) => {
          useDraftsStore
            .getState()
            .update(draft.id, { promotionState: 'promoting' })
          try {
            const result = (await api.promoteDraft({
              draftId: draft.id,
              projectId: draft.projectId,
              harness: selectedHarness || draft.harness,
              text,
              attachmentIds,
            })) as { sessionId: string }
            useDraftsStore
              .getState()
              .update(draft.id, { promotionState: 'promoted' })
            await navigate({
              to: '/s/$sessionId',
              params: { sessionId: result.sessionId },
            })
          } catch (error) {
            useDraftsStore
              .getState()
              .update(draft.id, { promotionState: 'failed' })
            throw error
          }
        }}
      />
    </section>
  )
}
