import { useEffect, useState } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { Composer } from '../components/chat/Composer'
import { WorkspaceBar } from '../components/chat/WorkspaceBar'
import { DestinationChips } from '../components/composer/DestinationChips'
import { openProjectCreation } from '../components/ProjectCreationDialog'
import { api } from '../lib/api'
import { promoteDraftWithKey } from '../lib/draft-promotion'
import { useDraftsStore } from '../stores/drafts'
import { useMessagesStore } from '../stores/messages'
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
        className="grid h-full place-content-center text-center text-[13px] text-muted-foreground"
        role="status"
      >
        <p>Loading draft…</p>
      </section>
    )
  if (
    !draft ||
    (draft.projectId &&
      !projects.some((project) => project.id === draft.projectId))
  )
    return (
      <section className="grid h-full place-content-center gap-1.5 text-center">
        <h1 className="text-[16px] font-medium text-foreground">
          Draft not found
        </h1>
        <p className="text-[13px] text-muted-foreground">
          This local draft is no longer available.
        </p>
      </section>
    )
  const openDraft = (next: { id: string }) =>
    navigate({
      to: '/draft/$draftId',
      params: { draftId: next.id },
      replace: true,
    })
  const promoting = draft.promotionState === 'promoting'
  // zeron's new thread: an empty canvas with the composer centred 8px low,
  // the destination chips above the pill, and the Git chips below it.
  return (
    <section
      data-chat-pane
      aria-label="New session"
      className="relative flex h-full min-h-0 flex-col overflow-y-auto"
    >
      <div className="m-auto w-full max-w-3xl px-4 pt-12 pb-8">
        <Composer
          sessionId={draft.id}
          draftProjectId={draft.projectId}
          harness={draft.harness}
          accountId={draft.accountId}
          model={draft.model}
          draftMode
          sending={promoting}
          initialText={draft.prompt}
          destination={
            <>
              {promoting && (
                <span
                  role="status"
                  className="mr-auto truncate text-[12px] text-muted-foreground"
                >
                  Starting session…
                </span>
              )}
              <DestinationChips
                projects={projects}
                projectId={draft.projectId}
                targetPath={draft.targetPath}
                disabled={promoting}
                onProject={(id) =>
                  void openDraft(useDraftsStore.getState().getOrCreate(id))
                }
                onNewProject={openProjectCreation}
                onNoProject={() =>
                  void api
                    .listDirectories()
                    .catch(() => null)
                    .then((listing) => {
                      const path = (listing as { path?: string } | null)?.path
                      if (!path) return
                      return openDraft(
                        useDraftsStore
                          .getState()
                          .getOrCreate(undefined, undefined, undefined, path),
                      )
                    })
                }
                onFolder={(targetPath) =>
                  useDraftsStore.getState().update(draft.id, { targetPath })
                }
              />
            </>
          }
          footer={
            draft.projectId ? (
              <WorkspaceBar projectId={draft.projectId} draftId={draft.id} />
            ) : undefined
          }
          onTextChange={(prompt) =>
            useDraftsStore.getState().update(draft.id, { prompt })
          }
          onSelectionChange={(selection) =>
            useDraftsStore.getState().update(draft.id, {
              harness: selection.harness,
              accountId: selection.accountId,
              model: selection.model,
            })
          }
          onSend={async (text, attachmentIds, selectedHarness) => {
            const clientItemId = `client_${crypto.randomUUID().replaceAll('-', '')}`
            useDraftsStore.getState().update(draft.id, {
              harness: selectedHarness.harness,
              accountId: selectedHarness.accountId,
              model: selectedHarness.model,
            })
            const result = await promoteDraftWithKey(draft, {
              text,
              attachmentIds,
              harness: selectedHarness.harness,
              accountId: selectedHarness.accountId,
              model: selectedHarness.model,
              clientItemId,
              workspace: {
                mode: draft.workspaceMode ?? 'local',
                baseRef: draft.baseRef,
              },
              targetPath: draft.targetPath,
            })
            useMessagesStore.getState().addPending({
              sessionId: result.sessionId,
              itemId: clientItemId,
              text,
              createdAt: new Date().toISOString(),
            })
            await navigate({
              to: '/s/$sessionId',
              params: { sessionId: result.sessionId },
            })
          }}
        />
      </div>
    </section>
  )
}
