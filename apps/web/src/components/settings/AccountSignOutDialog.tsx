import { LoaderCircle } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
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
  AlertDialogPanel,
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
  const deleteHomeLabelId = useId()
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
          : 'The account stays in Forge.',
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
          <AlertDialogTitle className="text-[15px] font-semibold tracking-tight">
            Sign out of {displayName}?
          </AlertDialogTitle>
          <AlertDialogDescription className="text-[13px] leading-relaxed">
            This removes the saved sign-in. The account stays in Forge, so you
            can sign in again later.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {canDelete && (
          <AlertDialogPanel>
            <label className="flex items-start gap-3 rounded-lg border p-3">
              <Checkbox
                checked={checked}
                onCheckedChange={(value) => setChecked(value === true)}
                aria-labelledby={deleteHomeLabelId}
              />
              <span className="grid gap-0.5 text-[13px]">
                <span id={deleteHomeLabelId} className="font-medium">
                  Delete managed credential home
                </span>
                <span className="text-xs text-muted-foreground">
                  Remove this account&apos;s credential directory from the
                  server.
                </span>
              </span>
            </label>
          </AlertDialogPanel>
        )}
        <AlertDialogFooter variant="bare">
          <AlertDialogCancel variant="ghost" disabled={pending}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={(event) => {
              event.preventDefault()
              void signOut()
            }}
          >
            {pending && <LoaderCircle className="motion-safe:animate-spin" />}
            {pending ? 'Signing out…' : 'Sign out'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
