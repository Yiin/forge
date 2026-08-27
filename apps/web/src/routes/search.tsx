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
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'

const emptyResults: SearchResultsData = { sessions: [], messages: [], runs: [] }

export function SearchRoute() {
  const { q = '', scope = 'all' } = useSearch({ from: '/search' })
  const navigate = useNavigate()
  const sessions = useSessionsStore((state) => state.sessions)
  const [input, setInput] = useState(q)
  const [results, setResults] = useState<SearchResultsData>(emptyResults)
  const [status, setStatus] = useState<
    'idle' | 'loading' | 'success' | 'error'
  >('idle')
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
        if (
          (error as Error).name !== 'AbortError' &&
          request.current === controller
        ) {
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
    const items = Array.from(
      resultsRef.current?.querySelectorAll<HTMLAnchorElement>(
        '.search-result',
      ) ?? [],
    )
    if (!items.length) return
    if (
      event.key === 'ArrowDown' ||
      event.key === 'ArrowUp' ||
      event.key === 'Home' ||
      event.key === 'End'
    ) {
      event.preventDefault()
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : Math.max(
                0,
                Math.min(
                  items.length - 1,
                  activeResult + (event.key === 'ArrowDown' ? 1 : -1),
                ),
              )
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
    <div className="flex flex-col gap-4 p-4" onKeyDown={onSearchKeyDown}>
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => window.history.back()}
          aria-label="Go back"
        >
          <ArrowLeft className="size-4" />
        </Button>
        <div className="relative flex-1">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            autoFocus
            type="search"
            enterKeyHint="search"
            value={input}
            placeholder="Search everywhere"
            aria-label="Search everywhere"
            className="h-10 rounded-lg pl-9"
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') updateSearch(input)
            }}
          />
        </div>
      </div>
      <Tabs
        value={scope}
        onValueChange={(value) =>
          updateSearch(input || q, value as SearchScope)
        }
      >
        <TabsList aria-label="Search scope">
          {(['all', 'sessions', 'messages', 'runs'] as SearchScope[]).map(
            (value) => (
              <TabsTrigger key={value} value={value}>
                {value[0].toUpperCase() + value.slice(1)}
              </TabsTrigger>
            ),
          )}
        </TabsList>
      </Tabs>
      {!q.trim() ? (
        <div className="flex flex-col gap-1" ref={resultsRef}>
          <h2 className="px-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Recent sessions
          </h2>
          {sessions.slice(0, 20).map((session) => (
            <a
              className="search-result flex items-center gap-3 rounded-lg p-3 hover:bg-accent/50"
              tabIndex={0}
              href={`/s/${encodeURIComponent(session.id)}`}
              key={session.id}
            >
              <SearchIcon
                className="size-[18px] shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="flex min-w-0 flex-col">
                <strong className="truncate font-medium">
                  {session.title || 'Untitled session'}
                </strong>
                <span className="truncate text-sm text-muted-foreground">
                  {session.snippet || 'No messages yet'}
                </span>
              </span>
            </a>
          ))}
          {sessions.length === 0 && (
            <p className="px-1 text-sm text-muted-foreground">
              No recent sessions.
            </p>
          )}
        </div>
      ) : (
        <div ref={resultsRef}>
          <SearchResults
            results={results}
            query={q}
            scope={scope}
            status={status === 'idle' ? 'loading' : status}
            onRetry={retrySearch}
          />
        </div>
      )}
    </div>
  )
}
