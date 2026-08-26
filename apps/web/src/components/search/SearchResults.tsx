import { Link } from '@tanstack/react-router'
import { FileText, MessageSquare, Play } from 'lucide-react'
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
    <span className="search-snippet">
      {parseSnippet(value).map((segment, index) =>
        segment.highlighted ? (
          <mark key={index}>{segment.text}</mark>
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
    <section className="search-group" aria-labelledby={`search-${title}`}>
      <h2 id={`search-${title}`}>{title}</h2>
      <div className="search-group-list">{children}</div>
    </section>
  )
}

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
    return <p className="search-empty" role="status">Searching…</p>
  }
  if (status === 'error') {
    return (
      <div className="search-empty search-error" role="alert">
        <p>Search is unavailable.</p>
        <button type="button" onClick={onRetry}>Try again</button>
      </div>
    )
  }
  if (!query.trim()) {
    return <p className="search-empty">Recent sessions appear here.</p>
  }
  if (!hasResults) {
    return <p className="search-empty">No {scope} results for “{query.trim()}”.</p>
  }
  const count = results.sessions.length + results.messages.length + results.runs.length
  return (
    <div className="search-results">
      <p className="search-result-count" role="status">{count} {count === 1 ? 'result' : 'results'} · {scope}</p>
      {results.sessions.length > 0 && (
        <ResultGroup title="Sessions">
          {results.sessions.map((hit) => (
            <Link
              className="search-result"
              key={hit.sessionId}
              to={sessionHitUrl(hit.sessionId) as never}
            >
              <FileText size={18} aria-hidden="true" />
              <span className="search-result-copy">
                <strong>{hit.title || 'Untitled session'}</strong>
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
              className="search-result"
              key={`${hit.sessionId}-${hit.seq}-${hit.itemId}`}
              to={messageHitUrl(hit.sessionId, hit.seq) as never}
            >
              <MessageSquare size={18} aria-hidden="true" />
              <span className="search-result-copy">
                <strong>{hit.sessionTitle || 'Session message'}</strong>
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
              className="search-result"
              key={hit.runId}
              to={runHitUrl(hit.runId) as never}
            >
              <Play size={18} aria-hidden="true" />
              <span className="search-result-copy">
                <strong>{hit.title}</strong>
                <Snippet value={hit.snippet} />
              </span>
              <span className="search-status">{hit.status}</span>
            </Link>
          ))}
        </ResultGroup>
      )}
    </div>
  )
}
