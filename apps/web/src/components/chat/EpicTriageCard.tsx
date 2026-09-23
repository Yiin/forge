import { AlertTriangle, Play, SkipForward } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { api } from '../../lib/api'
import type { ChatRenderItem } from './render-model'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog'
import { Button } from '../ui/button'

export function EpicTriageCard({
  card,
}: {
  card: Extract<ChatRenderItem, { kind: 'epic-triage' }>['card']
}) {
  const [busy, setBusy] = useState(false)
  const [confirmSkip, setConfirmSkip] = useState(false)
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
    <section
      className="flex flex-col gap-2 rounded-[10px] border border-destructive/16 bg-destructive/5 px-2.5 py-2 text-xs leading-4"
      aria-label="Epic run needs attention"
    >
      <div className="flex items-center gap-2">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-destructive/12">
          <AlertTriangle
            className="size-3 text-destructive-foreground/80"
            aria-hidden="true"
          />
        </span>
        <h2 className="font-medium text-destructive-foreground/80">
          Run paused after a failure
        </h2>
      </div>
      <p className="text-foreground/80">
        {labelFor(card.classification)} failure in child {card.beadId}.{' '}
        {card.attempts} {card.attempts === 1 ? 'attempt' : 'attempts'} recorded.
      </p>
      {card.failureChain.length > 0 && (
        <div className="flex flex-col gap-1">
          {card.failureChain.map((failure) => (
            <details
              key={`${failure.attempt}-${failure.signature}`}
              className="rounded-md bg-ink/4"
            >
              <summary className="cursor-pointer px-2 py-1 text-muted-foreground hover:text-foreground">
                Attempt {failure.attempt} · {failure.signature.slice(0, 12)}
              </summary>
              <pre className="max-h-64 overflow-auto px-2 pb-2 font-mono text-[11px] leading-4 whitespace-pre-wrap text-foreground/80">
                {failure.excerpt}
              </pre>
            </details>
          ))}
        </div>
      )}
      <div className="flex gap-1.5">
        <Button size="xs" disabled={busy} onClick={() => void act()}>
          <Play aria-hidden="true" /> Resume
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={busy}
          onClick={() => setConfirmSkip(true)}
        >
          <SkipForward aria-hidden="true" /> Skip child
        </Button>
      </div>
      <AlertDialog open={confirmSkip} onOpenChange={setConfirmSkip}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Skip failed child?</AlertDialogTitle>
            <AlertDialogDescription>
              This skips child {card.beadId} and resumes the epic run.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => {
                setConfirmSkip(false)
                void act(card.beadId)
              }}
            >
              Skip child
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

function labelFor(classification: 'code' | 'infra' | 'unknown') {
  return classification === 'infra'
    ? 'Infrastructure'
    : classification === 'code'
      ? 'Code'
      : 'Unknown'
}
