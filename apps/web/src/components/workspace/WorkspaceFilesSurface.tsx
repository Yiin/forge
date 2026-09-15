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
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Spinner } from '../ui/spinner'
import { cn } from '@/lib/utils'
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
}
type OpenFile = {
  path: string
  snapshot: WorkspaceSnapshot
  text: string
  savedText: string
  dirty: boolean
  conflict: boolean
  saving: boolean
  error: string | null
}

export function WorkspaceFilesSurface({ sessionId, target }: Props) {
  const selection = useMemo<WorkspaceSelection>(
    () => ({ sessionId, ...target }),
    [sessionId, target],
  )
  const [entries, setEntries] = useState<WorkspaceEntry[]>([])
  const [path, setPath] = useState('')
  const [open, setOpen] = useState<OpenFile | null>(null)
  const [query, setQuery] = useState('')
  const [includeIgnored, setIncludeIgnored] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)

  const load = async (directory = path) => {
    setLoading(true)
    setError(null)
    try {
      setEntries(
        (await listWorkspaceFiles(selection, directory, includeIgnored))
          .entries,
      )
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

  const openPath = async (next: string) => {
    const entry = entries.find((item) => item.path === next)
    if (entry?.type === 'directory') {
      setPath(next)
      void load(next)
      return
    }
    setError(null)
    try {
      const snapshot = await readWorkspaceFile(selection, next)
      if (snapshot.file.text === null || snapshot.file.readOnlyReason) {
        setError(
          `${next} is read-only: ${snapshot.file.readOnlyReason ?? 'unsupported content'}`,
        )
        return
      }
      setOpen({
        path: next,
        snapshot,
        text: snapshot.file.text,
        savedText: snapshot.file.text,
        dirty: false,
        conflict: false,
        saving: false,
        error: null,
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not read file')
    }
  }

  const close = () => {
    if (open?.dirty && !window.confirm('Discard unsaved changes?')) return
    setOpen(null)
  }
  const save = async () => {
    if (!open || open.saving || !open.dirty) return
    setOpen({ ...open, saving: true, error: null })
    try {
      const saved = await saveWorkspaceFile(selection, open.snapshot, open.text)
      setOpen({
        ...open,
        snapshot: saved,
        savedText: open.text,
        dirty: false,
        conflict: false,
        saving: false,
      })
    } catch (cause) {
      const conflict =
        cause instanceof WorkspaceFilesError && cause.code === 'conflict'
      setOpen({
        ...open,
        saving: false,
        conflict,
        error: cause instanceof Error ? cause.message : 'Could not save file',
      })
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
          />
        ) : (
          <div className="hidden flex-1 items-center justify-center p-6 text-sm text-muted-foreground md:flex">
            Select a file to edit.
          </div>
        )}
      </div>
    </div>
  )
}

function EditorPanel({
  open,
  onChange,
  onSave,
  onClose,
}: {
  open: OpenFile
  onChange: (file: OpenFile) => void
  onSave: () => void
  onClose: () => void
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
            onChange({ ...open, text, dirty: text !== open.savedText })
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
  }, [open.path, open.snapshot.file.fileRevision])
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
          disabled={!open.dirty || open.saving}
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
            onClick={() => window.location.reload()}
          >
            <RotateCcw size={14} /> Reload
          </Button>
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
