import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import type { GitHistoryPage, GitRefsPage } from '@forge/protocol/git'
import { api } from '../../lib/api'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { historyGraph } from './history-graph'

export function GitHistorySurface({
  projectId,
  sessionId,
  cwd,
  onCommit,
}: {
  projectId: string
  sessionId: string
  cwd: string
  onCommit: (sha: string) => void
}) {
  const [page, setPage] = useState<GitHistoryPage>(),
    [error, setError] = useState<string>(),
    [loading, setLoading] = useState(false)
  const [refs, setRefs] = useState<GitRefsPage['refs']>([]),
    [ref, setRef] = useState('HEAD'),
    [draft, setDraft] = useState(''),
    [query, setQuery] = useState('')
  const epoch = useRef(0),
    refsEpoch = useRef(0)
  const [refsError, setRefsError] = useState<string>()
  const load = useCallback(
    (cursor?: string) => {
      const request = ++epoch.current
      setLoading(true)
      setError(undefined)
      if (!cursor) setPage(undefined)
      void api
        .gitHistory(projectId, {
          cwd,
          sessionId,
          cursor,
          limit: 40,
          ref,
          query,
        })
        .then((value) => {
          if (request !== epoch.current) return
          const next = value as GitHistoryPage
          setPage((current) =>
            cursor && current
              ? {
                  ...next,
                  commits: [
                    ...current.commits,
                    ...next.commits.filter(
                      (commit) =>
                        !current.commits.some((old) => old.sha === commit.sha),
                    ),
                  ],
                }
              : next,
          )
        })
        .catch((cause) => {
          if (request === epoch.current)
            setError(
              cause instanceof Error ? cause.message : 'Could not load history',
            )
        })
        .finally(() => {
          if (request === epoch.current) setLoading(false)
        })
    },
    [projectId, sessionId, cwd, ref, query],
  )
  useEffect(() => {
    load()
    return () => {
      epoch.current++
    }
  }, [load])
  const loadRefs = useCallback(() => {
    const request = ++refsEpoch.current
    setRefsError(undefined)
    void api
      .gitBranches(projectId, { cwd, limit: 100 })
      .then((value) => {
        if (request === refsEpoch.current) setRefs((value as GitRefsPage).refs)
      })
      .catch((cause) => {
        if (request === refsEpoch.current)
          setRefsError(
            cause instanceof Error
              ? cause.message
              : 'Could not load branch suggestions',
          )
      })
  }, [projectId, cwd])
  useEffect(() => {
    setRefs([])
    loadRefs()
    return () => {
      refsEpoch.current++
    }
  }, [loadRefs])
  const graph = useMemo(() => historyGraph(page?.commits ?? []), [page])
  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="Git history">
      <form
        className="flex min-h-[38px] shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-1"
        onSubmit={(event) => {
          event.preventDefault()
          if (query === draft.trim()) load()
          else setQuery(draft.trim())
        }}
      >
        <label className="sr-only" htmlFor={`history-ref-${sessionId}`}>
          History branch
        </label>
        <Input
          list={`history-refs-${sessionId}`}
          id={`history-ref-${sessionId}`}
          aria-label="History branch"
          value={ref}
          onChange={(event) => setRef(event.target.value)}
          className="max-w-40 rounded border border-input bg-background text-xs pointer-coarse:min-h-11"
        />
        <datalist id={`history-refs-${sessionId}`}>
          <option value="HEAD" />
          {refs.map((item) => (
            <option key={item.name} value={item.name} />
          ))}
        </datalist>
        <Input
          aria-label="Search commit messages"
          placeholder="Search commit messages"
          value={draft}
          maxLength={256}
          onChange={(event) => setDraft(event.target.value)}
          className="min-w-24 flex-1 rounded border border-input bg-background px-2 py-1 text-xs pointer-coarse:min-h-11"
        />
        <Button type="submit" size="sm">
          Search
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Refresh history"
          onClick={() => {
            load()
            loadRefs()
          }}
          disabled={loading}
        >
          <RefreshCw size={14} />
        </Button>
      </form>
      {refsError && (
        <p role="alert" className="p-3 text-xs text-destructive">
          {refsError}
        </p>
      )}
      {error && (
        <p className="p-3 text-destructive" role="alert">
          {error}
        </p>
      )}
      {loading && !page && (
        <p className="p-3 text-muted-foreground" role="status">
          Loading history…
        </p>
      )}
      {!loading && !error && page && !page.commits.length && (
        <p className="p-3 text-muted-foreground" role="status">
          No matching commits.
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {page?.commits.map((commit, index) => {
          const row = graph[index]!
          return (
            <div
              key={commit.sha}
              className="flex h-9 items-center gap-2 border-b border-border px-3 pointer-coarse:h-11"
            >
              <span
                className="relative self-stretch shrink-0"
                style={{ width: Math.max(36, row.width * 12 + 12) }}
              >
                <svg
                  aria-hidden="true"
                  className="absolute inset-0 h-full w-full"
                >
                  {row.incoming && (
                    <line
                      x1={row.column * 12 + 6}
                      x2={row.column * 12 + 6}
                      y1="0"
                      y2="50%"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      className="text-muted-foreground"
                    />
                  )}
                  {row.edges.map((edge, i) => (
                    <line
                      key={i}
                      x1={edge.from * 12 + 6}
                      y1={edge.node ? '50%' : '0'}
                      x2={edge.to * 12 + 6}
                      y2="100%"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      className="text-muted-foreground"
                    />
                  ))}
                  <circle
                    cx={row.column * 12 + 6}
                    cy="50%"
                    r={3}
                    className="fill-primary"
                  />
                </svg>
              </span>
              <button
                className="h-full min-w-0 flex-1 py-0 text-left focus-visible:outline-2 focus-visible:outline-ring"
                onClick={() => onCommit(commit.sha)}
              >
                <span className="block truncate text-xs leading-[14px] font-medium">
                  {commit.subject}
                </span>
                <span className="block truncate text-[11px] leading-[14px] text-muted-foreground">
                  {commit.sha.slice(0, 7)} · {commit.author} ·{' '}
                  {new Date(commit.date).toLocaleDateString()}
                  {commit.refs.length ? ` · ${commit.refs.join(', ')}` : ''}
                </span>
              </button>
              <span className="flex h-full max-w-[30%] gap-1 overflow-x-auto">
                {commit.parents.map((parent) => (
                  <button
                    key={parent}
                    aria-label={`Open parent ${parent}`}
                    className="h-full shrink-0 text-[10px] text-muted-foreground underline focus-visible:outline-2 focus-visible:outline-ring"
                    onClick={() => onCommit(parent)}
                  >
                    {parent.slice(0, 7)}
                  </button>
                ))}
              </span>
            </div>
          )
        })}
        {page?.nextCursor && (
          <Button
            variant="ghost"
            className="m-2 w-[calc(100%-1rem)]"
            onClick={() => load(page.nextCursor!)}
            disabled={loading || page.commits.length >= 2000}
          >
            {loading && <Loader2 className="animate-spin" size={14} />}Load more
          </Button>
        )}
        {page && page.commits.length >= 2000 && (
          <p role="status" className="p-3 text-xs text-muted-foreground">
            Showing 2,000 commits. Narrow the search to continue.
          </p>
        )}
      </div>
    </section>
  )
}
