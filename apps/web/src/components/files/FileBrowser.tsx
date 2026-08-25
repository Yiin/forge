import { ArrowLeft, ChevronRight, Files } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLocation, useNavigate, useParams } from '@tanstack/react-router'
import { FileViewer } from './FileViewer'
import { FileTreeView } from './FileTreeView'
import { filePathUrl, parentPath, pathToSplat } from './fileBrowserPath'

type Entry = { name: string; type: 'file' | 'dir'; sizeBytes: number }

export function FileBrowser() {
  const { projectId, _splat } = useParams({ from: '/files/$projectId/$' })
  const path = pathToSplat(_splat)
  const project = projectId ?? ''
  const navigate = useNavigate()
  const location = useLocation()
  const [entry, setEntry] = useState<Entry | null>(null)
  const isFile = Boolean(path && entry?.type === 'file')
  const fileUrl = `/api/projects/${encodeURIComponent(project)}/file?path=${encodeURIComponent(path)}`

  useEffect(() => {
    if (!path) {
      setEntry(null)
      return
    }
    const controller = new AbortController()
    fetch(
      `/api/projects/${encodeURIComponent(project)}/files?path=${encodeURIComponent(parentPath(path))}`,
      { signal: controller.signal },
    )
      .then((response) => response.json() as Promise<Entry[]>)
      .then((entries) =>
        setEntry(
          entries.find(
            (candidate) => candidate.name === path.split('/').pop(),
          ) ?? null,
        ),
      )
      .catch(() => undefined)
    return () => controller.abort()
  }, [path, project])

  const select = (nextPath: string) => {
    void navigate({ to: filePathUrl(project, nextPath) })
  }
  const back = () => {
    if (isFile) void navigate({ to: filePathUrl(project) })
    else void navigate({ to: '/s/$sessionId', params: { sessionId: 'new' } })
  }

  return (
    <section
      className={`file-browser ${isFile ? 'file-browser-selected' : ''}`}
    >
      <header className="file-browser-header">
        {isFile && (
          <button
            className="file-browser-back"
            onClick={back}
            aria-label="Back to files"
          >
            <ArrowLeft size={18} />
          </button>
        )}
        <Files size={18} aria-hidden="true" />
        <nav aria-label="File path" className="file-browser-breadcrumb">
          <button onClick={() => select('')}>Project files</button>
          {path
            .split('/')
            .filter(Boolean)
            .map((segment, index, segments) => {
              const segmentPath = segments.slice(0, index + 1).join('/')
              return (
                <span key={segmentPath}>
                  <ChevronRight size={14} />
                  <button onClick={() => select(segmentPath)}>{segment}</button>
                </span>
              )
            })}
        </nav>
      </header>
      <div className="file-browser-content">
        <div className="file-browser-tree">
          <FileTreeView
            projectId={project}
            selectedPath={path}
            onSelect={select}
          />
        </div>
        {isFile && entry ? (
          <div className="file-browser-viewer">
            <FileViewer
              url={fileUrl}
              downloadUrl={fileUrl}
              filename={path.split('/').pop() ?? path}
              mime={mimeFor(path)}
              sizeBytes={entry.sizeBytes}
            />
          </div>
        ) : (
          <div className="file-browser-empty">Select a file to view it.</div>
        )}
      </div>
      <span className="sr-only">Current route: {location.pathname}</span>
    </section>
  )
}

function mimeFor(path: string) {
  const extension = path.split('.').pop()?.toLowerCase()
  return (
    (
      {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp',
        pdf: 'application/pdf',
        mp4: 'video/mp4',
        mp3: 'audio/mpeg',
        ts: 'text/typescript',
        tsx: 'text/typescript',
        js: 'text/javascript',
        css: 'text/css',
        json: 'application/json',
        md: 'text/markdown',
        txt: 'text/plain',
      } as Record<string, string>
    )[extension ?? ''] ?? 'application/octet-stream'
  )
}
