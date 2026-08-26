import { useEffect, useState } from 'react'
import { useParams } from '@tanstack/react-router'
import { Composer } from '../components/chat/Composer'
import { api } from '../lib/api'
import { useDraftsStore } from '../stores/drafts'

export function DraftRoute() {
  const { draftId } = useParams({ from: '/draft/$draftId' })
  const draft = useDraftsStore((state) => state.drafts[draftId])
  const hydrate = useDraftsStore((state) => state.hydrate)
  const [projectMissing, setProjectMissing] = useState(false)
  useEffect(() => {
    hydrate()
    void api
      .listProjects()
      .then((value) => {
        const projects = Array.isArray(value)
          ? value
          : ((value as { projects?: unknown[] }).projects ?? [])
        const ids = projects.map((project) =>
          String((project as { id: string }).id),
        )
        useDraftsStore.getState().removeInvalid(ids)
        setProjectMissing(!useDraftsStore.getState().drafts[draftId])
      })
      .catch(() => undefined)
  }, [draftId, hydrate])
  if (!draft || projectMissing)
    return (
      <section className="empty-panel">
        <h1>Draft not found</h1>
        <p>This local draft is no longer available.</p>
      </section>
    )
  return (
    <section className="session-view draft-view" aria-label="Local draft">
      <header className="session-header">
        <div className="session-heading">
          <h1>New draft</h1>
          <span className="session-context-label">Local draft</span>
        </div>
      </header>
      <Composer
        sessionId={draft.id}
        harness={draft.harness}
        draftMode
        initialText={draft.prompt}
        onTextChange={(prompt) =>
          useDraftsStore.getState().update(draft.id, { prompt })
        }
        onSend={async () => {
          throw new Error('Draft promotion is not available yet')
        }}
      />
    </section>
  )
}
