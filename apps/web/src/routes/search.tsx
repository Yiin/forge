import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Search as SearchIcon } from 'lucide-react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import {
  SearchResults,
  type SearchResultsData,
} from '../components/search/SearchResults'
import { useSessionsStore } from '../stores/sessions'
import {
  SEARCH_ROUTE_DEBOUNCE_MS,
  type SearchScope,
} from '../components/search/search-logic'

const emptyResults: SearchResultsData = { sessions: [], messages: [], runs: [] }

export function SearchRoute() {
  const { q = '', scope = 'all' } = useSearch({ from: '/search' })
  const navigate = useNavigate()
  const sessions = useSessionsStore((state) => state.sessions)
  const [input, setInput] = useState(q)
  const [results, setResults] = useState<SearchResultsData>(emptyResults)
  const request = useRef<AbortController | null>(null)

  useEffect(() => setInput(q), [q])
  useEffect(() => {
    if (input === q) return
    const timer = window.setTimeout(
      () => updateSearch(input),
      SEARCH_ROUTE_DEBOUNCE_MS,
    )
    return () => window.clearTimeout(timer)
  }, [input, q])
  useEffect(() => {
    request.current?.abort()
    if (!q.trim()) {
      setResults(emptyResults)
      return
    }
    const controller = new AbortController()
    request.current = controller
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/search?scope=${scope}&limit=50&q=${encodeURIComponent(q.trim())}`,
          { signal: controller.signal },
        )
        if (response.ok)
          setResults((await response.json()) as SearchResultsData)
      } catch (error) {
        if ((error as Error).name !== 'AbortError') setResults(emptyResults)
      }
    }, 200)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [q, scope])

  const updateSearch = (value: string, nextScope = scope) => {
    void navigate({
      to: '/search',
      search: { q: value, scope: nextScope },
      replace: true,
    })
  }
  return (
    <div className="search-page">
      <div className="search-header">
        <button
          className="search-back"
          onClick={() => window.history.back()}
          aria-label="Go back"
        >
          <ArrowLeft size={19} />
        </button>
        <div className="search-input-wrap">
          <SearchIcon size={18} aria-hidden="true" />
          <input
            autoFocus
            type="search"
            enterKeyHint="search"
            value={input}
            placeholder="Search everywhere"
            aria-label="Search everywhere"
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') updateSearch(input)
            }}
          />
        </div>
      </div>
      <div className="search-scopes" role="tablist" aria-label="Search scope">
        {(['all', 'sessions', 'messages', 'runs'] as SearchScope[]).map(
          (value) => (
            <button
              key={value}
              role="tab"
              aria-selected={scope === value}
              className={scope === value ? 'active' : ''}
              onClick={() => updateSearch(input || q, value)}
            >
              {value[0].toUpperCase() + value.slice(1)}
            </button>
          ),
        )}
      </div>
      {!q.trim() ? (
        <div className="search-results search-recent">
          <h2>Recent sessions</h2>
          {sessions.slice(0, 20).map((session) => (
            <a
              className="search-result"
              href={`/s/${encodeURIComponent(session.id)}`}
              key={session.id}
            >
              <SearchIcon size={18} aria-hidden="true" />
              <span className="search-result-copy">
                <strong>{session.title || 'Untitled session'}</strong>
                <span>{session.snippet || 'No messages yet'}</span>
              </span>
            </a>
          ))}
          {sessions.length === 0 && (
            <p className="search-empty">No recent sessions.</p>
          )}
        </div>
      ) : (
        <SearchResults results={results} query={q} />
      )}
    </div>
  )
}
