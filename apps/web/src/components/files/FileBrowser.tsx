import { ArrowLeft, ChevronRight, Files, Search, RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLocation, useNavigate, useParams } from '@tanstack/react-router'
import { FileViewer } from './FileViewer'
import { FileTreeView } from './FileTreeView'
import { filePathUrl, parentPath, pathToSplat } from './fileBrowserPath'

type Entry = { name: string; type: 'file' | 'dir'; sizeBytes: number }

export function FileBrowser() {
  const params = useParams({ strict: false }) as {
    projectId?: string
    _splat?: string
  }
  const { projectId, _splat } = params
  const path = pathToSplat(_splat)
  const project = projectId ?? ''
  const navigate = useNavigate()
  const location = useLocation()
  const [entry, setEntry] = useState<Entry | null>(null)
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>(
    [],
  )
  const [projectState, setProjectState] = useState<
    'loading' | 'ready' | 'empty' | 'error'
  >('loading')
  const [projectError, setProjectError] = useState<string | null>(null)
  const [quickOpen, setQuickOpen] = useState('')
  const isFile = Boolean(path && entry?.type === 'file')
  const fileUrl = `/api/projects/${encodeURIComponent(project)}/file?path=${encodeURIComponent(path)}`

  const loadProjects = () => {
    setProjectState('loading')
    setProjectError(null)
    fetch('/api/projects')
      .then((response) => {
        if (!response.ok) throw new Error('Could not load projects')
        return response.json() as Promise<Array<{ id: string; name: string }>>
      })
      .then((items) => {
        setProjects(items)
        setProjectState(items.length ? 'ready' : 'empty')
        if (!projectId && items.length === 1)
          void navigate({ to: filePathUrl(items[0].id) })
      })
      .catch((cause: unknown) => {
        setProjectState('error')
        setProjectError(
          cause instanceof Error ? cause.message : 'Could not load projects',
        )
      })
  }

  useEffect(loadProjects, [projectId])

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

  if (!projectId) {
    return (
      <section
        className="file-browser file-project-picker"
        aria-labelledby="files-title"
      >
        <header className="file-browser-header">
          <Files size={18} aria-hidden="true" />
          <h1 id="files-title">Files</h1>
        </header>
        {projectState === 'loading' && <p role="status">Loading projects…</p>}
        {projectState === 'error' && (
          <div className="file-state">
            <p role="alert">{projectError}</p>
            <button onClick={loadProjects}>
              <RotateCcw size={16} /> Retry
            </button>
          </div>
        )}
        {projectState === 'empty' && (
          <div className="file-state">
            <h2>No projects</h2>
            <p>Create a project before opening files.</p>
          </div>
        )}
        {projectState === 'ready' && (
          <div className="file-project-list" role="list" aria-label="Projects">
            {projects.map((item) => (
              <button
                role="listitem"
                key={item.id}
                onClick={() => navigate({ to: filePathUrl(item.id) })}
              >
                {item.name}
                <span>{item.id}</span>
              </button>
            ))}
          </div>
        )}
      </section>
    )
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
          <form
            className="file-quick-open"
            onSubmit={(event) => {
              event.preventDefault()
              if (quickOpen.trim()) select(quickOpen.trim())
            }}
          >
            <Search size={16} aria-hidden="true" />
            <input
              aria-label="Quick open file"
              placeholder="Quick open path"
              value={quickOpen}
              onChange={(event) => setQuickOpen(event.target.value)}
            />
          </form>
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
          <div className="file-browser-empty">
            <strong>Select a file to view it.</strong>
            <span>Use the tree or Quick open.</span>
          </div>
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
