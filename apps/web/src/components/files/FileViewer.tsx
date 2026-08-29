import {
  ChevronLeft,
  ChevronRight,
  Download,
  File as FileIcon,
  X,
} from 'lucide-react'
import { lazy, useEffect, useRef, useState } from 'react'
import { fileViewerKind, languageForFilename } from './fileViewerKind'
import 'yet-another-react-lightbox/styles.css'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Kbd } from '@/components/ui/kbd'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'

export type FileViewerProps = {
  url: string
  filename: string
  mime: string
  sizeBytes: number
  sha256?: string
  downloadUrl?: string
}

const Lightbox = lazy(() => import('yet-another-react-lightbox'))
const PdfDocument = lazy(() =>
  import('react-pdf').then(({ Document, Page, pdfjs }) => {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/build/pdf.worker.min.mjs',
      import.meta.url,
    ).toString()
    return {
      default: function Pdf({ url }: { url: string }) {
        const [pages, setPages] = useState(0)
        const [page, setPage] = useState(1)
        const [error, setError] = useState<string | null>(null)
        const scrollRef = useRef<HTMLDivElement | null>(null)
        const goToPage = (next: number) => {
          const target = Math.min(Math.max(next, 1), pages)
          setPage(target)
          scrollRef.current
            ?.querySelector(`[data-pdf-page="${target}"]`)
            ?.scrollIntoView({ block: 'start', behavior: 'smooth' })
        }
        return error ? (
          <ViewerError message={error} onRetry={() => setError(null)} />
        ) : (
          <div className="flex h-full flex-col">
            {pages > 0 && (
              <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="pointer-coarse:size-11"
                  disabled={page <= 1}
                  onClick={() => goToPage(page - 1)}
                  aria-label="Previous page"
                >
                  <ChevronLeft size={16} />
                </Button>
                <span className="text-sm text-muted-foreground">
                  Page {page} of {pages}
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="pointer-coarse:size-11"
                  disabled={page >= pages}
                  onClick={() => goToPage(page + 1)}
                  aria-label="Next page"
                >
                  <ChevronRight size={16} />
                </Button>
                <span className="ml-auto hidden items-center gap-1 text-xs text-muted-foreground sm:flex">
                  <Kbd>↑</Kbd>
                  <Kbd>↓</Kbd> to scroll
                </span>
              </div>
            )}
            <Document
              file={url}
              loading={
                <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
                  <Spinner /> Loading PDF…
                </p>
              }
              onLoadSuccess={({ numPages }) => setPages(numPages)}
              onLoadError={() => setError('Could not load PDF')}
            >
              <div
                ref={scrollRef}
                className="flex flex-1 flex-col items-center gap-4 overflow-auto p-4"
              >
                {Array.from({ length: pages }, (_, index) => (
                  <LazyPdfPage key={index} Page={Page} pageNumber={index + 1} />
                ))}
                {pages === 0 && (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Spinner /> Loading pages…
                  </p>
                )}
              </div>
            </Document>
          </div>
        )
      },
    }
  }),
)

function LazyPdfPage({
  Page,
  pageNumber,
}: {
  Page: (typeof import('react-pdf'))['Page']
  pageNumber: number
}) {
  const [visible, setVisible] = useState(pageNumber <= 2)
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    if (visible || !element) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: '600px' },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [element, visible])
  return (
    <div
      ref={setElement}
      data-pdf-page={pageNumber}
      className="rounded-lg border border-border shadow-sm"
    >
      {visible ? (
        <Page
          pageNumber={pageNumber}
          width={Math.min(900, window.innerWidth - 32)}
          loading={null}
        />
      ) : (
        <span className="flex h-40 items-center justify-center text-sm text-muted-foreground">
          Page {pageNumber}
        </span>
      )}
    </div>
  )
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  const units = ['KiB', 'MiB', 'GiB']
  let size = value
  let unit = -1
  do {
    size /= 1024
    unit++
  } while (size >= 1024 && unit < units.length - 1)
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`
}

function DownloadCard({ file, href }: { file: FileViewerProps; href: string }) {
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FileIcon aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>{file.filename}</EmptyTitle>
        <EmptyDescription>
          {formatBytes(file.sizeBytes)}
          {file.sha256 ? ` · ${file.sha256}` : ''}
        </EmptyDescription>
      </EmptyHeader>
      <Button
        className="pointer-coarse:h-11 pointer-coarse:px-5"
        render={<a href={href} download={file.filename} />}
      >
        <Download size={16} /> Download
      </Button>
    </Empty>
  )
}

function TextViewer({ file }: { file: FileViewerProps }) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    fetch(file.url, {
      signal: controller.signal,
      headers: { Range: 'bytes=0-1048575' },
    })
      .then((response) => {
        if (!response.ok) throw new Error('Could not load file')
        return response.text()
      })
      .then(setText)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error ? cause.message : 'Could not load file',
          )
      })
    return () => controller.abort()
  }, [file.url])
  if (error)
    return (
      <ViewerError
        message={error}
        onRetry={() => {
          setError(null)
          setText(null)
        }}
      />
    )
  if (text === null)
    return (
      <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Spinner /> Loading file…
      </p>
    )
  const truncated = file.sizeBytes > 1024 * 1024
  return (
    <div className="flex h-full flex-col gap-2">
      <pre
        data-language={languageForFilename(file.filename)}
        className="max-h-[70vh] flex-1 overflow-auto rounded-lg border border-border bg-card p-4 font-mono text-sm whitespace-pre-wrap break-words"
      >
        <code>{text}</code>
      </pre>
      {truncated && (
        <div className="rounded-lg border border-border bg-card px-4 py-2.5 text-sm text-muted-foreground">
          Showing the first 1 MiB.{' '}
          <a
            href={file.downloadUrl ?? file.url}
            download={file.filename}
            className="text-foreground underline underline-offset-4"
          >
            Download full file
          </a>
        </div>
      )}
    </div>
  )
}

function ViewerError({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}) {
  return (
    <div className="flex flex-col items-start gap-3 p-4">
      <p role="alert" className="text-sm text-destructive">
        {message}
      </p>
      <Button
        variant="outline"
        size="sm"
        className="pointer-coarse:h-11 pointer-coarse:px-4"
        onClick={onRetry}
      >
        <span aria-hidden="true">↻</span> Retry
      </Button>
    </div>
  )
}

function MediaViewer({
  file,
  kind,
}: {
  file: FileViewerProps
  kind: 'audio' | 'video'
}) {
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  if (failed)
    return (
      <ViewerError
        message={`Could not load ${file.filename}`}
        onRetry={() => {
          setFailed(false)
          setAttempt((value) => value + 1)
        }}
      />
    )
  const Tag = kind
  return (
    <Tag
      key={attempt}
      className={cn(
        'block w-full max-h-[70vh]',
        kind === 'video' && 'rounded-lg bg-black',
      )}
      src={file.url}
      controls
      preload="metadata"
      onError={() => setFailed(true)}
    />
  )
}

function ImageViewer({ file }: { file: FileViewerProps }) {
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState(false)
  const [attempt, setAttempt] = useState(0)
  if (failed)
    return (
      <ViewerError
        message={`Could not load ${file.filename}`}
        onRetry={() => {
          setFailed(false)
          setAttempt((value) => value + 1)
        }}
      />
    )
  return (
    <>
      <button
        className="flex h-full w-full cursor-zoom-in items-center justify-center rounded-lg border-0 bg-muted p-4"
        onClick={() => setOpen(true)}
        aria-label={`Open ${file.filename}`}
      >
        <img
          key={attempt}
          src={file.url}
          alt={file.filename}
          onError={() => setFailed(true)}
          className="block max-h-[70vh] max-w-full rounded-md object-contain"
        />
      </button>
      {open && (
        <Lightbox
          open
          close={() => setOpen(false)}
          slides={[{ src: file.url, alt: file.filename }]}
          render={{ buttonPrev: () => null, buttonNext: () => null }}
        />
      )}
    </>
  )
}

export function FileViewer(file: FileViewerProps) {
  const kind = fileViewerKind(file.filename, file.mime)
  const href = file.downloadUrl ?? file.url
  if (kind === 'image') return <ImageViewer file={file} />
  if (kind === 'pdf') return <PdfDocument url={file.url} />
  if (kind === 'text') return <TextViewer file={file} />
  if (kind === 'video' || kind === 'audio')
    return <MediaViewer file={file} kind={kind} />
  return <DownloadCard file={file} href={href} />
}

export function FileViewerClose({ onClick }: { onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="absolute right-3 top-3 pointer-coarse:size-11"
      onClick={onClick}
      aria-label="Close"
    >
      <X size={18} />
    </Button>
  )
}
