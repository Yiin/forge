import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ArrowRight, ExternalLink, RotateCw } from 'lucide-react'
import { api, type PreviewTarget } from '@/lib/api'
import { Button } from '../ui/button'

export function normalizeBrowserAddress(value: string) {
  const raw = value.trim()
  if (!raw) throw new Error('Enter a preview address.')
  if (/^[a-z][a-z\d+.-]*:/i.test(raw) && !/^https?:\/\//i.test(raw))
    throw new Error('Only HTTP and HTTPS preview addresses are allowed.')
  const url = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`)
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('Only HTTP and HTTPS preview addresses are allowed.')
  if (url.username || url.password)
    throw new Error('Preview addresses cannot contain credentials.')
  return url
}

function previewPage(target: PreviewTarget, path: string) {
  if (!target.publicUrl) return null
  return new URL(normalizePreviewPath(path), target.publicUrl).toString()
}

export function normalizePreviewPath(value: string) {
  const raw = value.trim() || '/'
  if (!raw.startsWith('/') || raw.startsWith('//'))
    throw new Error('Preview paths must stay within the registered target.')
  const url = new URL(raw, 'http://preview.invalid')
  return `${url.pathname}${url.search}${url.hash}`
}

export function BrowserPreview({ sessionId }: { sessionId: string }) {
  const [address, setAddress] = useState('http://127.0.0.1:3000')
  const [target, setTarget] = useState<PreviewTarget | null>(null)
  const [path, setPath] = useState('/')
  const [draft, setDraft] = useState('/')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [reload, setReload] = useState(0)

  const src = useMemo(
    () => (target ? previewPage(target, path) : null),
    [target, path, reload],
  )

  useEffect(() => {
    let cancelled = false
    void api
      .listPreviews(sessionId)
      .then(({ targets }) => {
        const existing = targets.find((item) => item.status !== 'removed')
        if (!cancelled && existing) {
          setTarget(existing)
          setAddress(existing.origin)
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [sessionId])

  useEffect(() => {
    if (!loading) return
    const timer = window.setTimeout(() => {
      setLoading(false)
      setMessage(
        'The preview is taking too long to load. Retry or open it externally.',
      )
    }, 8000)
    return () => window.clearTimeout(timer)
  }, [loading])

  const navigate = (nextPath: string) => {
    if (!target) return
    let next: string
    try {
      next = normalizePreviewPath(nextPath)
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'Invalid preview path.',
      )
      return
    }
    setHistory((items) => [...items.slice(0, historyIndex + 1), next])
    setHistoryIndex((index) => index + 1)
    setPath(next)
    setDraft(next)
    setLoading(true)
    setMessage(null)
  }

  const connect = async () => {
    try {
      const origin = normalizeBrowserAddress(address).origin
      setLoading(true)
      setMessage(null)
      const next = await api.registerPreview(sessionId, origin)
      setTarget(next)
      setHistory(['/'])
      setHistoryIndex(0)
      setPath('/')
      setDraft('/')
      if (!next.publicUrl) setMessage(next.reason ?? 'Preview is unavailable.')
      if (next.publicUrl) {
        const reachability = await api.previewReachability(next.id, sessionId)
        if (!reachability.reachable)
          setMessage(
            'The preview server is offline. Check the address and retry.',
          )
      }
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'Preview could not start.',
      )
    } finally {
      setLoading(false)
    }
  }

  const goBack = () => {
    if (historyIndex <= 0) return
    const nextIndex = historyIndex - 1
    setHistoryIndex(nextIndex)
    setPath(history[nextIndex]!)
    setDraft(history[nextIndex]!)
    setLoading(true)
  }
  const goForward = () => {
    if (historyIndex + 1 >= history.length) return
    const nextIndex = historyIndex + 1
    setHistoryIndex(nextIndex)
    setPath(history[nextIndex]!)
    setDraft(history[nextIndex]!)
    setLoading(true)
  }

  return (
    <div className="flex h-full min-h-0 flex-col" aria-label="Browser preview">
      <form
        className="flex gap-1 border-b border-border p-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (target) navigate(draft)
          else void connect()
        }}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="pointer-coarse:size-11"
          onClick={goBack}
          disabled={historyIndex <= 0}
          aria-label="Back"
        >
          <ArrowLeft size={15} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="pointer-coarse:size-11"
          onClick={goForward}
          disabled={historyIndex + 1 >= history.length}
          aria-label="Forward"
        >
          <ArrowRight size={15} />
        </Button>
        <input
          className="min-w-0 flex-1 rounded border border-input bg-background px-2 text-sm"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          aria-label="Preview path"
          placeholder="/"
        />
        <Button
          type="submit"
          size="sm"
          className="pointer-coarse:min-h-11"
          disabled={loading}
        >
          Open
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="pointer-coarse:size-11"
          onClick={() => setReload((value) => value + 1)}
          disabled={!src}
          aria-label="Reload"
        >
          <RotateCw size={15} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="pointer-coarse:size-11"
          onClick={() =>
            src && window.open(src, '_blank', 'noopener,noreferrer')
          }
          disabled={!src}
          aria-label="Open externally"
        >
          <ExternalLink size={15} />
        </Button>
      </form>
      <div className="flex gap-1 border-b border-border px-2 py-1">
        <input
          className="min-w-0 flex-1 rounded border border-input bg-background px-2 text-sm"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          aria-label="Preview server address"
          placeholder="http://127.0.0.1:3000"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="pointer-coarse:min-h-11"
          onClick={() => void connect()}
          disabled={loading}
        >
          Connect
        </Button>
      </div>
      {message && (
        <div
          className="flex items-center justify-between gap-2 border-b border-border p-3 text-sm"
          role="alert"
        >
          <span>{message}</span>
          <Button size="sm" variant="outline" onClick={() => void connect()}>
            Retry
          </Button>
        </div>
      )}
      {!src ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
          Connect to a local preview server. The embedded page runs on a
          separate origin.
        </div>
      ) : (
        <iframe
          key={`${src}:${reload}`}
          src={src}
          title="Workspace browser preview"
          className="min-h-0 flex-1 border-0"
          sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
          onLoad={() => setLoading(false)}
          onError={() =>
            setMessage(
              'The preview server is offline or this page cannot be embedded. Open it externally to continue.',
            )
          }
        />
      )}
      {src && (
        <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
          Some pages block embedding. Forge cannot observe arbitrary
          cross-origin navigation. External open is available.
        </p>
      )}
    </div>
  )
}
