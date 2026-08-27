import { ArrowLeft, ChevronRight, Files, RotateCcw, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLocation, useNavigate, useParams } from '@tanstack/react-router'
import { FileViewer } from './FileViewer'
import { FileTreeView } from './FileTreeView'
import { filePathUrl, parentPath, pathToSplat } from './fileBrowserPath'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { Spinner } from '@/components/ui/spinner'

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
        className="mx-auto flex h-full max-w-3xl flex-col"
        aria-labelledby="files-title"
      >
        <header className="flex min-h-13 items-center gap-2.5 border-b border-border px-4 py-2.5">
          <Files
            size={18}
            aria-hidden="true"
            className="text-muted-foreground"
          />
          <h1 id="files-title" className="text-base font-medium">
            Files
          </h1>
        </header>
        {projectState === 'loading' && (
          <p
            role="status"
            className="flex items-center gap-2 p-6 text-sm text-muted-foreground"
          >
            <Spinner /> Loading projects…
          </p>
        )}
        {projectState === 'error' && (
          <div className="flex flex-col items-start gap-3 p-6">
            <p role="alert" className="text-sm text-destructive">
              {projectError}
            </p>
            <Button
              onClick={loadProjects}
              variant="outline"
              size="sm"
              className="pointer-coarse:h-11 pointer-coarse:px-4"
            >
              <RotateCcw size={16} /> Retry
            </Button>
          </div>
        )}
        {projectState === 'empty' && (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Files aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>No projects</EmptyTitle>
              <EmptyDescription>
                Create a project before opening files.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        {projectState === 'ready' && (
          <div role="list" aria-label="Projects" className="grid gap-2 p-4">
            {projects.map((item) => (
              <button
                role="listitem"
                key={item.id}
                onClick={() => navigate({ to: filePathUrl(item.id) })}
                className="pointer-coarse:min-h-11 flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <span className="truncate font-medium">{item.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {item.id}
                </span>
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

  const segments = path.split('/').filter(Boolean)

  return (
    <TooltipProvider delayDuration={300}>
      <section className="flex h-full min-h-0 flex-col">
        <header className="flex min-h-13 items-center gap-1.5 border-b border-border px-2.5 py-2">
          {isFile && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="pointer-coarse:size-11"
                  onClick={back}
                  aria-label="Back to files"
                >
                  <ArrowLeft size={18} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Back to files</TooltipContent>
            </Tooltip>
          )}
          <Files
            size={18}
            aria-hidden="true"
            className="shrink-0 text-muted-foreground"
          />
          <nav
            aria-label="File path"
            className="flex min-w-0 flex-wrap items-center gap-0.5"
          >
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                'h-7 px-2 text-sm',
                segments.length === 0
                  ? 'text-foreground font-medium'
                  : 'text-muted-foreground',
              )}
              onClick={() => select('')}
            >
              Project files
            </Button>
            {segments.map((segment, index) => {
              const segmentPath = segments.slice(0, index + 1).join('/')
              const isLast = index === segments.length - 1
              return (
                <span key={segmentPath} className="flex items-center gap-0.5">
                  <ChevronRight
                    size={14}
                    aria-hidden="true"
                    className="shrink-0 text-muted-foreground"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className={cn(
                      'h-7 max-w-48 truncate px-2 text-sm',
                      isLast
                        ? 'text-foreground font-medium'
                        : 'text-muted-foreground',
                    )}
                    onClick={() => select(segmentPath)}
                  >
                    {segment}
                  </Button>
                </span>
              )
            })}
          </nav>
        </header>
        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(220px,32%)_1fr]">
          <div
            className={cn(
              'flex min-h-0 flex-col border-border md:border-r',
              isFile ? 'hidden md:flex' : 'flex',
            )}
          >
            <form
              className="flex items-center gap-2 border-b border-border px-2 py-1.5"
              onSubmit={(event) => {
                event.preventDefault()
                if (quickOpen.trim()) select(quickOpen.trim())
              }}
            >
              <Search
                size={14}
                aria-hidden="true"
                className="shrink-0 text-muted-foreground"
              />
              <Input
                aria-label="Quick open file"
                placeholder="Quick open path"
                value={quickOpen}
                onChange={(event) => setQuickOpen(event.target.value)}
                className="h-7 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
              />
            </form>
            <div className="min-h-0 flex-1 overflow-auto p-1.5">
              <FileTreeView
                projectId={project}
                selectedPath={path}
                onSelect={select}
              />
            </div>
          </div>
          <div
            className={cn(
              'min-w-0 overflow-auto',
              isFile ? 'block' : 'hidden md:block',
            )}
          >
            {isFile && entry ? (
              <div className="h-full p-4">
                <FileViewer
                  url={fileUrl}
                  downloadUrl={fileUrl}
                  filename={path.split('/').pop() ?? path}
                  mime={mimeFor(path)}
                  sizeBytes={entry.sizeBytes}
                />
              </div>
            ) : (
              <Empty className="h-full">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Files aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyTitle>Select a file to view it</EmptyTitle>
                  <EmptyDescription>
                    Use the tree or Quick open.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </div>
        </div>
        <span className="sr-only">Current route: {location.pathname}</span>
      </section>
    </TooltipProvider>
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
