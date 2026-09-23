import { useId, useState } from 'react'
import type { HarnessConfig } from '@forge/protocol/config'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

/**
 * Edits one harness's command, arguments (one per line), and the values of its
 * existing environment variables. Nothing is saved until the user presses Save.
 */
export function HarnessConfigDialog({
  harness,
  onOpenChange,
  onSave,
}: {
  harness: HarnessConfig
  onOpenChange: (open: boolean) => void
  onSave: (next: HarnessConfig) => Promise<void>
}) {
  const id = useId()
  const [command, setCommand] = useState(harness.command)
  const [args, setArgs] = useState(harness.args.join('\n'))
  const [env, setEnv] = useState(harness.env)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const envKeys = Object.keys(harness.env)

  const save = async () => {
    const trimmed = command.trim()
    if (!trimmed) {
      setError('Enter the command Forge starts for this agent.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onSave({
        ...harness,
        command: trimmed,
        args: args
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
        env,
      })
      onOpenChange(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !saving && onOpenChange(open)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="text-[15px] tracking-tight">
            Configure {harness.name}
          </DialogTitle>
          <DialogDescription className="text-[13px] leading-relaxed">
            These settings apply to every account of this agent.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-command`}>Command</Label>
            <Input
              id={`${id}-command`}
              className="font-mono"
              value={command}
              aria-invalid={error !== null && !command.trim()}
              onChange={(event) => setCommand(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-args`}>Arguments</Label>
            <Textarea
              id={`${id}-args`}
              className="font-mono"
              value={args}
              aria-describedby={`${id}-args-hint`}
              onChange={(event) => setArgs(event.target.value)}
            />
            <p id={`${id}-args-hint`} className="text-xs text-muted-foreground">
              One argument per line.
            </p>
          </div>
          {envKeys.length > 0 && (
            <fieldset className="grid gap-3">
              <legend className="mb-1.5 text-sm font-medium">
                Environment variables
              </legend>
              {envKeys.map((key) => (
                <div className="grid gap-1.5" key={key}>
                  <Label htmlFor={`${id}-env-${key}`}>
                    <code className="text-xs">{key}</code>
                  </Label>
                  <Input
                    id={`${id}-env-${key}`}
                    className="font-mono"
                    value={env[key] ?? ''}
                    onChange={(event) =>
                      setEnv((current) => ({
                        ...current,
                        [key]: event.target.value,
                      }))
                    }
                  />
                </div>
              ))}
            </fieldset>
          )}
          <p className="text-xs text-muted-foreground">
            Protocol: <code>{harness.protocol.toUpperCase()}</code>
          </p>
          {error && (
            <p role="alert" className="text-[13px] text-destructive">
              {error}
            </p>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="ghost"
            disabled={saving}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button disabled={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
