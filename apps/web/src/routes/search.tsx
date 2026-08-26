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
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [retryKey, setRetryKey] = useState(0)
  const [activeResult, setActiveResult] = useState(0)
  const request = useRef<AbortController | null>(null)
  const resultsRef = useRef<HTMLDivElement>(null)

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
      setStatus('idle')
      return
    }
    setStatus('loading')
    const controller = new AbortController()
    request.current = controller
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/search?scope=${scope}&limit=50&q=${encodeURIComponent(q.trim())}`,
          { signal: controller.signal },
        )
        if (!response.ok) throw new Error('Search request failed')
        const next = (await response.json()) as SearchResultsData
        if (request.current === controller) {
          setResults(next)
          setStatus('success')
        }
      } catch (error) {
        if ((error as Error).name !== 'AbortError' && request.current === controller) {
          setResults(emptyResults)
          setStatus('error')
        }
      }
    }, 200)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [q, scope, retryKey])

  const retrySearch = () => {
    request.current?.abort()
    setRetryKey((value) => value + 1)
  }

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (event.key === 'Escape') {
      event.preventDefault()
      window.history.back()
      return
    }
    if (target.matches('input, textarea, [contenteditable="true"]')) return
    const items = Array.from(resultsRef.current?.querySelectorAll<HTMLAnchorElement>('.search-result') ?? [])
    if (!items.length) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 :
        Math.max(0, Math.min(items.length - 1, activeResult + (event.key === 'ArrowDown' ? 1 : -1)))
      setActiveResult(next)
      items[next]?.focus()
    } else if (event.key === 'Enter' && target.matches('.search-result')) {
      event.preventDefault()
      target.click()
    }
  }

  const updateSearch = (value: string, nextScope = scope) => {
    void navigate({
      to: '/search',
      search: { q: value, scope: nextScope },
      replace: true,
    })
  }
  return (
    <div className="search-page" onKeyDown={onSearchKeyDown}>
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
              tabIndex={scope === value ? 0 : -1}
              aria-selected={scope === value}
              className={scope === value ? 'active' : ''}
              onClick={() => updateSearch(input || q, value)}
              onKeyDown={(event) => {
                if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return
                event.preventDefault()
                const index = ['all', 'sessions', 'messages', 'runs'].indexOf(value)
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? 3 :
                  (index + (event.key === 'ArrowRight' ? 1 : -1) + 4) % 4
                const nextScope = ['all', 'sessions', 'messages', 'runs'][next] as SearchScope
                updateSearch(input || q, nextScope)
              }}
            >
              {value[0].toUpperCase() + value.slice(1)}
            </button>
          ),
        )}
      </div>
      {!q.trim() ? (
        <div className="search-results search-recent" ref={resultsRef}>
          <h2>Recent sessions</h2>
          {sessions.slice(0, 20).map((session) => (
            <a
              className="search-result"
              tabIndex={0}
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
        <div ref={resultsRef}>
          <SearchResults results={results} query={q} scope={scope} status={status === 'idle' ? 'loading' : status} onRetry={retrySearch} />
        </div>
      )}
    </div>
  )
}
