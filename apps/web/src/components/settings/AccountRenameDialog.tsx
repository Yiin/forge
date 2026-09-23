import { LoaderCircle } from 'lucide-react'
import { useId, useState } from 'react'
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

/** Renames one account; the name shows when the account has no email. */
export function AccountRenameDialog({
  label,
  onSave,
  onClose,
}: {
  label: string
  /** Resolves to an error message, or null when the name was saved. */
  onSave: (label: string) => Promise<string | null>
  onClose: () => void
}) {
  const inputId = useId()
  const [value, setValue] = useState(label)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const next = value.trim()
  const save = async () => {
    if (!next || next === label || saving) return
    setSaving(true)
    setError(null)
    const failure = await onSave(next)
    setSaving(false)
    if (failure) setError(failure)
    else onClose()
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose()
      }}
    >
      <DialogContent className="max-w-sm">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <DialogHeader className="gap-1.5">
            <DialogTitle className="text-[15px] font-semibold tracking-tight">
              Rename account
            </DialogTitle>
            <DialogDescription className="text-[13px] leading-relaxed">
              The name only shows in Forge.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="grid gap-1.5">
            <Label htmlFor={inputId}>Name</Label>
            <Input
              id={inputId}
              value={value}
              autoFocus
              aria-invalid={error ? true : undefined}
              onChange={(event) => setValue(event.target.value)}
            />
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button
              type="button"
              variant="ghost"
              disabled={saving}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!next || next === label || saving}>
              {saving && <LoaderCircle className="motion-safe:animate-spin" />}
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
