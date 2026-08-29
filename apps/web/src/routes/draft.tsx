import { useEffect, useState } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { Composer } from '../components/chat/Composer'
import { api } from '../lib/api'
import { useDraftsStore } from '../stores/drafts'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
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
      <section
        className="grid h-full place-content-center text-center text-sm text-muted-foreground"
        role="status"
      >
        <p>Loading draft…</p>
      </section>
    )
  if (!draft || !projects.some((project) => project.id === draft.projectId))
    return (
      <section className="grid h-full place-content-center gap-2 text-center">
        <h1 className="text-xl font-semibold tracking-tight">
          Draft not found
        </h1>
        <p className="text-sm text-muted-foreground">
          This local draft is no longer available.
        </p>
      </section>
    )
  return (
    <section
      className="relative flex h-full min-h-0 flex-col"
      aria-label="Local draft"
    >
      <div className="m-auto flex w-full max-w-2xl flex-col items-center gap-6 px-4 py-10">
        <header className="flex flex-col items-center gap-3 text-center">
          <Badge variant="outline" className="uppercase tracking-wide">
            Local draft
          </Badge>
          <h1 className="text-2xl font-semibold tracking-tight">
            What do you want to build?
          </h1>
          <div className="flex flex-col items-center gap-1.5">
            <label className="sr-only" htmlFor="draft-project">
              Project
            </label>
            <Select
              value={draft.projectId}
              onValueChange={(value) => {
                if (value === draft.projectId) return
                const next = useDraftsStore.getState().getOrCreate(value)
                void navigate({
                  to: '/draft/$draftId',
                  params: { draftId: next.id },
                  replace: true,
                })
              }}
            >
              <SelectTrigger
                id="draft-project"
                aria-label="Draft project"
                className="min-w-[220px]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </header>
        <Composer
          sessionId={draft.id}
          draftProjectId={draft.projectId}
          harness={draft.harness}
          accountId={draft.accountId}
          draftMode
          initialText={draft.prompt}
          onTextChange={(prompt) =>
            useDraftsStore.getState().update(draft.id, { prompt })
          }
          onSelectionChange={(selection) =>
            useDraftsStore.getState().update(draft.id, {
              harness: selection.harness,
              accountId: selection.accountId,
            })
          }
          onSend={async (text, attachmentIds, selectedHarness) => {
            useDraftsStore.getState().update(draft.id, {
              harness: selectedHarness.harness,
              accountId: selectedHarness.accountId,
            })
            useDraftsStore
              .getState()
              .update(draft.id, { promotionState: 'promoting' })
            try {
              const result = (await api.promoteDraft({
                draftId: draft.id,
                projectId: draft.projectId,
                harness: selectedHarness.harness || draft.harness,
                accountId: selectedHarness.accountId,
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
      </div>
    </section>
  )
}
