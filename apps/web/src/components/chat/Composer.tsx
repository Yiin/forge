import { Copy, Paperclip, TriangleAlert } from 'lucide-react'
import {
  Tooltip,
  TooltipPopup,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  ClipboardEvent,
  DragEvent as ReactDragEvent,
  ReactNode,
  RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { api } from '../../lib/api'
import { useMessagesStore } from '../../stores/messages'
import { AttachmentChips } from '../composer/AttachmentChips'
import { QueuedPrompts } from '../composer/QueuedPrompts'
import { ModelChip } from '../composer/ModelChip'
import { PILL_ICON_BUTTON_CLASS } from '../composer/zeron-styles'
import { EDGE_FADE_CLASS } from '../composer/useEdgeFade'
import type { QueuedPrompt } from '@forge/protocol/session'
import {
  attachmentUploadsReducer,
  canSendUploads,
  completedAttachmentIds,
  initialAttachmentUploads,
} from '../composer/attachmentUploads'
import {
  CommandMenu,
  type CommandMenuHandle,
  type ComposerCommand,
} from './CommandMenu'
import {
  detectComposerTrigger,
  replaceComposerTrigger,
  type ComposerTrigger,
} from './composer-triggers'
import { useComposerLayout } from './useComposerLayout'
import { AskUserQuestionPanel } from './AskUserQuestionPanel'
import {
  accountsApi,
  type Account,
  type HarnessAccountSnapshot,
  type HarnessPickerEntry,
} from '../../lib/accounts-api'
import { ContextWindowMeter } from './ContextWindowMeter'
import { useSessionsStore } from '../../stores/sessions'
import {
  buildHarnessOptions,
  defaultSelection,
  type HarnessSelection,
} from './harness-picker-logic'
import { modelResponse } from './model-picker-logic'
import {
  parseConfigOptionsResponse,
  pendingChanges,
  pickableOptions,
  type ConfigOption,
  type ConfigSelections,
} from './config-options-logic'

const commandDefaults: ComposerCommand[] = [
  {
    id: 'btw',
    label: '/btw',
    group: 'Built-in',
    value: '/btw ',
    detail: 'Ask a side question in a new chat',
  },
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

const hasFiles = (transfer: DataTransfer | null) =>
  [...(transfer?.types ?? [])].includes('Files')

/** The interactive controls a pill mouse-down must not steal focus from. */
const INTERACTIVE = 'button, a, input, textarea, label, [role="option"]'

/**
 * Floats its children above the pill at the pill's width. It renders in a
 * portal because the session's composer overlay scrolls, which would clip
 * anything that sticks out above it.
 */
function AbovePill({
  pill,
  children,
}: {
  pill: RefObject<HTMLDivElement | null>
  children: ReactNode
}) {
  const [rect, setRect] = useState<DOMRect | null>(null)
  useLayoutEffect(() => {
    const node = pill.current
    if (!node) return
    const update = () => setRect(node.getBoundingClientRect())
    update()
    const observer =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(update)
    observer?.observe(node)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [pill])
  if (!rect) return null
  return createPortal(
    <div
      className="fixed z-50 flex flex-col justify-end pb-1.5"
      style={{
        left: rect.left,
        width: rect.width,
        bottom: window.innerHeight - rect.top,
        maxHeight: Math.max(120, rect.top - 8),
      }}
    >
      {children}
    </div>,
    document.body,
  )
}

export function Composer({
  sessionId,
  harness,
  accountId,
  model,
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
  footer,
  destination,
  connectionNotice,
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
  /** Left side of the row under the pill: checkout and branch. */
  footer?: ReactNode
  /** New-thread only: the chips that float above the pill, right-aligned. */
  destination?: ReactNode
  /** A quiet line above the pill while the connection is down. */
  connectionNotice?: { text: string; offline: boolean }
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
  const [modelsLoading, setModelsLoading] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [configOptions, setConfigOptions] = useState<ConfigOption[]>([])
  const [configSelections, setConfigSelections] = useState<ConfigSelections>({})
  const [interrupting, setInterrupting] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const modelRequestAccount = useRef<string | undefined>(undefined)
  const submitting = useRef(false)
  const form = useRef<HTMLFormElement>(null)
  const menu = useRef<CommandMenuHandle>(null)
  const [pane, setPane] = useState<Element | null>(null)
  const volatile = useMessagesStore((state) => state.volatile)
  const queued = useMessagesStore(
    (state) => state.queuedBySession[sessionId] ?? EMPTY_QUEUED_PROMPTS,
  )
  const contextWindow = useSessionsStore(
    (state) => state.contextWindow[sessionId],
  )
  useEffect(() => {
    setPane(form.current?.closest('[data-chat-pane]') ?? null)
  }, [])
  useEffect(() => {
    const events = volatile.filter(
      (event): event is Extract<typeof event, { type: 'availableCommands' }> =>
        event.type === 'availableCommands' && event.sessionId === sessionId,
    )
    const latest = events.at(-1)
    if (latest)
      setCommands((items) => [
        ...items.filter((item) => item.group !== 'Harness'),
        ...latest.commands.flatMap((value, index) => {
          if (typeof value === 'string')
            return [
              {
                id: `h-${index}`,
                label: value,
                group: 'Harness' as const,
                value,
              },
            ]
          if (typeof value !== 'object' || value === null) return []
          const entry = value as { name?: unknown; description?: unknown }
          if (typeof entry.name !== 'string' || !entry.name.trim()) return []
          return [
            {
              id: `h-${index}`,
              label: `/${entry.name}`,
              group: 'Harness' as const,
              value: `/${entry.name}`,
              ...(typeof entry.description === 'string' && entry.description
                ? { detail: entry.description }
                : {}),
            },
          ]
        }),
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
              ...(skill.description ? { detail: skill.description } : {}),
            })),
          ]),
      )
      .catch(() => undefined)
  }, [draftMode, draftProjectId, sessionId])
  useEffect(() => {
    const project = draftMode
      ? Promise.resolve(draftProjectId)
      : fetch(`/api/sessions/${encodeURIComponent(sessionId)}`)
          .then((response) => (response.ok ? response.json() : null))
          .then((session: { projectId?: string } | null) => session?.projectId)
    void project
      .then((projectId) => {
        if (!projectId) return
        return fetch(`/api/projects/${encodeURIComponent(projectId)}/files`)
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
  }, [draftMode, draftProjectId, sessionId])
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
  const [harnesses, setHarnesses] = useState<HarnessPickerEntry[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [accountSnapshots, setAccountSnapshots] = useState<
    HarnessAccountSnapshot[]
  >([])
  const [accountsLoaded, setAccountsLoaded] = useState(false)
  const [harnessesLoaded, setHarnessesLoaded] = useState(false)
  useEffect(() => {
    const requestedAccountId = selection.accountId
    modelRequestAccount.current = requestedAccountId
    setModels([])
    setModelsLoading(true)
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
      setModelsLoading(false)
    })
  }, [draftMode, selection.accountId, sessionId])
  useEffect(() => {
    if (model !== undefined) setSelection((current) => ({ ...current, model }))
  }, [model])
  useEffect(() => {
    void accountsApi
      .listHarnesses()
      .then((next) => {
        setHarnesses(next)
        setHarnessesLoaded(true)
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
  useEffect(() => {
    void accountsApi
      .listHarnessStatus()
      .then(setAccountSnapshots)
      .catch(() => undefined)
  }, [])
  // Mod+/ opens the model picker, as in zeron.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === '/') {
        event.preventDefault()
        setPickerOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
  const harnessEntries =
    harnesses.length > 0 ? harnesses : harness ? [{ key: harness }] : []
  const harnessOptions = buildHarnessOptions(
    harnessEntries,
    accounts,
    Date.now(),
  )
  const catalogLoaded = accountsLoaded && harnessesLoaded
  const selected = catalogLoaded
    ? defaultSelection(harnessOptions, selection)
    : selection
  useEffect(() => {
    if (
      selected.harness !== selection.harness ||
      selected.accountId !== selection.accountId
    )
      setSelection(selected)
  }, [selected, selection])
  const canSelectWithoutAccount = harnessOptions.some(
    (option) => option.harness === selected.harness && option.accountOptional,
  )
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
    setTrigger(null)
    requestAnimationFrame(() => {
      textarea.current?.focus()
      textarea.current?.setSelectionRange(result.cursor, result.cursor)
    })
  }
  const upload = async (file: File, retryId?: string) => {
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
        draftMode
          ? { draftId: sessionId, projectId: draftProjectId }
          : undefined,
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
  // The drop zone is the whole chat pane, not just the pill.
  useEffect(() => {
    const over = (event: DragEvent) => {
      if (
        hasFiles(event.dataTransfer) &&
        !(event.target as Element | null)?.closest('.composer-root')
      ) {
        event.preventDefault()
        setDragging(true)
      }
    }
    const leave = (event: DragEvent) => {
      if (!event.relatedTarget) setDragging(false)
    }
    const drop = (event: DragEvent) => {
      if (
        !hasFiles(event.dataTransfer) ||
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
    const hasAttachments = uploads.items.some(
      (item) => item.state === 'complete',
    )
    if (
      sending ||
      submitting.current ||
      (!value && !hasAttachments) ||
      (accountsLoaded && !selected.accountId && !canSelectWithoutAccount) ||
      !canSendUploads(uploads)
    )
      return
    submitting.current = true
    setSendError(null)
    const attachmentIds = completedAttachmentIds(uploads)
    const previousUploads = uploads
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
      dispatchUploads(previousUploads)
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
  const sendQueuedNow = (id: string) => {
    void api
      .sendQueuedNow(sessionId, id)
      .then(() => {
        useMessagesStore.getState().removeQueued(sessionId, id)
      })
      // The server republishes the queue, so a refused send needs no local
      // rollback.
      .catch(() => undefined)
  }
  const paste = (event: ClipboardEvent) => {
    const files = [...event.clipboardData.files]
    if (files.length) {
      event.preventDefault()
      addFiles(files)
    }
  }
  const hasContent = Boolean(text.trim()) || uploads.items.length > 0
  const noAgents = catalogLoaded && harnessOptions.length === 0
  const blocked =
    sending ||
    noAgents ||
    !canSendUploads(uploads) ||
    Boolean(accountsLoaded && !selected.accountId && !canSelectWithoutAccount)
  const stopping = Boolean(running && onInterrupt && !hasContent)
  const accountSnapshot = accountSnapshots.find(
    (snapshot) => snapshot.accountId === selected.accountId,
  )
  const { pill, chip, textarea, mirror, expanded } = useComposerLayout(
    text,
    draftMode,
  )
  const pickable = draftMode ? [] : pickableOptions(configOptions)
  const onFormDrag = (event: ReactDragEvent) => {
    if (!hasFiles(event.dataTransfer)) return
    event.preventDefault()
    setDragging(true)
  }

  const attach = (
    <TooltipProvider delay={300}>
      <Tooltip>
        <TooltipTrigger
          render={
            <label
              className={cn(
                PILL_ICON_BUTTON_CLASS,
                '[grid-area:attach] self-center has-focus-visible:bg-ink/10',
                expanded ? 'mb-[10px] ml-3 self-end' : 'ml-2',
              )}
            />
          }
        >
          <Paperclip aria-hidden className="size-[18px]" />
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
  )

  return (
    <>
      <AskUserQuestionPanel sessionId={sessionId} />
      <form
        ref={form}
        data-composer-mode={expanded ? 'expanded' : 'compact'}
        className="composer-root mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
        onDragEnter={onFormDrag}
        onDragOver={(event) => {
          if (hasFiles(event.dataTransfer)) event.preventDefault()
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node))
            setDragging(false)
        }}
        onDrop={(event) => {
          if (!hasFiles(event.dataTransfer)) return
          event.preventDefault()
          setDragging(false)
          addFiles(event.dataTransfer.files)
        }}
      >
        {sendError && (
          <div
            role="alert"
            onClick={() => setSendError(null)}
            className="mx-1 mt-1.5 flex cursor-pointer flex-col gap-1 rounded-[12px] border border-destructive/16 bg-destructive/5 px-3 py-2 text-[12px] leading-4 text-destructive-foreground/90 duration-500 animate-in fade-in-0 slide-in-from-bottom-1 motion-reduce:animate-none"
          >
            <span className="flex items-center gap-1.5">
              <TriangleAlert
                aria-hidden
                className="size-3.5 text-destructive"
              />
              <span className="font-semibold">Error</span>
              <span className="flex-1" />
              <button
                type="button"
                aria-label="Copy error"
                onClick={(event) => {
                  event.stopPropagation()
                  void navigator.clipboard?.writeText(sendError)
                }}
                className="grid size-5 cursor-pointer place-items-center rounded-[6px] hover:bg-destructive/12"
              >
                <Copy aria-hidden className="size-3" />
              </button>
            </span>
            <span className="break-words">{sendError}</span>
          </div>
        )}
        {connectionNotice && (
          <p
            role="status"
            className="mx-2 mt-1.5 flex min-w-0 items-center gap-1.5 text-[11px] leading-[14px] text-faint-foreground duration-500 ease-[cubic-bezier(.16,1,.3,1)] animate-in fade-in-0 slide-in-from-bottom-1 motion-reduce:slide-in-from-bottom-0"
          >
            <span
              aria-hidden
              className={cn(
                'size-[5px] shrink-0 rounded-full',
                connectionNotice.offline ? 'bg-warning' : 'bg-faint-foreground',
              )}
            />
            <span className="min-w-0 truncate">{connectionNotice.text}</span>
          </p>
        )}
        {queued.length > 0 && (
          <QueuedPrompts
            items={queued}
            onRemove={(id) => {
              void api.deleteQueued(sessionId, id).then(() => {
                useMessagesStore.getState().removeQueued(sessionId, id)
              })
            }}
            onEdit={(item: QueuedPrompt) => {
              void api.deleteQueued(sessionId, item.id).then(() => {
                useMessagesStore.getState().removeQueued(sessionId, item.id)
                update(item.text)
                textarea.current?.focus()
              })
            }}
            onMove={(id, target) => {
              const index = queued.findIndex((item) => item.id === id)
              if (index < 0 || target < 0 || target >= queued.length) return
              const next = [...queued]
              const [moved] = next.splice(index, 1)
              next.splice(target, 0, moved!)
              useMessagesStore.getState().setQueued(sessionId, next)
              void api
                .reorderQueued(
                  sessionId,
                  next.map((item) => item.id),
                )
                .catch(() => {
                  useMessagesStore.getState().setQueued(sessionId, queued)
                })
            }}
            onSendNow={sendQueuedNow}
          />
        )}
        <div className="relative z-10">
          {destination && (
            <div className="absolute inset-x-[26px] -top-7 flex h-5 items-center justify-end gap-1">
              {destination}
            </div>
          )}
          {trigger && (
            <AbovePill pill={pill}>
              <CommandMenu
                ref={menu}
                commands={commands}
                kind={trigger.kind}
                query={trigger.query}
                onSelect={select}
              />
            </AbovePill>
          )}
          <div
            ref={pill}
            onMouseDown={(event) => {
              if (pickerOpen || (event.target as Element).closest(INTERACTIVE))
                return
              event.preventDefault()
              textarea.current?.focus()
            }}
            className={cn(
              'chat-composer-glass @container relative grid overflow-hidden border',
              draftMode ? 'rounded-[26px]' : 'rounded-[22px]',
              expanded
                ? "grid-cols-[auto_minmax(0,1fr)_auto] grid-rows-[auto_auto_42px] [grid-template-areas:'strip_strip_strip'_'input_input_input'_'attach_chip_send'] pointer-coarse:grid-rows-[auto_auto_52px]"
                : "grid-cols-[auto_minmax(0,1fr)_auto_auto] [grid-template-areas:'strip_strip_strip_strip'_'attach_input_chip_send']",
            )}
          >
            {uploads.items.length > 0 && (
              <div className="[grid-area:strip] px-4 pt-3">
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
            {attach}
            <textarea
              ref={textarea}
              id="message-composer"
              aria-label="Message composer"
              placeholder="Do anything…"
              value={text}
              rows={1}
              className={cn(
                'block w-full resize-none overflow-y-auto border-0 bg-transparent text-[16px] leading-[22.75px] text-foreground caret-primary outline-none [grid-area:input] placeholder:text-faint-foreground sm:text-[14px]',
                'transition-[height] duration-180 ease-[cubic-bezier(0,0,0.58,1)] motion-reduce:transition-none',
                EDGE_FADE_CLASS,
                expanded ? 'px-4 pt-4 pb-1' : 'px-2 py-3',
              )}
              onPaste={paste}
              onBlur={() => setTrigger(null)}
              onChange={(event) => update(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return
                if (trigger) {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    setTrigger(null)
                    return
                  }
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault()
                    menu.current?.move(event.key === 'ArrowDown' ? 1 : -1)
                    return
                  }
                  if (
                    (event.key === 'Enter' && !event.shiftKey) ||
                    event.key === 'Tab'
                  ) {
                    if (menu.current?.accept()) {
                      event.preventDefault()
                      return
                    }
                  }
                }
                if (event.key !== 'Enter' || event.shiftKey) return
                event.preventDefault()
                // Mod+Enter on an empty composer sends the newest queued row.
                if (
                  (event.metaKey || event.ctrlKey) &&
                  !hasContent &&
                  queued.length > 0
                ) {
                  sendQueuedNow(queued.at(-1)!.id)
                  return
                }
                void submit()
              }}
            />
            <textarea
              ref={mirror}
              aria-hidden
              tabIndex={-1}
              readOnly
              rows={1}
              className="pointer-events-none invisible absolute inset-x-0 top-0 h-0 resize-none overflow-hidden border-0 px-4 pt-4 pb-1 text-[16px] leading-[22.75px] sm:text-[14px]"
            />
            <div
              ref={chip}
              className={cn(
                'flex min-w-0 [grid-area:chip]',
                expanded
                  ? 'mb-2 ml-0.5 max-w-[248px] self-end justify-self-start'
                  : 'max-w-[45cqw] self-center',
              )}
            >
              <ModelChip
                harnessOptions={harnessOptions}
                harnessEntries={harnessEntries}
                accounts={accounts}
                loaded={catalogLoaded}
                selection={selection}
                models={models}
                modelsLoading={modelsLoading}
                configOptions={pickable}
                configSelections={configSelections}
                configDisabled={running || sending}
                hero={draftMode}
                open={pickerOpen}
                onOpenChange={setPickerOpen}
                returnFocus={textarea}
                onSelectionChange={(next) => {
                  setSelection(next)
                  onSelectionChange?.(next)
                }}
                onConfigChange={(id, value) => {
                  const nextSelections = { ...configSelections, [id]: value }
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
            </div>
            <button
              type={stopping ? 'button' : 'submit'}
              className={cn(
                'relative grid size-7 shrink-0 place-items-center rounded-full bg-foreground text-background outline-none [grid-area:send] enabled:cursor-pointer enabled:hover:opacity-85 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-35',
                'pointer-coarse:after:absolute pointer-coarse:after:-inset-2 pointer-coarse:after:content-[""]',
                expanded ? 'mr-3 mb-[10px] ml-2 self-end' : 'mx-2 self-center',
              )}
              disabled={stopping ? interrupting : blocked}
              title={
                stopping
                  ? 'Stop the current turn'
                  : !canSendUploads(uploads)
                    ? 'Wait for uploads to finish or remove failed files'
                    : undefined
              }
              aria-label={
                stopping ? 'End turn' : running ? 'Queue message' : 'Send'
              }
              onClick={stopping ? () => void endTurn() : undefined}
            >
              {stopping ? (
                <span
                  aria-hidden
                  className="size-[11px] rounded-[3px] bg-current"
                />
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
        <div className="relative -mb-2 flex h-6 min-w-0 items-center gap-1 pl-2.5 pointer-coarse:h-9">
          {footer}
          <span className="min-w-0 flex-1" />
          {contextWindow && (
            <span className="flex shrink-0 items-center pr-2.5">
              <ContextWindowMeter
                usage={contextWindow}
                account={accountSnapshot}
              />
            </span>
          )}
        </div>
      </form>
      {dragging &&
        createPortal(
          <div
            className={cn(
              'pointer-events-none inset-0 z-50 grid place-items-center bg-black/20 text-[13px] text-foreground dark:bg-black/40',
              pane ? 'absolute' : 'fixed',
            )}
          >
            Drop to attach
          </div>,
          pane ?? document.body,
        )}
    </>
  )
}
