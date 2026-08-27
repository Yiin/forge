import { FileTree, useFileTree } from '@pierre/trees/react'
import { Copy, Download, RotateCcw } from 'lucide-react'
import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { directoriesToLoad, filePathUrl } from './fileBrowserPath'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'

type Entry = {
  name: string
  type: 'file' | 'dir'
  sizeBytes: number
  mtimeMs: number
}

type Props = {
  projectId: string
  selectedPath: string
  onSelect: (path: string) => void
}

// Theme the shadow-rendered @pierre/trees tree via its documented CSS custom
// properties so rows match our shadcn tokens (hover/selected both bg-accent,
// rounded-md, h-7-ish rows, subtle border-colored indent guides).
const treeThemeStyle: CSSProperties = {
  '--trees-bg-override': 'transparent',
  '--trees-fg-override': 'var(--foreground)',
  '--trees-fg-muted-override': 'var(--muted-foreground)',
  '--trees-border-color-override': 'var(--border)',
  '--trees-border-radius-override': 'var(--radius-md)',
  '--trees-bg-muted-override': 'var(--accent)',
  '--trees-selected-bg-override': 'var(--accent)',
  '--trees-selected-fg-override': 'var(--accent-foreground)',
  '--trees-indent-guide-bg-override': 'var(--border)',
  '--trees-focus-ring-color-override': 'var(--ring)',
  '--trees-item-height': '28px',
} as CSSProperties

// unsafeCSS is the library's sanctioned escape hatch for injecting extra
// rules into its shadow root (see FileTreeOptionSurface['unsafeCSS']).
const treeUnsafeCSS = `
  [data-type="item"] { transition: background-color 120ms ease; }
  [data-icon-name="file-tree-icon-chevron"] { transition: transform 120ms ease; }
`

async function readDirectory(projectId: string, path: string) {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/files?path=${encodeURIComponent(path)}`,
  )
  if (!response.ok) throw new Error('Could not load directory')
  return (await response.json()) as Entry[]
}

function pathsForDirectory(path: string, entries: Entry[]) {
  // @pierre/trees infers directory-vs-file from a trailing slash on the path
  // string itself (see splitCanonicalPath), which is the only way an
  // unexpanded, childless directory renders with a folder icon and chevron.
  return entries.map(
    (entry) =>
      `${path ? `${path}/` : ''}${entry.name}${entry.type === 'dir' ? '/' : ''}`,
  )
}

export function FileTreeView({ projectId, selectedPath, onSelect }: Props) {
  const [paths, setPaths] = useState<string[]>([])
  const [loaded, setLoaded] = useState<Record<string, boolean>>({})
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const expanded = useMemo(() => {
    const ancestors = directoriesToLoad(selectedPath).slice(1)
    // A selected directory (not just its ancestors) should open too, or its
    // freshly loaded children stay hidden behind a collapsed row.
    return selectedPath ? [...ancestors, selectedPath] : ancestors
  }, [selectedPath])
  const { model } = useFileTree({
    paths,
    initialExpansion: 'closed',
    initialExpandedPaths: expanded,
    initialSelectedPaths: selectedPath ? [selectedPath] : [],
    icons: { set: 'standard', colored: true },
    unsafeCSS: treeUnsafeCSS,
    onSelectionChange: ([path]) => {
      if (path) onSelect(path)
    },
  })

  // useFileTree only reads `paths`/etc. from its very first render (it
  // constructs the model once via lazy useState). The directory-loading
  // effects below populate `paths` asynchronously afterward, so the model
  // has to be told about every subsequent change explicitly.
  useEffect(() => {
    model.resetPaths(paths, { initialExpandedPaths: expanded })
    if (selectedPath) model.getItem(selectedPath)?.select()
  }, [model, paths, expanded, selectedPath])

  useEffect(() => {
    let active = true
    const directories = directoriesToLoad(selectedPath)

    async function loadDirectories() {
      // `loaded` was just reset below, so its pre-reset closure value can't
      // tell us what's already fetched for this cycle — only dedupe within
      // this loop.
      const seen = new Set<string>()
      for (const directory of directories) {
        if (seen.has(directory)) continue
        seen.add(directory)
        const entries = await readDirectory(projectId, directory)
        if (!active) return
        setPaths((current) => [
          ...new Set([...current, ...pathsForDirectory(directory, entries)]),
        ])
        setLoaded((current) => ({ ...current, [directory]: true }))
      }
      if (active) setLoading(false)
    }

    setError(null)
    setPaths([])
    setLoaded({})
    void loadDirectories().catch((cause: unknown) => {
      if (active) {
        setLoading(false)
        setError(causeMessage(cause))
      }
    })
    return () => {
      active = false
    }
  }, [projectId, selectedPath])

  useEffect(() => {
    const directory =
      selectedPath && model.getItem(selectedPath)?.isDirectory()
        ? selectedPath
        : ''
    if (!directory || loaded[directory]) return
    let active = true
    readDirectory(projectId, directory)
      .then((entries) => {
        if (!active) return
        setPaths((current) => [
          ...new Set([...current, ...pathsForDirectory(directory, entries)]),
        ])
        setLoaded((current) => ({ ...current, [directory]: true }))
      })
      .catch((cause: unknown) => active && setError(causeMessage(cause)))
    return () => {
      active = false
    }
  }, [loaded, model, projectId, selectedPath])

  const copyPath = async (path: string) => {
    await navigator.clipboard.writeText(path)
  }

  if (error)
    return (
      <div className="flex flex-col items-start gap-3 p-4">
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="pointer-coarse:h-11 pointer-coarse:px-4"
          onClick={() => {
            setError(null)
            setLoaded({})
          }}
        >
          <RotateCcw size={14} /> Retry
        </Button>
      </div>
    )
  if (loading && !paths.length)
    return (
      <div
        className="flex flex-col gap-1 p-1.5"
        role="status"
        aria-label="Loading directory"
      >
        {[0, 1, 1, 2, 1, 0].map((indent, index) => (
          <Skeleton
            key={index}
            className="h-7 rounded-md"
            style={{ marginLeft: `${indent * 16}px` }}
          />
        ))}
      </div>
    )
  if (!paths.length)
    return (
      <p className="px-3 py-6 text-center text-sm text-muted-foreground">
        This directory is empty.
      </p>
    )
  return (
    <div className="h-full min-h-0">
      <FileTree
        model={model}
        aria-label="Project files"
        style={{ ...treeThemeStyle, minHeight: 240, height: '100%' }}
        renderContextMenu={(item, context) => (
          <div className="grid min-w-40 gap-0.5 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
            <button
              onClick={() => {
                void copyPath(item.path)
                context.close()
              }}
              className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
            >
              <Copy size={14} /> Copy path
            </button>
            <a
              href={`/api/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(item.path)}`}
              download
              className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm no-underline hover:bg-accent hover:text-accent-foreground"
            >
              <Download size={14} /> Download
            </a>
          </div>
        )}
      />
    </div>
  )
}

function causeMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : 'Could not load files'
}

export { filePathUrl }
