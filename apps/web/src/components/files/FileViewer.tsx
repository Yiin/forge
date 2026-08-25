import { Download, File as FileIcon, X } from 'lucide-react'
import { lazy, useEffect, useState } from 'react'
import { fileViewerKind, languageForFilename } from './fileViewerKind'
import './file-viewer.css'
import 'yet-another-react-lightbox/styles.css'

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
        return (
          <Document
            file={url}
            loading={<p>Loading PDF…</p>}
            onLoadSuccess={({ numPages }) => setPages(numPages)}
          >
            <div className="file-viewer-pdf-pages">
              {Array.from({ length: pages }, (_, index) => (
                <LazyPdfPage key={index} Page={Page} pageNumber={index + 1} />
              ))}
              {pages === 0 && <p>Loading pages…</p>}
            </div>
          </Document>
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
    <div ref={setElement} className="file-viewer-pdf-page">
      {visible ? (
        <Page
          pageNumber={pageNumber}
          width={Math.min(900, window.innerWidth - 32)}
          loading={null}
        />
      ) : (
        <span>Page {pageNumber}</span>
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
    <div className="file-viewer-download">
      <FileIcon aria-hidden="true" size={28} />
      <div>
        <strong>{file.filename}</strong>
        <span>
          {formatBytes(file.sizeBytes)}
          {file.sha256 ? ` · ${file.sha256}` : ''}
        </span>
      </div>
      <a
        href={href}
        download={file.filename}
        className="file-viewer-download-button"
      >
        <Download size={16} /> Download
      </a>
    </div>
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
  if (error) return <p role="alert">{error}</p>
  if (text === null) return <p>Loading file…</p>
  const truncated = file.sizeBytes > 1024 * 1024
  return (
    <>
      <pre
        className={`file-viewer-code language-${languageForFilename(file.filename)}`}
      >
        <code>{text}</code>
      </pre>
      {truncated && (
        <div className="file-viewer-download-bar">
          Showing the first 1 MiB.{' '}
          <a href={file.downloadUrl ?? file.url} download={file.filename}>
            Download full file
          </a>
        </div>
      )}
    </>
  )
}

export function FileViewer(file: FileViewerProps) {
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const kind = fileViewerKind(file.filename, file.mime)
  const href = file.downloadUrl ?? file.url
  if (kind === 'image')
    return (
      <>
        <button
          className="file-viewer-image-button"
          onClick={() => setLightboxOpen(true)}
          aria-label={`Open ${file.filename}`}
        >
          <img src={file.url} alt={file.filename} />
        </button>
        {lightboxOpen && (
          <Lightbox
            open
            close={() => setLightboxOpen(false)}
            slides={[{ src: file.url, alt: file.filename }]}
            render={{ buttonPrev: () => null, buttonNext: () => null }}
          />
        )}
      </>
    )
  if (kind === 'pdf') return <PdfDocument url={file.url} />
  if (kind === 'text') return <TextViewer file={file} />
  if (kind === 'video')
    return (
      <video
        className="file-viewer-media"
        src={file.url}
        controls
        preload="metadata"
      />
    )
  if (kind === 'audio')
    return (
      <audio
        className="file-viewer-media"
        src={file.url}
        controls
        preload="metadata"
      />
    )
  return <DownloadCard file={file} href={href} />
}

export function FileViewerClose({ onClick }: { onClick: () => void }) {
  return (
    <button className="file-viewer-close" onClick={onClick} aria-label="Close">
      <X size={18} />
    </button>
  )
}
