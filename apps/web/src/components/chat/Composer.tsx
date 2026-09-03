import { Paperclip } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { buttonVariants } from '@/components/ui/button'
import {
  Tooltip,
  TooltipPopup,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Spinner } from '@/components/ui/spinner'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ClipboardEvent } from 'react'
import { api } from '../../lib/api'
import { useMessagesStore } from '../../stores/messages'
import { AttachmentChips } from '../composer/AttachmentChips'
import { QueuedPrompts } from '../composer/QueuedPrompts'
import type { QueuedPrompt } from '@forge/protocol/session'
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
import {
  accountsApi,
  type Account,
  type HarnessAccountSnapshot,
} from '../../lib/accounts-api'
import { ContextWindowMeter } from './ContextWindowMeter'
import { useSessionsStore } from '../../stores/sessions'
import {
  buildHarnessOptions,
  defaultSelection,
  type HarnessSelection,
} from './harness-picker-logic'
import { modelResponse, resolveModelTriggerLabel } from './model-picker-logic'
import { ConfigOptionsPicker } from './ConfigOptionsPicker'
import {
  parseConfigOptionsResponse,
  pendingChanges,
  pickableOptions,
  type ConfigOption,
  type ConfigSelections,
} from './config-options-logic'

/** Ghost pill trigger: the composer footer's shared look for its selects. */
const PILL_TRIGGER_CLASS =
  'h-9 w-auto min-w-0 max-w-40 shrink-0 gap-1 border-transparent bg-transparent px-2 text-xs text-muted-foreground/70 shadow-none before:hidden hover:bg-accent/50 hover:text-foreground/80 sm:h-8 sm:max-w-48'

const commandDefaults: ComposerCommand[] = [
  { id: 'btw', label: '/btw', group: 'Built-in', value: '/btw ' },
  { id: 'help', label: '/help', group: 'Built-in', value: '/help' },
  { id: 'clear', label: '/clear', group: 'Built-in', value: '/clear' },
]
const EMPTY_QUEUED_PROMPTS: QueuedPrompt[] = []

function clipboardExtension(type: string) {
  switch (type) {
    case 'image/png':
      return 'png'
    case 'image/jpeg':
      return 'jpg'
    case 'image/gif':
      return 'gif'
    case 'image/webp':
      return 'webp'
    default:
      return 'bin'
  }
}

export function Composer({
  sessionId,
  harness,
  accountId,
  model,
  protocol,
  running = false,
  onInterrupt,
  onSend,
  onQueue,
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
  onQueue?: (
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
  const [configOptions, setConfigOptions] = useState<ConfigOption[]>([])
  const [configSelections, setConfigSelections] = useState<ConfigSelections>({})
  const [interrupting, setInterrupting] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const modelRequestAccount = useRef<string | undefined>(undefined)
  const submitting = useRef(false)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const volatile = useMessagesStore((state) => state.volatile)
  const queued = useMessagesStore(
    (state) => state.queuedBySession[sessionId] ?? EMPTY_QUEUED_PROMPTS,
  )
  const contextWindow = useSessionsStore(
    (state) => state.contextWindow[sessionId],
  )
  useLayoutEffect(() => {
    const node = textarea.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(200, Math.max(70, node.scrollHeight))}px`
  }, [text])
  useEffect(() => {
    const events = volatile.filter(
      (event): event is Extract<typeof event, { type: 'availableCommands' }> =>
        event.type === 'availableCommands' && event.sessionId === sessionId,
    )
    const latest = events.at(-1)
    if (latest)
      setCommands((items) => [
        ...items.filter((item) => item.group !== 'Harness'),
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
            : typeof value === 'object' &&
                value !== null &&
                typeof (value as { name?: unknown }).name === 'string' &&
                (value as { name: string }).name.trim()
              ? [
                  {
                    id: `h-${index}`,
                    label: `/${(value as { name: string }).name}`,
                    group: 'Harness' as const,
                    value: `/${(value as { name: string }).name}`,
                  },
                ]
              : [],
        ),
      ])
  }, [volatile, sessionId])
  useEffect(() => {
    const path = draftMode
      ? draftProjectId
        ? `/api/projects/${encodeURIComponent(draftProjectId)}/skills`
        : null
      : `/api/sessions/${encodeURIComponent(sessionId)}/skills`
    if (!path) return
    void fetch(path)
      .then((response) => (response.ok ? response.json() : null))
      .then(
        (
          value: {
            skills?: Array<{ name: string; description: string }>
          } | null,
        ) =>
          setCommands((items) => [
            ...items,
            ...(value?.skills ?? []).map((skill) => ({
              id: `skill-${skill.name}`,
              label: `$${skill.name}`,
              group: 'Skills' as const,
              value: `$${skill.name} `,
            })),
          ]),
      )
      .catch(() => undefined)
  }, [draftMode, draftProjectId, sessionId])
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
  useEffect(() => {
    if (draftMode || sending) return
    void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/config-options`)
      .then((response) => (response.ok ? response.json() : null))
      .then((value) => {
        const next = parseConfigOptionsResponse(value)
        setConfigOptions(next)
        setConfigSelections((current) => {
          const valid = new Set(next.map((option) => option.id))
          return Object.fromEntries(
            next
              .filter((option) => valid.has(option.id))
              .map((option) => [
                option.id,
                current[option.id] ?? option.currentValue,
              ]),
          )
        })
      })
      .catch(() => {
        setConfigOptions([])
        setConfigSelections({})
      })
  }, [draftMode, sessionId, sending])
  const [harnesses, setHarnesses] = useState<
    Array<{ key: string; name?: string; enabled?: boolean }>
  >(harness ? [{ key: harness }] : [])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [accountSnapshots, setAccountSnapshots] = useState<
    HarnessAccountSnapshot[]
  >([])
  const [accountsLoaded, setAccountsLoaded] = useState(false)
  useEffect(() => {
    const requestedAccountId = selection.accountId
    modelRequestAccount.current = requestedAccountId
    setModels([])
    const liveModels: Promise<ReturnType<typeof modelResponse>> = draftMode
      ? Promise.resolve([] as ReturnType<typeof modelResponse>)
      : fetch(`/api/sessions/${encodeURIComponent(sessionId)}/models`)
          .then((response) => (response.ok ? response.json() : null))
          .then(modelResponse)
          .catch(() => [])
    const accountModels: Promise<ReturnType<typeof modelResponse>> =
      requestedAccountId
        ? accountsApi
            .getModels(requestedAccountId)
            .then((value) => modelResponse(value))
            .catch(() => [])
        : Promise.resolve([])
    void Promise.all([liveModels, accountModels]).then(([live, account]) => {
      if (modelRequestAccount.current !== requestedAccountId) return
      const byId = new Map(account.concat(live).map((item) => [item.id, item]))
      setModels([...byId.values()])
    })
  }, [draftMode, selection.accountId, sessionId])
  useEffect(() => {
    if (model !== undefined) setSelection((current) => ({ ...current, model }))
  }, [model])
  useEffect(() => {
    void accountsApi
      .listHarnesses()
      .then(setHarnesses)
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
  useEffect(() => {
    void accountsApi
      .listHarnessStatus()
      .then(setAccountSnapshots)
      .catch(() => undefined)
  }, [])
  const harnessOptions = buildHarnessOptions(harnesses, accounts, Date.now())
  const showHarnessPicker =
    harnessOptions.length > 0 || (!accountsLoaded && Boolean(selection.harness))
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
    if (draftMode && !draftProjectId) return
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
      sending ||
      submitting.current ||
      !value ||
      (accountsLoaded && !selected.accountId) ||
      !canSendUploads(uploads)
    )
      return
    submitting.current = true
    setSendError(null)
    const attachmentIds = completedAttachmentIds(uploads)
    setText('')
    onTextChange?.('')
    setTrigger(null)
    dispatchUploads(initialAttachmentUploads)
    try {
      const changedOptions = pendingChanges(configOptions, configSelections)
      const dispatch = running && onQueue ? onQueue : onSend
      await dispatch(
        value,
        attachmentIds,
        Object.keys(changedOptions).length > 0
          ? { ...selected, configOptions: changedOptions }
          : selected,
      )
    } catch (error) {
      setText(value)
      onTextChange?.(value)
      setSendError(
        error instanceof Error ? error.message : 'Message failed to send',
      )
    } finally {
      submitting.current = false
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
    for (const file of files) {
      const normalized = file.name
        ? file
        : new File(
            [file],
            `pasted-${Date.now()}.${clipboardExtension(file.type)}`,
            {
              type: file.type,
              lastModified: file.lastModified,
            },
          )
      void upload(normalized)
    }
  }
  const paste = (event: ClipboardEvent) => {
    const files = [...event.clipboardData.files]
    if (files.length) {
      event.preventDefault()
      addFiles(files)
    }
  }
  const canSubmit = !sending && !!text.trim() && canSendUploads(uploads)
  const stopping = protocol === 'pty' && running && onInterrupt
  const accountSnapshot = accountSnapshots.find(
    (snapshot) => snapshot.accountId === selected.accountId,
  )
  const modelTrigger = resolveModelTriggerLabel(selection.model, models)
  return (
    <>
      <AskUserQuestionPanel sessionId={sessionId} />
      <form
        className="composer-root mx-auto w-full min-w-0 max-w-3xl"
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
        <div className="group relative rounded-[22px] p-px transition-colors duration-200">
          {dragging && (
            <div className="pointer-events-none absolute -inset-2 z-5 grid place-items-center rounded-[24px] border-2 border-dashed border-primary bg-primary/10 text-sm font-medium text-primary">
              Drop files to upload
            </div>
          )}
          <div
            className={cn(
              'chat-composer-glass rounded-[20px] border transition-[background-color] duration-200 has-focus-visible:border-foreground/40',
              dragging
                ? 'border-primary/70 bg-accent/45'
                : 'border-black/12 dark:border-transparent dark:inset-ring-1 dark:inset-ring-white/5',
            )}
          >
            {queued.length > 0 && (
              <>
                <QueuedPrompts
                  items={queued}
                  onRemove={(id) => {
                    void api.deleteQueued(sessionId, id).then(() => {
                      useMessagesStore.getState().removeQueued(sessionId, id)
                    })
                  }}
                  onEdit={(item: QueuedPrompt) => {
                    void api.deleteQueued(sessionId, item.id).then(() => {
                      useMessagesStore
                        .getState()
                        .removeQueued(sessionId, item.id)
                      update(item.text)
                      textarea.current?.focus()
                    })
                  }}
                />
                <p className="px-2 pt-1 text-xs text-muted-foreground">
                  Sends when the current turn ends.
                </p>
              </>
            )}
            {uploads.items.length > 0 && (
              <div className="px-3 pt-3 sm:px-4">
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
              </div>
            )}
            <div className="relative px-3 pt-3.5 pb-2 sm:px-4 sm:pt-4">
              {trigger && (
                <div className="absolute inset-x-0 bottom-full z-20 mb-2">
                  <CommandMenu
                    commands={commands}
                    kind={trigger.kind}
                    query={trigger.query}
                    onSelect={select}
                    onDismiss={() => setTrigger(null)}
                  />
                </div>
              )}
              <textarea
                ref={textarea}
                id="message-composer"
                aria-label="Message composer"
                placeholder={
                  harness ? `Message ${harness}…` : 'Send a message…'
                }
                value={text}
                rows={1}
                className="max-h-50 min-h-17.5 w-full resize-none overflow-y-auto border-0 bg-transparent text-[16px] leading-relaxed text-foreground placeholder:text-muted-foreground/50 focus:outline-none sm:text-[14px]"
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
            </div>
            {sendError && (
              <p
                className="px-3 pb-1 text-xs text-destructive sm:px-4"
                role="alert"
              >
                {sendError}
              </p>
            )}
            <div className="flex min-w-0 flex-nowrap items-center justify-between gap-2 px-2.5 pb-2.5 sm:px-3 sm:pb-3">
              <div className="-m-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                <TooltipProvider delay={300}>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <label
                          className={cn(
                            buttonVariants({
                              variant: 'ghost',
                              size: 'icon-sm',
                            }),
                            'shrink-0 cursor-pointer text-muted-foreground/70 hover:text-foreground/80',
                          )}
                        />
                      }
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
                    </TooltipTrigger>
                    <TooltipPopup side="top">Attach files</TooltipPopup>
                  </Tooltip>
                </TooltipProvider>
                {showHarnessPicker && (
                  <Separator
                    orientation="vertical"
                    className="mx-0.5 hidden h-4 sm:block"
                  />
                )}
                {showHarnessPicker ? (
                  <Select
                    value={
                      selection.accountId
                        ? `${selection.harness}:${selection.accountId}`
                        : ''
                    }
                    items={harnessOptions.flatMap((option) =>
                      option.accounts.map((account) => ({
                        value: `${option.harness}:${account.id}`,
                        label: account.label,
                      })),
                    )}
                    onValueChange={(value) => {
                      if (value === null) return
                      const separator = value.indexOf(':')
                      const picked =
                        separator < 0
                          ? { harness: value }
                          : {
                              harness: value.slice(0, separator),
                              accountId: value.slice(separator + 1),
                            }
                      // A model id only carries over within the same harness.
                      const nextSelection =
                        picked.harness === selection.harness
                          ? { ...selection, ...picked }
                          : picked
                      setSelection(nextSelection)
                      onSelectionChange?.(nextSelection)
                    }}
                  >
                    <SelectTrigger
                      size="sm"
                      aria-label="Harness"
                      className={PILL_TRIGGER_CLASS}
                    >
                      <SelectValue placeholder="Harness" />
                    </SelectTrigger>
                    <SelectContent>
                      {harnessOptions.map((option) => (
                        <SelectGroup key={option.harness}>
                          <SelectLabel>{option.label}</SelectLabel>
                          {option.accounts.map((account) => (
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
                          ))}
                        </SelectGroup>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <a
                    href="/settings/harnesses"
                    className={cn(
                      buttonVariants({ variant: 'ghost', size: 'sm' }),
                      'px-2 text-xs',
                    )}
                  >
                    Add an account
                  </a>
                )}
                <Separator
                  orientation="vertical"
                  className="mx-0.5 hidden h-4 sm:block"
                />
                {
                  <TooltipProvider delay={300}>
                    <Tooltip>
                      <TooltipTrigger render={<span />}>
                        <Select
                          value={selection.model ?? ''}
                          items={models.map((model) => ({
                            value: model.id,
                            label: model.label,
                          }))}
                          onValueChange={(value) => {
                            if (value === null) return
                            const nextSelection = { ...selection, model: value }
                            setSelection(nextSelection)
                            onSelectionChange?.(nextSelection)
                          }}
                          disabled={models.length === 0}
                        >
                          <SelectTrigger
                            size="sm"
                            aria-label="Model"
                            className={PILL_TRIGGER_CLASS}
                          >
                            <span className="flex-1 truncate text-left data-placeholder:text-muted-foreground">
                              {modelTrigger?.label ?? 'Model'}
                            </span>
                          </SelectTrigger>
                          <SelectContent>
                            {models.map((model) => (
                              <SelectItem key={model.id} value={model.id}>
                                {model.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TooltipTrigger>
                      {models.length === 0 && (
                        <TooltipPopup side="top">
                          This session does not expose model choices
                        </TooltipPopup>
                      )}
                    </Tooltip>
                  </TooltipProvider>
                }
                {!draftMode && pickableOptions(configOptions).length > 0 && (
                  <ConfigOptionsPicker
                    options={pickableOptions(configOptions)}
                    selections={configSelections}
                    disabled={running || sending}
                    onChange={(id, value) => {
                      const nextSelections = {
                        ...configSelections,
                        [id]: value,
                      }
                      setConfigSelections(nextSelections)
                      onSelectionChange?.({
                        ...selected,
                        configOptions: pendingChanges(
                          configOptions,
                          nextSelections,
                        ),
                      })
                    }}
                  />
                )}
              </div>
              <div className="flex shrink-0 flex-nowrap items-center justify-end gap-2">
                {contextWindow && (
                  <ContextWindowMeter
                    usage={contextWindow}
                    account={accountSnapshot}
                  />
                )}
                {stopping && (
                  <button
                    type="button"
                    className="flex h-9 w-9 items-center justify-center rounded-full bg-destructive/90 text-white shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:hover:scale-105 enabled:hover:bg-destructive disabled:opacity-40 sm:h-8 sm:w-8"
                    disabled={interrupting}
                    aria-label="End turn"
                    title="End the current PTY turn without closing the process"
                    onClick={() => void endTurn()}
                  >
                    {interrupting ? (
                      <Spinner className="size-3.5" />
                    ) : (
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 12 12"
                        fill="currentColor"
                        aria-hidden="true"
                      >
                        <rect x="2" y="2" width="8" height="8" rx="1.5" />
                      </svg>
                    )}
                  </button>
                )}
                <button
                  type="submit"
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/90 text-primary-foreground shadow-xs transition-all duration-150 enabled:cursor-pointer hover:scale-105 hover:bg-primary disabled:pointer-events-none disabled:opacity-30 disabled:shadow-none sm:h-8 sm:w-8"
                  disabled={
                    !canSubmit || (accountsLoaded && !selected.accountId)
                  }
                  title={
                    !canSendUploads(uploads)
                      ? 'Wait for uploads to finish or remove failed files'
                      : undefined
                  }
                  aria-label={running ? 'Queue message' : 'Send'}
                >
                  {sending ? (
                    <Spinner className="size-3.5" />
                  ) : (
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 14 14"
                      fill="none"
                      aria-hidden="true"
                    >
                      <path
                        d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      </form>
    </>
  )
}
