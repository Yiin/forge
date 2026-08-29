import { Check, Copy, ExternalLink, LoaderCircle, Send } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { LoginRunState } from '@/lib/accounts-api'
import { loginCancel, loginRespond, loginStatus } from '@/lib/accounts-api'
import { reduceLoginRunState } from './account-login-logic'
import { Badge } from '@/components/ui/badge'
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

export type AccountLoginStart = { terminalId: string; state: LoginRunState }

type Props = {
  accountName: string
  start: AccountLoginStart
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenChangeComplete?: (open: boolean) => void
}

const statusPresentation = {
  idle: ['Starting', 'secondary'],
  running: ['Waiting', 'info'],
  succeeded: ['Signed in', 'success'],
  failed: ['Failed', 'error'],
  cancelled: ['Cancelled', 'secondary'],
} as const

const terminal = (status: LoginRunState['status']) =>
  status === 'succeeded' || status === 'failed' || status === 'cancelled'

export function AccountLoginDialog({
  accountName,
  start,
  open,
  onOpenChange,
  onOpenChangeComplete,
}: Props) {
  const [state, setState] = useState(start.state)
  const stateRef = useRef(state)
  const mounted = useRef(false)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)
  const [streamError, setStreamError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  stateRef.current = state

  useEffect(() => {
    const stop = loginStatus(start.terminalId, (incoming) => {
      const next = reduceLoginRunState(stateRef.current, incoming)
      stateRef.current = next
      setState(next)
      if (!terminal(incoming.status)) setStreamError(null)
    })
    return stop
  }, [start.terminalId])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      queueMicrotask(() => {
        if (!mounted.current && stateRef.current.status === 'running')
          void loginCancel({ terminalId: start.terminalId })
      })
    }
  }, [start.terminalId])

  const requestClose = async () => {
    if (state.status !== 'running') {
      onOpenChange(false)
      return
    }
    if (cancelling) return
    setCancelling(true)
    setCancelError(null)
    try {
      const next = await loginCancel({ terminalId: start.terminalId })
      const merged = reduceLoginRunState(stateRef.current, next)
      stateRef.current = merged
      setState(merged)
      onOpenChange(false)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setCancelError(message)
      toast.error('Could not cancel sign-in', { description: message })
    } finally {
      setCancelling(false)
    }
  }

  const submitInput = async () => {
    const data = input.trim()
    if (!data || sending || state.status !== 'running') return
    setSending(true)
    try {
      const next = await loginRespond({ terminalId: start.terminalId, data })
      const merged = reduceLoginRunState(stateRef.current, next)
      stateRef.current = merged
      setState(merged)
      setInput('')
    } catch {
      toast.error('Could not send the code')
    } finally {
      setSending(false)
    }
  }

  const copyCode = async () => {
    if (!state.userCode) return
    try {
      await navigator.clipboard.writeText(state.userCode)
      setCopied(true)
      toast.success('Authentication code copied')
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('Could not copy authentication code')
    }
  }

  const [label, variant] = statusPresentation[state.status]
  return (
    <Dialog
      open={open}
      disablePointerDismissal
      onOpenChange={(next) => {
        if (next) return onOpenChange(true)
        if (state.status === 'running') return void requestClose()
        onOpenChange(false)
      }}
      onOpenChangeComplete={() => onOpenChangeComplete?.(open)}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <div className="flex min-w-0 items-center gap-2 pr-8">
            <DialogTitle className="truncate">
              Sign in to {accountName}
            </DialogTitle>
            <Badge variant={variant}>{label}</Badge>
          </div>
          <DialogDescription>
            Finish the provider&apos;s browser or device flow. This window
            updates as the command runs.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="min-w-0 space-y-4">
          {state.verificationUrl && (
            <div className="grid gap-1.5">
              <span className="text-xs font-medium">Verification page</span>
              <a
                className="flex min-w-0 items-center gap-1.5 text-sm text-primary underline break-all"
                href={state.verificationUrl}
                target="_blank"
                rel="noreferrer"
              >
                {state.verificationUrl}
                <ExternalLink className="size-3.5 shrink-0" aria-hidden />
              </a>
            </div>
          )}
          {state.userCode && (
            <div className="grid gap-1.5">
              <span className="text-xs font-medium">
                Device code — enter it on the verification page
              </span>
              <div className="flex items-center gap-2 rounded-lg border bg-muted/35 p-2">
                <code className="min-w-0 flex-1 break-all px-1 font-mono text-sm font-semibold tracking-wide select-all">
                  {state.userCode}
                </code>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void copyCode()}
                >
                  {copied ? <Check /> : <Copy />}
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
            </div>
          )}
          {state.status === 'running' && (
            <form
              className="grid gap-1.5"
              onSubmit={(event) => {
                event.preventDefault()
                void submitInput()
              }}
            >
              <label
                htmlFor="account-login-input"
                className="text-xs font-medium"
              >
                Send input to the command
              </label>
              <div className="flex items-center gap-2">
                <Input
                  id="account-login-input"
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  placeholder="Paste the code from your browser and press Enter"
                />
                <Button
                  type="submit"
                  size="sm"
                  variant="outline"
                  disabled={!input.trim() || sending}
                >
                  {sending && <LoaderCircle className="animate-spin" />}
                  <Send />
                  Send
                </Button>
              </div>
            </form>
          )}
          <div className="grid gap-1.5">
            <span className="text-xs font-medium">Command output</span>
            <pre className="min-h-24 overflow-auto rounded-lg border bg-muted/35 p-3 font-mono text-[11px] whitespace-pre-wrap">
              {state.output || 'Waiting for the provider command…'}
            </pre>
          </div>
          <div
            className="min-h-5 text-xs text-muted-foreground"
            aria-live="polite"
          >
            {cancelError ??
              streamError ??
              state.message ??
              'Waiting for an update.'}
          </div>
        </DialogPanel>
        <DialogFooter>
          {state.status === 'running' ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => void requestClose()}
              disabled={cancelling}
            >
              {cancelling && <LoaderCircle className="animate-spin" />}
              {cancelling ? 'Cancelling' : 'Cancel'}
            </Button>
          ) : (
            <Button type="button" onClick={() => void requestClose()}>
              Done
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
