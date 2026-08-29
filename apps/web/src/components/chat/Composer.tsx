import { ArrowUp, Paperclip } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button, buttonVariants } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Spinner } from '@/components/ui/spinner'
import { Kbd } from '@/components/ui/kbd'
import { cn } from '@/lib/utils'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ClipboardEvent } from 'react'
import { api } from '../../lib/api'
import { useMessagesStore } from '../../stores/messages'
import { AttachmentChips } from '../composer/AttachmentChips'
import {
  attachmentUploadsReducer,
  canSendUploads,
  completedAttachmentIds,
  initialAttachmentUploads,
} from '../composer/attachmentUploads'
import { CommandMenu, type ComposerCommand } from './CommandMenu'
import {
  detectComposerTrigger,
  replaceComposerTrigger,
  type ComposerTrigger,
} from './composer-triggers'
import { AskUserQuestionPanel } from './AskUserQuestionPanel'
import { accountsApi, type Account } from '../../lib/accounts-api'
import {
  buildHarnessOptions,
  defaultSelection,
  type HarnessSelection,
} from './harness-picker-logic'
import { modelResponse } from './model-picker-logic'

const commandDefaults: ComposerCommand[] = [
  { id: 'btw', label: '/btw', group: 'Built-in', value: '/btw ' },
  { id: 'help', label: '/help', group: 'Built-in', value: '/help' },
  { id: 'clear', label: '/clear', group: 'Built-in', value: '/clear' },
]

export function Composer({
  sessionId,
  harness,
  accountId,
  model,
  protocol,
  running = false,
  onInterrupt,
  onSend,
  sending = false,
  draftMode = false,
  draftProjectId,
  initialText = '',
  onTextChange,
  onSelectionChange,
}: {
  sessionId: string
  harness?: string
  accountId?: string
  model?: string
  protocol?: 'acp' | 'pty'
  running?: boolean
  onInterrupt?: () => Promise<void>
  onSend: (
    text: string,
    attachmentIds: string[],
    selection: HarnessSelection,
  ) => Promise<void>
  sending?: boolean
  draftMode?: boolean
  draftProjectId?: string
  initialText?: string
  onTextChange?: (text: string) => void
  onSelectionChange?: (selection: HarnessSelection) => void
}) {
  const [text, setText] = useState(initialText)
  const [trigger, setTrigger] = useState<ComposerTrigger | null>(null)
  const [uploads, dispatchUploads] = useState(initialAttachmentUploads)
  const [dragging, setDragging] = useState(false)
  const [commands, setCommands] = useState(commandDefaults)
  const [selection, setSelection] = useState<HarnessSelection>({
    harness: harness ?? '',
    accountId,
    model,
  })
  const [models, setModels] = useState<ReturnType<typeof modelResponse>>([])
  const [interrupting, setInterrupting] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const volatile = useMessagesStore((state) => state.volatile)
  useLayoutEffect(() => {
    const node = textarea.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(140, Math.max(44, node.scrollHeight))}px`
  }, [text])
  useEffect(() => {
    const events = volatile.filter(
      (event): event is Extract<typeof event, { type: 'availableCommands' }> =>
        event.type === 'availableCommands' && event.sessionId === sessionId,
    )
    const latest = events.at(-1)
    if (latest)
      setCommands([
        ...commandDefaults,
        ...latest.commands.flatMap((value, index) =>
          typeof value === 'string'
            ? [
                {
                  id: `h-${index}`,
                  label: value,
                  group: 'Harness' as const,
                  value,
                },
              ]
            : [],
        ),
      ])
  }, [volatile, sessionId])
  useEffect(() => {
    if (draftMode) return
    void fetch(`/api/sessions/${encodeURIComponent(sessionId)}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((session: { projectId?: string } | null) => {
        if (!session?.projectId) return
        return fetch(
          `/api/projects/${encodeURIComponent(session.projectId)}/files`,
        )
          .then((response) => (response.ok ? response.json() : []))
          .then((files: Array<{ name: string; type: string }>) =>
            setCommands((items) => [
              ...items,
              ...files
                .filter((file) => file.type === 'file')
                .map((file) => ({
                  id: `file-${file.name}`,
                  label: `@${file.name}`,
                  group: 'Files' as const,
                  value: file.name,
                })),
            ]),
          )
      })
      .catch(() => undefined)
  }, [draftMode, sessionId])
  const [harnesses, setHarnesses] = useState<string[]>(harness ? [harness] : [])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [accountsLoaded, setAccountsLoaded] = useState(false)
  useEffect(() => {
    if (draftMode) return
    void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/models`)
      .then((response) => (response.ok ? response.json() : null))
      .then((value) => setModels(modelResponse(value)))
      .catch(() => setModels([]))
  }, [draftMode, sessionId])
  useEffect(() => {
    if (model !== undefined) setSelection((current) => ({ ...current, model }))
  }, [model])
  useEffect(() => {
    void fetch('/api/status')
      .then((response) => (response.ok ? response.json() : null))
      .then((status: { harnesses?: Array<{ key: string }> } | null) => {
        if (status?.harnesses)
          setHarnesses(status.harnesses.map((item) => item.key))
      })
      .catch(() => undefined)
  }, [])
  useEffect(() => {
    void accountsApi
      .listAccounts()
      .then((next) => {
        setAccounts(next)
        setAccountsLoaded(true)
      })
      .catch(() => undefined)
  }, [])
  const harnessOptions = buildHarnessOptions(harnesses, accounts, Date.now())
  const selected = accountsLoaded
    ? defaultSelection(harnessOptions, selection)
    : selection
  useEffect(() => {
    if (
      selected.harness !== selection.harness ||
      selected.accountId !== selection.accountId
    )
      setSelection(selected)
  }, [selected, selection])
  const update = (
    value: string,
    cursor = textarea.current?.selectionStart ?? value.length,
  ) => {
    setText(value)
    onTextChange?.(value)
    setTrigger(detectComposerTrigger(value, cursor))
  }
  const select = (command: ComposerCommand) => {
    if (!trigger) return
    const result = replaceComposerTrigger(
      text,
      trigger,
      command.value ?? command.label,
    )
    update(result.text, result.cursor)
    requestAnimationFrame(() => {
      textarea.current?.focus()
      textarea.current?.setSelectionRange(result.cursor, result.cursor)
    })
  }
  const upload = async (file: File, retryId?: string) => {
    if (draftMode) return
    const temp = `local-${crypto.randomUUID()}`
    const id = retryId ?? temp
    if (retryId)
      dispatchUploads((state) =>
        attachmentUploadsReducer(state, { type: 'retry', id: retryId }),
      )
    else
      dispatchUploads((state) =>
        attachmentUploadsReducer(state, {
          type: 'add',
          attachment: {
            id,
            file,
            name: file.name,
            size: file.size,
            mime: file.type || 'application/octet-stream',
            progress: 0,
            state: 'uploading',
          },
        }),
      )
    try {
      const result = await api.upload(
        sessionId,
        file,
        (progress) =>
          dispatchUploads((state) =>
            attachmentUploadsReducer(state, { type: 'progress', id, progress }),
          ),
        draftProjectId,
      )
      dispatchUploads((state) =>
        attachmentUploadsReducer(state, {
          type: 'complete',
          id,
          attachmentId: result.attachmentId,
        }),
      )
    } catch (error) {
      dispatchUploads((state) =>
        attachmentUploadsReducer(state, {
          type: 'fail',
          id,
          error: error instanceof Error ? error.message : 'Upload failed',
        }),
      )
    }
  }
  useEffect(() => {
    const hasFiles = (event: DragEvent) =>
      [...(event.dataTransfer?.types ?? [])].includes('Files')
    const over = (event: DragEvent) => {
      if (
        hasFiles(event) &&
        !(event.target as Element | null)?.closest('.composer-root')
      ) {
        event.preventDefault()
        setDragging(true)
      }
    }
    const leave = () => setDragging(false)
    const drop = (event: DragEvent) => {
      if (
        !hasFiles(event) ||
        (event.target as Element | null)?.closest('.composer-root')
      )
        return
      event.preventDefault()
      setDragging(false)
      if (event.dataTransfer?.files) addFiles(event.dataTransfer.files)
    }
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [])
  const submit = async () => {
    const value = text.trim()
    if (
      !value ||
      (accountsLoaded && !selected.accountId) ||
      !canSendUploads(uploads)
    )
      return
    setSendError(null)
    const attachmentIds = completedAttachmentIds(uploads)
    setText('')
    onTextChange?.('')
    setTrigger(null)
    dispatchUploads(initialAttachmentUploads)
    try {
      await onSend(value, attachmentIds, selected)
    } catch (error) {
      setText(value)
      onTextChange?.(value)
      setSendError(
        error instanceof Error ? error.message : 'Message failed to send',
      )
    }
  }
  const endTurn = async () => {
    if (!onInterrupt || interrupting) return
    setInterrupting(true)
    try {
      await onInterrupt()
    } finally {
      setInterrupting(false)
    }
  }
  const addFiles = (files: FileList | File[]) => {
    for (const file of files) void upload(file)
  }
  const paste = (event: ClipboardEvent) => {
    const files = [...event.clipboardData.files]
    if (files.length) addFiles(files)
  }
  const canSubmit = !sending && !!text.trim() && canSendUploads(uploads)
  return (
    <div className="flex-none px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6">
      <AskUserQuestionPanel sessionId={sessionId} />
      <form
        className={cn(
          'composer-root relative mx-auto flex w-full max-w-3xl flex-col rounded-xl border border-border bg-card p-2 shadow-sm transition-colors',
          'focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/50',
          dragging && 'border-primary ring-2 ring-primary/50',
        )}
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
        onDragEnter={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          if (event.currentTarget === event.target) setDragging(false)
        }}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          addFiles(event.dataTransfer.files)
        }}
      >
        {dragging && (
          <div className="pointer-events-none absolute -inset-3 z-5 grid place-items-center rounded-xl border-2 border-dashed border-primary bg-primary/10 text-sm font-medium text-primary">
            Drop files to upload
          </div>
        )}
        {uploads.items.length > 0 && (
          <AttachmentChips
            items={uploads.items}
            onRetry={(id) => {
              const item = uploads.items.find((value) => value.id === id)
              if (item) void upload(item.file, id)
            }}
            onRemove={(id) =>
              dispatchUploads((state) =>
                attachmentUploadsReducer(state, { type: 'remove', id }),
              )
            }
          />
        )}
        {trigger && (
          <CommandMenu
            commands={commands}
            kind={trigger.kind}
            query={trigger.query}
            onSelect={select}
            onDismiss={() => setTrigger(null)}
          />
        )}
        <textarea
          ref={textarea}
          id="message-composer"
          aria-label="Message composer"
          placeholder={harness ? `Message ${harness}…` : 'Send a message…'}
          value={text}
          rows={1}
          className="w-full resize-none overflow-y-auto border-0 bg-transparent px-2 py-2 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground focus:outline-none"
          onPaste={paste}
          onChange={(event) => update(event.target.value)}
          onKeyDown={(event) => {
            if (trigger && event.key === 'Escape') {
              event.preventDefault()
              setTrigger(null)
              return
            }
            if (
              trigger &&
              (event.key === 'ArrowDown' || event.key === 'ArrowUp')
            ) {
              event.preventDefault()
              const item = document.querySelector<HTMLElement>(
                '[data-composer-menu] [cmdk-item]',
              )
              item?.focus()
              return
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              if (event.nativeEvent.isComposing) return
              if (trigger) {
                event.preventDefault()
                const item = document.querySelector<HTMLElement>(
                  '[data-composer-menu] [cmdk-item]',
                )
                item?.click()
                return
              }
              event.preventDefault()
              void submit()
            }
          }}
        />
        {sendError && (
          <p className="px-2 pb-1 text-xs text-destructive" role="alert">
            {sendError}
          </p>
        )}
        <div className="flex items-center gap-1 px-1 pb-1">
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <label
                  className={cn(
                    buttonVariants({ variant: 'ghost', size: 'icon' }),
                    'size-8 shrink-0 cursor-pointer pointer-coarse:size-11',
                  )}
                >
                  <Paperclip className="size-4" />
                  <input
                    aria-label="Attach files"
                    type="file"
                    multiple
                    className="sr-only"
                    onChange={(event) => {
                      addFiles(event.target.files ?? [])
                      event.target.value = ''
                    }}
                  />
                </label>
              </TooltipTrigger>
              <TooltipContent side="top">Attach files</TooltipContent>
            </Tooltip>
          </TooltipProvider>
          {harnesses.length > 0 && (
            <Select
              value={
                selection.accountId
                  ? `${selection.harness}:${selection.accountId}`
                  : ''
              }
              onValueChange={(value) => {
                const separator = value.indexOf(':')
                const nextSelection =
                  separator < 0
                    ? { harness: value }
                    : {
                        harness: value.slice(0, separator),
                        accountId: value.slice(separator + 1),
                      }
                setSelection(nextSelection)
                onSelectionChange?.(nextSelection)
              }}
            >
              <SelectTrigger
                size="sm"
                aria-label="Harness"
                className="h-8 max-w-[9rem] gap-1 border-transparent bg-transparent px-2 text-xs text-muted-foreground shadow-none hover:bg-accent hover:text-accent-foreground pointer-coarse:h-11 pointer-coarse:max-w-none"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {harnessOptions.map((option) => (
                  <SelectGroup key={option.harness}>
                    <SelectLabel>{option.label}</SelectLabel>
                    {option.accounts.length === 0 ? (
                      <SelectItem value={`${option.harness}:none`} disabled>
                        {option.label} - {option.disabledReason}
                      </SelectItem>
                    ) : (
                      option.accounts.map((account) => (
                        <SelectItem
                          key={`${option.harness}:${account.id}`}
                          value={`${option.harness}:${account.id}`}
                          disabled={account.disabled}
                        >
                          {account.label}
                          {account.cooling && account.coolingLabel
                            ? ` Cooling - ${account.coolingLabel}`
                            : ''}
                        </SelectItem>
                      ))
                    )}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          )}
          {!draftMode && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Select
                      value={selection.model ?? ''}
                      onValueChange={(value) => {
                        const nextSelection = { ...selection, model: value }
                        setSelection(nextSelection)
                        onSelectionChange?.(nextSelection)
                      }}
                      disabled={models.length === 0}
                    >
                      <SelectTrigger
                        size="sm"
                        aria-label="Model"
                        className="h-8 max-w-[11rem] gap-1 border-transparent bg-transparent px-2 text-xs text-muted-foreground shadow-none hover:bg-accent hover:text-accent-foreground pointer-coarse:h-11 pointer-coarse:max-w-none"
                      >
                        <SelectValue placeholder="Model" />
                      </SelectTrigger>
                      <SelectContent>
                        {models.map((model) => (
                          <SelectItem key={model.id} value={model.id}>
                            {model.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </span>
                </TooltipTrigger>
                {models.length === 0 && (
                  <TooltipContent side="top">
                    This session does not expose model choices
                  </TooltipContent>
                )}
              </Tooltip>
            </TooltipProvider>
          )}
          <span className="flex-1" />
          <span className="hidden items-center gap-1 pr-1 text-[11px] text-muted-foreground pointer-fine:flex">
            <Kbd>Enter</Kbd> to send
          </span>
          {protocol === 'pty' && running && onInterrupt && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 pointer-coarse:h-11"
              disabled={interrupting}
              aria-label="End turn"
              title="End the current PTY turn without closing the process"
              onClick={() => void endTurn()}
            >
              {interrupting && <Spinner className="size-3.5" />}
              {interrupting ? 'Ending…' : 'End turn'}
            </Button>
          )}
          <Button
            type="submit"
            size="icon"
            className="size-8 shrink-0 rounded-lg pointer-coarse:size-11"
            disabled={!canSubmit || (accountsLoaded && !selected.accountId)}
            title={
              !canSendUploads(uploads)
                ? 'Wait for uploads to finish or remove failed files'
                : undefined
            }
            aria-label="Send"
          >
            {sending ? (
              <Spinner className="size-4" />
            ) : (
              <ArrowUp className="size-4" />
            )}
          </Button>
        </div>
      </form>
    </div>
  )
}
