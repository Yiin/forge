import { useMemo, useState } from 'react'
import { Check, Circle, Cpu } from 'lucide-react'
import type { HarnessConfig } from '@forge/protocol/config'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import {
  ADD_HARNESS_STEPS,
  deriveHarnessId,
  HARNESS_KINDS,
  resolveWizardNavigation,
  validateAccountId,
  type HarnessKind,
} from './add-harness-logic'

type Draft = Pick<HarnessConfig, 'command' | 'args' | 'env' | 'protocol'>
const defaults: Record<HarnessKind, Draft> = {
  claude: { command: 'claude', args: [], env: {}, protocol: 'pty' },
  codex: { command: 'codex', args: [], env: {}, protocol: 'pty' },
  kimi: { command: 'kimi', args: [], env: {}, protocol: 'pty' },
  opencode: { command: 'opencode', args: [], env: {}, protocol: 'pty' },
}

export function AddHarnessDialog({
  open,
  onOpenChange,
  existingIds,
  onAdd,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  existingIds: Iterable<string>
  onAdd: (id: string, harness: HarnessConfig) => void
}) {
  const [step, setStep] = useState(0)
  const [kind, setKind] = useState<HarnessKind>('claude')
  const [label, setLabel] = useState('')
  const [idOverride, setIdOverride] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<HarnessKind, Draft>>(defaults)
  const [attempted, setAttempted] = useState(false)
  const id = idOverride ?? deriveHarnessId(kind, label)
  const idError = useMemo(
    () => validateAccountId(id, existingIds),
    [id, existingIds],
  )
  const draft = drafts[kind]
  const summaries = [kind, label.trim() || null, draft.command || null]
  const navigate = (requested: number) => {
    const result = resolveWizardNavigation(
      step,
      requested,
      ADD_HARNESS_STEPS.length,
      { idError },
    )
    if (result.kind === 'blocked') setAttempted(true)
    setStep(result.step)
  }
  const updateDraft = (patch: Partial<Draft>) =>
    setDrafts((all) => ({ ...all, [kind]: { ...all[kind], ...patch } }))
  const add = () => {
    setAttempted(true)
    if (idError) {
      setStep(1)
      return
    }
    onAdd(id, { name: label.trim() || id, ...draft, enabled: true })
    toast.success('Harness added', {
      description: `${kind} harness '${id}' was added.`,
    })
    onOpenChange(false)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Add harness</DialogTitle>
          <DialogDescription>
            Set the harness identity and command Forge will start.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-3 gap-2">
          {ADD_HARNESS_STEPS.map((name, index) => (
            <button
              key={name}
              type="button"
              className={cn(
                'grid min-w-0 grid-cols-[1rem_minmax(0,1fr)] gap-x-2 rounded-lg border px-3 py-2 text-left',
                index === step
                  ? 'border-primary bg-primary/10 ring-1 ring-primary/25'
                  : index < step
                    ? 'bg-background'
                    : 'bg-muted/40',
              )}
              aria-current={index === step ? 'step' : undefined}
              onClick={() => navigate(index)}
            >
              <span
                className="row-span-2 mt-0.5 grid size-4 place-items-center rounded-full border"
                aria-hidden
              >
                {index < step ? (
                  <Check className="size-3" />
                ) : (
                  <Circle className="size-2 fill-current" />
                )}
              </span>
              <span className="text-[10px] uppercase text-muted-foreground">
                Step {index + 1}
              </span>
              <span className="truncate text-xs font-semibold">
                {name}
                {index < step && summaries[index]
                  ? `: ${summaries[index]}`
                  : ''}
              </span>
            </button>
          ))}
        </div>
        {step === 0 && (
          <div className="grid grid-cols-2 gap-2">
            {HARNESS_KINDS.map((value) => (
              <button
                type="button"
                key={value}
                className={cn(
                  'flex items-center gap-3 rounded-lg border px-3 py-3 text-left',
                  value === kind && 'border-primary bg-primary/10',
                )}
                onClick={() => setKind(value)}
              >
                <Cpu className="size-5" />
                <span className="capitalize">{value}</span>
              </button>
            ))}
          </div>
        )}
        {step === 1 && (
          <div className="grid gap-4">
            <label className="grid gap-2 text-sm">
              Label
              <Input
                placeholder="e.g. Work"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
              <span className="text-xs text-muted-foreground">
                Shown in the harness list. Optional.
              </span>
            </label>
            <label className="grid gap-2 text-sm">
              Harness ID
              <Input
                placeholder={`${kind}_work`}
                value={id}
                aria-invalid={attempted && Boolean(idError)}
                onChange={(event) => setIdOverride(event.target.value)}
              />
              {attempted && idError ? (
                <span className="text-xs text-destructive">{idError}</span>
              ) : (
                <span className="text-xs text-muted-foreground">
                  Routing key used by sessions and epics.
                </span>
              )}
            </label>
          </div>
        )}
        {step === 2 && (
          <div className="grid gap-4">
            <label className="grid gap-2 text-sm">
              Command
              <Input
                value={draft.command}
                onChange={(event) =>
                  updateDraft({ command: event.target.value })
                }
              />
            </label>
            <label className="grid gap-2 text-sm">
              Arguments
              <Textarea
                value={draft.args.join('\n')}
                onChange={(event) =>
                  updateDraft({
                    args: event.target.value.split('\n').filter(Boolean),
                  })
                }
              />
            </label>
            <label className="grid gap-2 text-sm">
              Environment variables (KEY=VALUE)
              <Textarea
                value={Object.entries(draft.env)
                  .map(([key, value]) => `${key}=${value}`)
                  .join('\n')}
                onChange={(event) =>
                  updateDraft({
                    env: Object.fromEntries(
                      event.target.value
                        .split('\n')
                        .filter(Boolean)
                        .map((line) => {
                          const index = line.indexOf('=')
                          return index < 1
                            ? null
                            : [line.slice(0, index), line.slice(index + 1)]
                        })
                        .filter(
                          (entry): entry is [string, string] => entry !== null,
                        ),
                    ),
                  })
                }
              />
            </label>
            <label className="grid gap-2 text-sm">
              Protocol
              <Select
                value={draft.protocol}
                onValueChange={(value) =>
                  updateDraft({ protocol: value as Draft['protocol'] })
                }
              >
                <SelectTrigger aria-label="Protocol">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="acp">ACP</SelectItem>
                  <SelectItem value="pty">PTY</SelectItem>
                </SelectContent>
              </Select>
            </label>
          </div>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() =>
              step === 0 ? onOpenChange(false) : setStep((value) => value - 1)
            }
          >
            {step === 0 ? 'Cancel' : 'Back'}
          </Button>
          {step < 2 ? (
            <Button onClick={() => navigate(step + 1)}>Next</Button>
          ) : (
            <Button onClick={add}>Add harness</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
