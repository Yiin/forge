import { LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { logout } from '@/lib/accounts-api'
import { isManagedAccountHome } from '@/lib/harness-accounts-logic'
import { Checkbox } from '@/components/ui/checkbox'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

type Props = {
  displayName: string
  accountId: string
  harnessKind: string
  homePath: string | null
  accountsDir?: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onFinished?: () => void
}

export function AccountSignOutDialog({
  displayName,
  accountId,
  harnessKind,
  homePath,
  accountsDir,
  open,
  onOpenChange,
  onFinished,
}: Props) {
  const [checked, setChecked] = useState(false)
  const [pending, setPending] = useState(false)
  const canDelete = isManagedAccountHome({
    homePath,
    accountsDir,
    harnessKind,
    accountId,
  })

  useEffect(() => {
    if (open) setChecked(false)
  }, [open])

  const signOut = async () => {
    setPending(true)
    try {
      await logout({ accountId, deleteAccountHome: checked })
      toast.success(`Signed out of ${displayName}`, {
        description: checked
          ? 'The managed credential home was also deleted.'
          : 'The account remains in your harness list.',
      })
      onFinished?.()
      onOpenChange(false)
    } catch {
      toast.error(`Could not sign out of ${displayName}`, {
        description: 'The logout command failed.',
      })
    } finally {
      setPending(false)
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Sign out of {displayName}?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the account credentials. The account stays in your
            harness list.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {canDelete && (
          <label className="flex items-start gap-3 rounded-md border p-3">
            <Checkbox
              checked={checked}
              onCheckedChange={(value) => setChecked(value === true)}
              aria-label="Also delete the managed credential home"
            />
            <span className="grid gap-1 text-sm">
              <strong>Delete managed credential home</strong>
              <span className="text-muted-foreground">
                Remove this account&apos;s credential directory from the server.
              </span>
            </span>
          </label>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={(event) => {
              event.preventDefault()
              void signOut()
            }}
          >
            {pending && <LoaderCircle className="animate-spin" />}
            {pending ? 'Signing out' : 'Sign out'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
