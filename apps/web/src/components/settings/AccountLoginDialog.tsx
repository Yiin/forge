import { Check, Copy, ExternalLink, LoaderCircle } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type { LoginRunState } from '@/lib/accounts-api'
import { loginCancel, loginRespond, loginStatus } from '@/lib/accounts-api'
import { reduceLoginRunState } from './account-login-logic'
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
  title: string
  description: string
  start: AccountLoginStart
  /** Called once when the dialog is done, with how the sign-in ended. */
  onClose: (status: LoginRunState['status']) => void
}

const pending = (status: LoginRunState['status']) =>
  status === 'idle' || status === 'running'

const errorText = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause)

/**
 * Runs one provider sign-in: shows the sign-in page link, the device code,
 * and a box for pasted codes, and closes by itself when the sign-in succeeds.
 */
export function AccountLoginDialog({
  title,
  description,
  start,
  onClose,
}: Props) {
  const inputId = useId()
  const formId = useId()
  const [state, setState] = useState(start.state)
  const stateRef = useRef(state)
  const closed = useRef(false)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  stateRef.current = state

  const finish = (status: LoginRunState['status']) => {
    if (closed.current) return
    closed.current = true
    onClose(status)
  }

  const merge = (incoming: LoginRunState) => {
    const next = reduceLoginRunState(stateRef.current, incoming)
    stateRef.current = next
    setState(next)
    return next
  }

  const finishRef = useRef(finish)
  finishRef.current = finish
  useEffect(
    () =>
      loginStatus(start.terminalId, (incoming) => {
        const next = reduceLoginRunState(stateRef.current, incoming)
        stateRef.current = next
        setState(next)
        if (next.status === 'succeeded') finishRef.current('succeeded')
      }),
    [start.terminalId],
  )

  // Leaving the page mid-flow must not strand the provider CLI. The
  // microtask skips StrictMode's immediate remount.
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      queueMicrotask(() => {
        if (!mounted.current && stateRef.current.status === 'running')
          void loginCancel({ terminalId: start.terminalId }).catch(() => {})
      })
    }
  }, [start.terminalId])

  const requestClose = async () => {
    if (!pending(state.status)) return finish(state.status)
    if (cancelling) return
    setCancelling(true)
    setError(null)
    try {
      merge(await loginCancel({ terminalId: start.terminalId }))
      finish('cancelled')
    } catch (cause) {
      setError(`Could not cancel sign-in: ${errorText(cause)}`)
    } finally {
      setCancelling(false)
    }
  }

  const submitInput = async () => {
    const data = input.trim()
    if (!data || sending || state.status !== 'running') return
    setSending(true)
    setError(null)
    try {
      if (
        merge(await loginRespond({ terminalId: start.terminalId, data }))
          .status === 'succeeded'
      )
        finish('succeeded')
      setInput('')
    } catch (cause) {
      setError(`Could not send the code: ${errorText(cause)}`)
    } finally {
      setSending(false)
    }
  }

  const copyCode = async () => {
    if (!state.userCode) return
    try {
      await navigator.clipboard.writeText(state.userCode)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setError('Could not copy the code. Select it and copy it by hand.')
    }
  }

  const failed = state.status === 'failed' || state.status === 'cancelled'
  const failure = failed
    ? (state.message ??
      (state.status === 'failed' ? 'Sign-in failed.' : 'Sign-in cancelled.'))
    : null
  const shownError = error ?? failure

  return (
    <Dialog
      open
      disablePointerDismissal
      onOpenChange={(open) => {
        if (!open) void requestClose()
      }}
    >
      <DialogContent className="max-w-md" showCloseButton={false}>
        <DialogHeader className="gap-1.5">
          <DialogTitle className="text-[15px] font-semibold tracking-tight">
            {title}
          </DialogTitle>
          <DialogDescription className="text-[13px] leading-relaxed">
            {description}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex min-w-0 flex-col gap-4">
          {state.verificationUrl && (
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              render={
                <a
                  href={state.verificationUrl}
                  target="_blank"
                  rel="noreferrer"
                  title={state.verificationUrl}
                />
              }
            >
              <ExternalLink aria-hidden />
              Open sign-in page
            </Button>
          )}
          {state.userCode && (
            <div className="grid gap-1.5">
              <span className="text-xs text-muted-foreground">
                Enter this code on the sign-in page
              </span>
              <div className="flex items-center gap-2 rounded-lg border bg-muted/40 py-1.5 pr-1.5 pl-3">
                <code className="min-w-0 flex-1 font-mono text-sm font-semibold tracking-wide break-all select-all">
                  {state.userCode}
                </code>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() => void copyCode()}
                >
                  {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
            </div>
          )}
          {state.status === 'running' && (
            <form
              id={formId}
              className="grid gap-1.5"
              onSubmit={(event) => {
                event.preventDefault()
                void submitInput()
              }}
            >
              <label
                htmlFor={inputId}
                className="text-xs text-muted-foreground"
              >
                If the provider shows a code or asks for a key, paste it here
              </label>
              <Input
                id={inputId}
                className="font-mono"
                value={input}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setInput(event.target.value)}
                placeholder="Paste the code"
              />
            </form>
          )}
          {pending(state.status) && !shownError && (
            <div
              className="flex items-center gap-2 text-[12.5px] text-muted-foreground"
              role="status"
              aria-live="polite"
            >
              <LoaderCircle
                aria-hidden
                className="size-3.5 shrink-0 motion-safe:animate-spin"
              />
              <span className="min-w-0 truncate">
                {state.message ?? 'Waiting for the browser…'}
              </span>
            </div>
          )}
          {shownError && (
            <p role="alert" className="text-xs break-words text-destructive">
              {shownError}
            </p>
          )}
          {state.output && (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer rounded-sm outline-none select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                Command output
              </summary>
              <pre className="mt-2 max-h-40 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-[11px] whitespace-pre-wrap">
                {state.output}
              </pre>
            </details>
          )}
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button
            type="button"
            variant="ghost"
            onClick={() => void requestClose()}
            disabled={cancelling}
          >
            {cancelling && (
              <LoaderCircle className="motion-safe:animate-spin" />
            )}
            {failed ? 'Close' : cancelling ? 'Cancelling…' : 'Cancel'}
          </Button>
          {state.status === 'running' && (
            <Button
              type="submit"
              form={formId}
              disabled={!input.trim() || sending}
            >
              {sending && <LoaderCircle className="motion-safe:animate-spin" />}
              {sending ? 'Sending…' : 'Submit code'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
