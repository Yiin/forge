import { FileTree, useFileTree } from '@pierre/trees/react'
import { Copy, Download } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { filePathUrl, pathsToExpand } from './fileBrowserPath'

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

async function readDirectory(projectId: string, path: string) {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/files?path=${encodeURIComponent(path)}`,
  )
  if (!response.ok) throw new Error('Could not load directory')
  return (await response.json()) as Entry[]
}

function pathsForDirectory(path: string, entries: Entry[]) {
  return entries.map((entry) => `${path ? `${path}/` : ''}${entry.name}`)
}

export function FileTreeView({ projectId, selectedPath, onSelect }: Props) {
  const [paths, setPaths] = useState<string[]>([])
  const [loaded, setLoaded] = useState<Record<string, boolean>>({})
  const [error, setError] = useState<string | null>(null)
  const expanded = useMemo(() => pathsToExpand(selectedPath), [selectedPath])
  const { model } = useFileTree({
    paths,
    initialExpansion: 'closed',
    initialExpandedPaths: expanded,
    initialSelectedPaths: selectedPath ? [selectedPath] : [],
    onSelectionChange: ([path]) => {
      if (path) onSelect(path)
    },
  })

  useEffect(() => {
    let active = true
    readDirectory(projectId, '')
      .then((entries) => {
        if (!active) return
        setPaths(pathsForDirectory('', entries))
        setLoaded({ '': true })
      })
      .catch((cause: unknown) => active && setError(causeMessage(cause)))
    return () => {
      active = false
    }
  }, [projectId])

  useEffect(() => {
    const directory =
      selectedPath && model.getItem(selectedPath)?.isDirectory()
        ? selectedPath
        : ''
    if (!directory || loaded[directory]) return
    readDirectory(projectId, directory)
      .then((entries) => {
        setPaths((current) => [
          ...new Set([...current, ...pathsForDirectory(directory, entries)]),
        ])
        setLoaded((current) => ({ ...current, [directory]: true }))
      })
      .catch((cause: unknown) => setError(causeMessage(cause)))
  }, [loaded, model, projectId, selectedPath])

  const copyPath = async (path: string) => {
    await navigator.clipboard.writeText(path)
  }

  if (error) return <p role="alert">{error}</p>
  return (
    <div className="file-tree-view">
      <FileTree
        model={model}
        aria-label="Project files"
        style={{ minHeight: 240, height: '100%' }}
        renderContextMenu={(item, context) => (
          <div className="file-tree-context-menu">
            <button
              onClick={() => {
                void copyPath(item.path)
                context.close()
              }}
            >
              <Copy size={14} /> Copy path
            </button>
            <a
              href={`/api/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(item.path)}`}
              download
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
