import { Link } from '@tanstack/react-router'
import { FileText, MessageSquare, Play, SearchX } from 'lucide-react'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import {
  messageHitUrl,
  parseSnippet,
  runHitUrl,
  sessionHitUrl,
} from './search-logic'

export type SearchResultsData = {
  sessions: Array<{ sessionId: string; title: string; snippet: string }>
  messages: Array<{
    sessionId: string
    seq: number
    itemId: string
    snippet: string
    sessionTitle: string
  }>
  runs: Array<{ runId: string; title: string; snippet: string; status: string }>
}

function Snippet({ value }: { value: string }) {
  return (
    <span className="block truncate text-sm text-muted-foreground">
      {parseSnippet(value).map((segment, index) =>
        segment.highlighted ? (
          <mark
            key={index}
            className="rounded-xs bg-primary/20 px-0.5 text-foreground"
          >
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </span>
  )
}

function ResultGroup({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section aria-labelledby={`search-${title}`} className="space-y-1">
      <h2
        id={`search-${title}`}
        className="px-2 text-xs font-medium tracking-wide text-muted-foreground uppercase"
      >
        {title}
      </h2>
      <div className="flex flex-col gap-0.5">{children}</div>
    </section>
  )
}

// The `search-result` class is a behavior hook: search.tsx drives keyboard
// navigation with querySelectorAll('.search-result').
const resultClass =
  'search-result flex items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none'

export function SearchResults({
  results,
  query,
  status = 'success',
  scope = 'all',
  onRetry,
}: {
  results: SearchResultsData
  query: string
  status?: 'loading' | 'success' | 'error'
  scope?: string
  onRetry?: () => void
}) {
  const hasResults =
    results.sessions.length + results.messages.length + results.runs.length > 0
  if (status === 'loading') {
    return (
      <p
        className="px-2 py-8 text-center text-sm text-muted-foreground"
        role="status"
      >
        Searching…
      </p>
    )
  }
  if (status === 'error') {
    return (
      <div
        className="flex flex-col items-center gap-2 px-2 py-8 text-center"
        role="alert"
      >
        <p className="text-sm text-destructive">Search is unavailable.</p>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </div>
    )
  }
  if (!query.trim()) {
    return (
      <p className="px-2 py-8 text-center text-sm text-muted-foreground">
        Recent sessions appear here.
      </p>
    )
  }
  if (!hasResults) {
    return (
      <div className="flex flex-col items-center gap-2 px-2 py-8 text-center text-sm text-muted-foreground">
        <SearchX className="size-5" aria-hidden="true" />
        <p>
          No {scope} results for “{query.trim()}”.
        </p>
      </div>
    )
  }
  const count =
    results.sessions.length + results.messages.length + results.runs.length
  return (
    <div className="space-y-5">
      <p className="px-2 text-xs text-muted-foreground" role="status">
        {count} {count === 1 ? 'result' : 'results'} · {scope}
      </p>
      {results.sessions.length > 0 && (
        <ResultGroup title="Sessions">
          {results.sessions.map((hit) => (
            <Link
              className={resultClass}
              key={hit.sessionId}
              to={sessionHitUrl(hit.sessionId) as never}
            >
              <FileText
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">
                <strong className="block truncate text-sm font-medium">
                  {hit.title || 'Untitled session'}
                </strong>
                <Snippet value={hit.snippet} />
              </span>
            </Link>
          ))}
        </ResultGroup>
      )}
      {results.messages.length > 0 && (
        <ResultGroup title="Messages">
          {results.messages.map((hit) => (
            <Link
              className={resultClass}
              key={`${hit.sessionId}-${hit.seq}-${hit.itemId}`}
              to={messageHitUrl(hit.sessionId, hit.seq) as never}
            >
              <MessageSquare
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">
                <strong className="block truncate text-sm font-medium">
                  {hit.sessionTitle || 'Session message'}
                </strong>
                <Snippet value={hit.snippet} />
              </span>
            </Link>
          ))}
        </ResultGroup>
      )}
      {results.runs.length > 0 && (
        <ResultGroup title="Runs">
          {results.runs.map((hit) => (
            <Link
              className={resultClass}
              key={hit.runId}
              to={runHitUrl(hit.runId) as never}
            >
              <Play
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">
                <strong className="block truncate text-sm font-medium">
                  {hit.title}
                </strong>
                <Snippet value={hit.snippet} />
              </span>
              <Badge variant="secondary" className="shrink-0 capitalize">
                {hit.status}
              </Badge>
            </Link>
          ))}
        </ResultGroup>
      )}
    </div>
  )
}
