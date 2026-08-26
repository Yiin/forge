import { Paperclip, Send } from 'lucide-react'
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '../ui/select'
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

const commandDefaults: ComposerCommand[] = [
  { id: 'btw', label: '/btw', group: 'Built-in', value: '/btw ' },
  { id: 'help', label: '/help', group: 'Built-in', value: '/help' },
  { id: 'clear', label: '/clear', group: 'Built-in', value: '/clear' },
]

export function Composer({
  sessionId,
  harness,
  protocol,
  running = false,
  onInterrupt,
  onSend,
  sending = false,
}: {
  sessionId: string
  harness?: string
  protocol?: 'acp' | 'pty'
  running?: boolean
  onInterrupt?: () => Promise<void>
  onSend: (
    text: string,
    attachmentIds: string[],
    harness: string,
  ) => Promise<void>
  sending?: boolean
}) {
  const [text, setText] = useState('')
  const [trigger, setTrigger] = useState<ComposerTrigger | null>(null)
  const [uploads, dispatchUploads] = useState(initialAttachmentUploads)
  const [dragging, setDragging] = useState(false)
  const [commands, setCommands] = useState(commandDefaults)
  const [selectedHarness, setSelectedHarness] = useState(harness ?? '')
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
  }, [sessionId])
  const [harnesses, setHarnesses] = useState<string[]>(harness ? [harness] : [])
  useEffect(() => {
    void fetch('/api/status')
      .then((response) => (response.ok ? response.json() : null))
      .then((status: { harnesses?: Array<{ key: string }> } | null) => {
        if (status?.harnesses)
          setHarnesses(status.harnesses.map((item) => item.key))
      })
      .catch(() => undefined)
  }, [])
  const update = (
    value: string,
    cursor = textarea.current?.selectionStart ?? value.length,
  ) => {
    setText(value)
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
      const result = await api.upload(sessionId, file, (progress) =>
        dispatchUploads((state) =>
          attachmentUploadsReducer(state, { type: 'progress', id, progress }),
        ),
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
        !(event.target as Element | null)?.closest('.composer')
      ) {
        event.preventDefault()
        setDragging(true)
      }
    }
    const leave = () => setDragging(false)
    const drop = (event: DragEvent) => {
      if (
        !hasFiles(event) ||
        (event.target as Element | null)?.closest('.composer')
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
    if (!value || !canSendUploads(uploads)) return
    setSendError(null)
    try {
      await onSend(value, completedAttachmentIds(uploads), selectedHarness)
      setText('')
      setTrigger(null)
      dispatchUploads(initialAttachmentUploads)
    } catch (error) {
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
  return (
    <div className="composer-wrap">
      <AskUserQuestionPanel sessionId={sessionId} />
      <form
        className={`composer ${dragging ? 'composer-dragging' : ''}`}
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
          <div className="composer-drop-overlay">Drop files to upload</div>
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
                '.composer-command-menu [cmdk-item]',
              )
              item?.focus()
              return
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              if (event.nativeEvent.isComposing) return
              if (trigger) {
                event.preventDefault()
                const item = document.querySelector<HTMLElement>(
                  '.composer-command-menu [cmdk-item]',
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
          <div className="composer-error" role="alert">
            {sendError}
          </div>
        )}
        <div className="composer-footer">
          <label className="composer-file">
            <Paperclip size={17} />
            <input
              aria-label="Attach files"
              type="file"
              multiple
              onChange={(event) => {
                addFiles(event.target.files ?? [])
                event.target.value = ''
              }}
            />
          </label>
          {harnesses.length > 0 && (
            <Select
              value={selectedHarness}
              onValueChange={(value) => {
                if (typeof value === 'string') setSelectedHarness(value)
              }}
            >
              <SelectTrigger className="composer-harness" aria-label="Harness">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {harnesses.map((entry) => (
                  <SelectItem key={entry} value={entry}>
                    {entry}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          )}
          <span className="composer-footer-spacer" />
          {protocol === 'pty' && running && onInterrupt && (
            <button
              type="button"
              className="composer-end-turn"
              disabled={interrupting}
              aria-label="End turn"
              title="End the current PTY turn without closing the process"
              onClick={() => void endTurn()}
            >
              {interrupting ? 'Ending…' : 'End turn'}
            </button>
          )}
          <button
            type="submit"
            disabled={sending || !text.trim() || !canSendUploads(uploads)}
            title={
              !canSendUploads(uploads)
                ? 'Wait for uploads to finish or remove failed files'
                : undefined
            }
            aria-label="Send"
          >
            <Send size={17} />
            <span className="composer-send-label">
              {sending ? 'Sending…' : 'Send'}
            </span>
          </button>
        </div>
      </form>
    </div>
  )
}
