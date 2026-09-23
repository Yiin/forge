import { LoaderCircle } from 'lucide-react'
import { useId, useState } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPanel,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

/**
 * Confirms deleting an account. When Forge created the credential home, a
 * checkbox (on by default) also removes that directory from the server.
 */
export function AccountDeleteDialog({
  accountName,
  managedHome,
  onDelete,
  onClose,
}: {
  accountName: string
  managedHome: boolean
  /** Resolves to an error message, or null when the account is gone. */
  onDelete: (removeHome: boolean) => Promise<string | null>
  onClose: () => void
}) {
  const labelId = useId()
  const [removeHome, setRemoveHome] = useState(true)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const confirm = async () => {
    setDeleting(true)
    setError(null)
    const failure = await onDelete(managedHome && removeHome)
    setDeleting(false)
    if (failure) setError(failure)
    else onClose()
  }
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !deleting) onClose()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="text-[15px] font-semibold tracking-tight">
            Delete {accountName}?
          </AlertDialogTitle>
          <AlertDialogDescription className="text-[13px] leading-relaxed">
            Forge forgets this account and its saved sign-in. Running sessions
            on it keep going until they end.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {(managedHome || error) && (
          <AlertDialogPanel className="grid gap-3">
            {managedHome && (
              <label className="flex items-start gap-3 rounded-lg border p-3">
                <Checkbox
                  checked={removeHome}
                  onCheckedChange={(value) => setRemoveHome(value === true)}
                  aria-labelledby={labelId}
                />
                <span className="grid gap-0.5 text-[13px]">
                  <span id={labelId} className="font-medium">
                    Delete managed credential home
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Remove this account&apos;s credential directory from the
                    server.
                  </span>
                </span>
              </label>
            )}
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
          </AlertDialogPanel>
        )}
        <AlertDialogFooter variant="bare">
          <AlertDialogCancel variant="ghost" disabled={deleting}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={deleting}
            onClick={(event) => {
              event.preventDefault()
              void confirm()
            }}
          >
            {deleting && <LoaderCircle className="motion-safe:animate-spin" />}
            {deleting ? 'Deleting…' : 'Delete account'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
