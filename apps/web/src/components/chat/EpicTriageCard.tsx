import { AlertTriangle, Play, SkipForward } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { api } from '../../lib/api'
import type { ChatRenderItem } from './render-model'

export function EpicTriageCard({
  card,
}: {
  card: Extract<ChatRenderItem, { kind: 'epic-triage' }>['card']
}) {
  const [busy, setBusy] = useState(false)
  const act = async (skipBead?: string) => {
    setBusy(true)
    try {
      await api.runAction(card.runId, 'resume', { skipBead })
      toast.success(skipBead ? 'Child skipped. Run resumed.' : 'Run resumed.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Run action failed')
    } finally {
      setBusy(false)
    }
  }
  return (
    <article className="epic-triage-card" aria-label="Epic run needs attention">
      <div className="epic-triage-heading">
        <AlertTriangle size={18} aria-hidden="true" />
        <div>
          <strong>Run paused after a failure</strong>
          <p>
            {labelFor(card.classification)} failure in child {card.beadId}.{' '}
            {card.attempts} {card.attempts === 1 ? 'attempt' : 'attempts'}{' '}
            recorded.
          </p>
        </div>
      </div>
      <div className="epic-triage-chain">
        {card.failureChain.map((failure) => (
          <details key={`${failure.attempt}-${failure.signature}`}>
            <summary>
              Attempt {failure.attempt} · {failure.signature.slice(0, 12)}
            </summary>
            <pre>{failure.excerpt}</pre>
          </details>
        ))}
      </div>
      <div className="epic-triage-actions">
        <button disabled={busy} onClick={() => void act()}>
          <Play size={15} aria-hidden="true" /> Resume
        </button>
        <button disabled={busy} onClick={() => void act(card.beadId)}>
          <SkipForward size={15} aria-hidden="true" /> Skip child
        </button>
      </div>
    </article>
  )
}

function labelFor(classification: 'code' | 'infra' | 'unknown') {
  return classification === 'infra'
    ? 'Infrastructure'
    : classification === 'code'
      ? 'Code'
      : 'Unknown'
}
