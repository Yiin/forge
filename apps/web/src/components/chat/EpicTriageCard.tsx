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
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../ui/card'

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
    <Card
      className="mx-auto mb-3 max-w-[760px] gap-4 border-destructive/30 bg-destructive/5 py-4"
      aria-label="Epic run needs attention"
    >
      <CardHeader className="px-4">
        <div className="flex items-start gap-3">
          <AlertTriangle
            className="mt-0.5 size-[18px] shrink-0 text-destructive"
            aria-hidden="true"
          />
          <div className="space-y-1">
            <CardTitle>Run paused after a failure</CardTitle>
            <CardDescription>
              {labelFor(card.classification)} failure in child {card.beadId}.{' '}
              {card.attempts} {card.attempts === 1 ? 'attempt' : 'attempts'}{' '}
              recorded.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-1.5 px-4">
        {card.failureChain.map((failure) => (
          <details
            key={`${failure.attempt}-${failure.signature}`}
            className="rounded-md border border-border bg-card"
          >
            <summary className="cursor-pointer px-3 py-1.5 text-xs text-muted-foreground">
              Attempt {failure.attempt} · {failure.signature.slice(0, 12)}
            </summary>
            <pre className="overflow-auto border-t border-border p-3 text-xs whitespace-pre-wrap text-muted-foreground">
              {failure.excerpt}
            </pre>
          </details>
        ))}
      </CardContent>
      <CardFooter className="gap-2 px-4">
        <Button size="sm" disabled={busy} onClick={() => void act()}>
          <Play className="size-3.5" aria-hidden="true" /> Resume
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => setConfirmSkip(true)}
        >
          <SkipForward className="size-3.5" aria-hidden="true" /> Skip child
        </Button>
      </CardFooter>
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
    </Card>
  )
}

function labelFor(classification: 'code' | 'infra' | 'unknown') {
  return classification === 'infra'
    ? 'Infrastructure'
    : classification === 'code'
      ? 'Code'
      : 'Unknown'
}
