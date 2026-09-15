import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import {
  FileCode2,
  FileText,
  Folder,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Spinner } from '../ui/spinner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog'
import { cn } from '@/lib/utils'
import { readFilePreferences } from '@/lib/settings-preferences'
import {
  listWorkspaceFiles,
  readWorkspaceFile,
  saveWorkspaceFile,
  searchWorkspaceFiles,
  WorkspaceFilesError,
  type WorkspaceSelection,
} from '@/lib/workspace-files'
import type {
  WorkspaceEntry,
  WorkspaceSnapshot,
} from '@forge/protocol/workspace'

type Props = {
  sessionId: string
  target: { workspaceId?: string | null; workspaceRevision?: number | null }
  initialPath?: string
  transitionRef?: React.MutableRefObject<((action: () => void) => void) | null>
}
type OpenFile = {
  identity: number
  owner: string
  path: string
  snapshot: WorkspaceSnapshot
  text: string
  savedText: string
  dirty: boolean
  conflict: boolean
  staleTarget: boolean
  saving: boolean
  error: string | null
}

const retainedFiles = new Map<string, OpenFile>()
const retainedListeners = new Map<{ current: OpenFile | null }, () => void>()
let nextDocumentIdentity = 0
function warnUnsaved(event: BeforeUnloadEvent) {
  if ([...retainedFiles.values()].some((file) => file.dirty || file.saving)) {
    event.preventDefault()
    event.returnValue = ''
  }
}
function retainFile(file: OpenFile | null, previous: OpenFile | null) {
  if (previous && previous.identity !== file?.identity)
    retainedFiles.delete(previous.owner)
  if (file) {
    const mounted = [...retainedListeners.keys()].some(
      (editor) => editor.current?.identity === file.identity,
    )
    if (file.dirty || file.saving || mounted)
      retainedFiles.set(file.owner, file)
    else retainedFiles.delete(file.owner)
  }
  window.removeEventListener('beforeunload', warnUnsaved)
  if ([...retainedFiles.values()].some((entry) => entry.dirty || entry.saving))
    window.addEventListener('beforeunload', warnUnsaved)
  for (const listener of retainedListeners.values()) listener()
}

export function WorkspaceFilesSurface({
  sessionId,
  target,
  initialPath,
  transitionRef,
}: Props) {
  const selection = useMemo<WorkspaceSelection>(
    () => ({ sessionId, ...target }),
    [sessionId, target.workspaceId, target.workspaceRevision],
  )
  const [entries, setEntries] = useState<WorkspaceEntry[]>([])
  const [path, setPath] = useState('')
  const owner = JSON.stringify([
    sessionId,
    target.workspaceId,
    target.workspaceRevision,
  ])
  const [open, updateOpen] = useState<OpenFile | null>(
    () => retainedFiles.get(owner) ?? null,
  )
  const currentOpen = useRef<OpenFile | null>(open)
  const documentIdentity = useRef(0)
  const pendingTransition = useRef<(() => void) | null>(null)
  const setOpen = useCallback(
    (
      value: OpenFile | null | ((current: OpenFile | null) => OpenFile | null),
    ) => {
      const previous = currentOpen.current
      const retained = previous && retainedFiles.get(previous.owner)
      if (
        typeof value === 'function' &&
        previous &&
        retained?.identity !== previous.identity
      )
        return
      if (retained) currentOpen.current = retained
      currentOpen.current =
        typeof value === 'function' ? value(currentOpen.current) : value
      retainFile(currentOpen.current, previous)
      updateOpen(currentOpen.current)
    },
    [],
  )
  useEffect(() => {
    const changed = () => {
      const current = currentOpen.current
      const retained = current && retainedFiles.get(current.owner)
      if (retained?.identity === current?.identity && retained) {
        currentOpen.current = retained
        updateOpen(retained)
      }
    }
    retainedListeners.set(currentOpen, changed)
    return () => {
      retainedListeners.delete(currentOpen)
    }
  }, [])
  const [query, setQuery] = useState('')
  const [includeIgnored, setIncludeIgnored] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  const [closeRequested, setCloseRequested] = useState(false)
  const requestGeneration = useRef(0)
  const initialPathOpened = useRef<string | undefined>(undefined)
  const filePreferences = readFilePreferences()
  useEffect(
    () => () => {
      documentIdentity.current = ++nextDocumentIdentity
      const file = currentOpen.current
      if (
        file &&
        !file.dirty &&
        !file.saving &&
        retainedFiles.get(file.owner)?.identity === file.identity
      )
        retainedFiles.delete(file.owner)
    },
    [],
  )

  useEffect(() => {
    requestGeneration.current += 1
    setOpen((current) =>
      current && current.owner !== owner
        ? { ...current, staleTarget: true }
        : current,
    )
    setPath('')
    initialPathOpened.current = undefined
  }, [selection])

  const load = async (directory = path) => {
    const generation = requestGeneration.current
    setLoading(true)
    setError(null)
    try {
      const listing = await listWorkspaceFiles(
        selection,
        directory,
        includeIgnored,
      )
      if (generation !== requestGeneration.current) return
      setEntries(listing.entries)
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not load workspace files',
      )
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void load('')
  }, [selection, includeIgnored])

  useEffect(() => {
    if (
      !filePreferences.autosave ||
      !open?.dirty ||
      open.saving ||
      open.staleTarget
    )
      return
    const timer = window.setTimeout(
      () => void save(),
      filePreferences.autosaveDelayMs,
    )
    return () => window.clearTimeout(timer)
  }, [
    filePreferences.autosave,
    filePreferences.autosaveDelayMs,
    open?.text,
    open?.dirty,
    open?.saving,
    open?.staleTarget,
  ])

  const readPath = async (next: string) => {
    const entry = entries.find((item) => item.path === next)
    if (entry?.type === 'directory') {
      setPath(next)
      void load(next)
      return
    }
    setError(null)
    const generation = requestGeneration.current
    if (!retainedFiles.has(owner) && retainedFiles.size >= 32) {
      setError('Close an open file before opening another workspace.')
      return
    }
    const identity = ++nextDocumentIdentity
    documentIdentity.current = identity
    try {
      const snapshot = await readWorkspaceFile(selection, next)
      if (
        generation !== requestGeneration.current ||
        identity !== documentIdentity.current
      )
        return
      if (snapshot.file.text === null || snapshot.file.readOnlyReason) {
        setError(
          `${next} is read-only: ${snapshot.file.readOnlyReason ?? 'unsupported content'}`,
        )
        return
      }
      const text = snapshot.file.text
      transition(() => {
        if (
          generation !== requestGeneration.current ||
          identity !== documentIdentity.current
        )
          return
        setOpen({
          identity,
          owner,
          path: next,
          snapshot,
          text,
          savedText: text,
          dirty: false,
          conflict: false,
          staleTarget: false,
          saving: false,
          error: null,
        })
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not read file')
    }
  }

  useEffect(() => {
    if (!initialPath) {
      initialPathOpened.current = undefined
      return
    }
    if (initialPathOpened.current === initialPath) return
    initialPathOpened.current = initialPath
    if (
      currentOpen.current?.path !== initialPath ||
      currentOpen.current.owner !== owner
    )
      void openPath(initialPath)
  }, [initialPath])

  const transition = (action: () => void) => {
    if (currentOpen.current?.dirty || currentOpen.current?.saving) {
      pendingTransition.current = action
      setCloseRequested(true)
    } else action()
  }
  const openPath = (next: string) => transition(() => void readPath(next))
  const close = () =>
    transition(() => {
      documentIdentity.current += 1
      setOpen(null)
    })
  const discardAndClose = () => {
    const action = pendingTransition.current
    pendingTransition.current = null
    setCloseRequested(false)
    setOpen(null)
    action?.()
  }
  useEffect(() => {
    if (!transitionRef) return
    transitionRef.current = transition
    return () => {
      transitionRef.current = null
    }
  })
  const save = async () => {
    const submitted = currentOpen.current
    if (!submitted) return true
    if (submitted.saving) return false
    if (!submitted.dirty) return true
    if (submitted.staleTarget) return false
    const generation = requestGeneration.current
    setOpen({ ...submitted, saving: true, error: null })
    try {
      const saved = await saveWorkspaceFile(
        selection,
        submitted.snapshot,
        submitted.text,
      )
      setOpen((current) => {
        if (!current || current.identity !== submitted.identity) return current
        const hasNewerEdits = current.text !== submitted.text
        return {
          ...current,
          snapshot: saved,
          savedText: submitted.text,
          dirty: hasNewerEdits,
          conflict: false,
          saving: false,
          error: null,
        }
      })
      return (
        currentOpen.current?.identity === submitted.identity &&
        !currentOpen.current.dirty &&
        generation === requestGeneration.current
      )
    } catch (cause) {
      const conflict =
        cause instanceof WorkspaceFilesError && cause.code === 'conflict'
      setOpen((current) =>
        current?.identity === submitted.identity
          ? {
              ...current,
              saving: false,
              conflict,
              error:
                cause instanceof Error ? cause.message : 'Could not save file',
            }
          : current,
      )
      return false
    }
  }

  const runSearch = async () => {
    if (!query.trim()) {
      void load(path)
      return
    }
    setSearching(true)
    setError(null)
    try {
      setEntries(
        (await searchWorkspaceFiles(selection, query, includeIgnored)).matches,
      )
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not search workspace',
      )
    } finally {
      setSearching(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-[38px] shrink-0 items-center gap-1 border-b border-border p-1.5">
        <Button
          variant="ghost"
          size="icon-sm"
          className="pointer-coarse:size-11"
          onClick={() => {
            setPath('')
            void load('')
          }}
          aria-label="Workspace root"
        >
          <Folder size={16} />
        </Button>
        <form
          className="flex min-w-0 flex-1 items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault()
            void runSearch()
          }}
        >
          <Search
            size={14}
            className="shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search files"
            aria-label="Search workspace files"
            className="h-7 border-0 px-1 shadow-none focus-visible:ring-0"
          />
        </form>
        <label className="hidden items-center gap-1 text-xs text-muted-foreground sm:flex">
          <input
            type="checkbox"
            checked={includeIgnored}
            onChange={(event) => setIncludeIgnored(event.target.checked)}
          />{' '}
          ignored
        </label>
        <Button
          variant="ghost"
          size="icon-sm"
          className="pointer-coarse:size-11"
          onClick={() => void load(path)}
          aria-label="Reload files"
        >
          <RefreshCw size={15} />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1">
        <div
          className={cn(
            'min-w-0 flex-1 overflow-auto',
            open && 'hidden md:block md:max-w-[38%] md:border-r',
          )}
        >
          <div className="border-b border-border px-2 py-1 text-xs text-muted-foreground">
            {path || 'Workspace'}
          </div>
          {loading || searching ? (
            <p
              role="status"
              className="flex items-center gap-2 p-4 text-sm text-muted-foreground"
            >
              <Spinner /> Loading files…
            </p>
          ) : error && !open ? (
            <div className="p-3 text-sm text-destructive" role="alert">
              {error}
            </div>
          ) : entries.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No files found.</p>
          ) : (
            <div role="tree" aria-label="Workspace files" className="p-1">
              {entries.map((entry) => (
                <button
                  key={entry.path}
                  role="treeitem"
                  aria-level={entry.path.split('/').length}
                  className="flex min-h-7 w-full items-center gap-2 rounded px-2 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => void openPath(entry.path)}
                  onKeyDown={(event) => {
                    if (
                      event.key === 'ArrowRight' &&
                      entry.type === 'directory'
                    )
                      void openPath(entry.path)
                    if (event.key === 'ArrowLeft') {
                      setPath(entry.path.split('/').slice(0, -1).join('/'))
                      void load(entry.path.split('/').slice(0, -1).join('/'))
                    }
                  }}
                >
                  <span
                    style={{
                      paddingLeft: `${Math.max(0, entry.path.split('/').length - 1) * 12}px`,
                    }}
                  >
                    {entry.type === 'directory' ? (
                      <Folder size={14} />
                    ) : (
                      <FileText size={14} />
                    )}
                  </span>
                  <span className="truncate">{entry.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {open ? (
          <EditorPanel
            open={open}
            onChange={setOpen}
            onSave={() => void save()}
            onClose={close}
            onReload={() => transition(() => void readPath(open.path))}
          />
        ) : (
          <div className="hidden flex-1 items-center justify-center p-6 text-sm text-muted-foreground md:flex">
            Select a file to edit.
          </div>
        )}
      </div>
      <AlertDialog open={closeRequested} onOpenChange={setCloseRequested}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Save changes before continuing?</AlertDialogTitle>
            <AlertDialogDescription>
              Your changes to {open?.path} are not saved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={discardAndClose} variant="ghost">
              Discard
            </AlertDialogAction>
            <Button
              onClick={async () => {
                if (await save()) {
                  const action = pendingTransition.current
                  pendingTransition.current = null
                  setCloseRequested(false)
                  action?.()
                }
              }}
              disabled={open?.saving || (open?.dirty && open?.staleTarget)}
            >
              Save
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function EditorPanel({
  open,
  onChange,
  onSave,
  onClose,
  onReload,
}: {
  open: OpenFile
  onChange: (update: (file: OpenFile | null) => OpenFile | null) => void
  onSave: () => void
  onClose: () => void
  onReload: () => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  useEffect(() => {
    if (!host.current) return
    const extension = open.path.endsWith('.json')
      ? json()
      : open.path.endsWith('.md')
        ? markdown()
        : open.path.match(/\.(ts|tsx|js|jsx)$/)
          ? javascript({ jsx: true, typescript: true })
          : []
    const state = EditorState.create({
      doc: open.text,
      extensions: [
        lineNumbers(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        extension,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const text = update.state.doc.toString()
            onChange((current) =>
              current?.identity === open.identity
                ? { ...current, text, dirty: text !== current.savedText }
                : current,
            )
          }
        }),
      ],
    })
    view.current = new EditorView({ state, parent: host.current })
    return () => {
      view.current?.destroy()
      view.current = null
    }
    // The editor must be recreated only when its document changes identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open.identity])
  return (
    <section
      className="flex min-w-0 flex-1 flex-col"
      aria-label={`Editor for ${open.path}`}
    >
      <header className="flex min-h-[38px] shrink-0 items-center gap-2 border-b border-border px-2">
        <FileCode2 size={15} />
        <span className="min-w-0 flex-1 truncate text-xs">
          {open.path}
          {open.dirty && ' •'}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          className="pointer-coarse:size-11"
          disabled={!open.dirty || open.saving || open.staleTarget}
          onClick={onSave}
          aria-label="Save file"
        >
          <Save size={15} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="pointer-coarse:size-11"
          onClick={onClose}
          aria-label="Close file"
        >
          <X size={15} />
        </Button>
      </header>
      {open.conflict && (
        <div
          className="flex items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs"
          role="alert"
        >
          File changed on disk. Your edits are preserved.
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={onReload}
          >
            <RotateCcw size={14} /> Reload
          </Button>
        </div>
      )}
      {open.staleTarget && (
        <div
          className="border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs"
          role="alert"
        >
          Workspace changed. Your edits are preserved, but saving is disabled.
        </div>
      )}
      {open.error && (
        <div
          className="border-b border-destructive/30 px-3 py-2 text-xs text-destructive"
          role="alert"
        >
          {open.error}
        </div>
      )}
      <div
        ref={host}
        className="min-h-0 flex-1 overflow-auto text-[13px] [&_.cm-editor]:min-h-full [&_.cm-scroller]:font-mono [&_.cm-scroller]:overflow-auto"
      />
    </section>
  )
}
