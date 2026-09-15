import { useEffect, useState } from 'react'
import { GitCommit, Loader2 } from 'lucide-react'
import type { GitHistoryPage } from '@forge/protocol/git'
import { api } from '../../lib/api'
import { Button } from '../ui/button'

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
  const [page, setPage] = useState<GitHistoryPage>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const load = (cursor?: string) => {
    setLoading(true)
    void api
      .gitHistory(projectId, { cwd, sessionId, cursor, limit: 40 })
      .then((value) => {
        const next = value as GitHistoryPage
        setPage((current) =>
          cursor && current
            ? { ...next, commits: [...current.commits, ...next.commits] }
            : next,
        )
        setError(undefined)
      })
      .catch((cause) =>
        setError(
          cause instanceof Error ? cause.message : 'Could not load history',
        ),
      )
      .finally(() => setLoading(false))
  }
  useEffect(() => load(), [projectId, sessionId, cwd])
  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="Git history">
      <div className="flex h-[38px] shrink-0 items-center border-b border-border px-3 text-xs text-muted-foreground">
        Commit history
      </div>
      {error && (
        <p className="p-3 text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {page?.commits.map((commit) => (
          <button
            key={commit.sha}
            className="flex h-9 w-full items-center gap-3 border-b border-border px-3 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:h-11"
            onClick={() => onCommit(commit.sha)}
          >
            <GitCommit size={14} className="shrink-0" />
            <span className="flex min-w-0 flex-1 items-center gap-3">
              <span className="min-w-0 flex-1 truncate text-xs font-medium">
                {commit.subject}
              </span>
              <span className="max-w-[45%] truncate text-[11px] text-muted-foreground">
                {commit.sha.slice(0, 7)} · {commit.author} ·{' '}
                {new Date(commit.date).toLocaleDateString()}
              </span>
            </span>
          </button>
        ))}
        {page?.nextCursor && (
          <Button
            variant="ghost"
            className="m-2 w-[calc(100%-1rem)]"
            onClick={() => page.nextCursor && load(page.nextCursor)}
            disabled={loading}
          >
            {loading && <Loader2 className="animate-spin" size={14} />} Load
            more
          </Button>
        )}
      </div>
    </section>
  )
}
