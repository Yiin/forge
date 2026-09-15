import { useEffect, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  MessageSquare,
  RefreshCw,
} from 'lucide-react'
import type { GitDiff, GitDiffFile } from '@forge/protocol/git'
import { api } from '../../lib/api'
import { Button } from '../ui/button'
import { cn } from '../../lib/utils'

export type ReviewComment = {
  path: string
  side: 'old' | 'new'
  line: number
  text: string
}

export function GitReviewSurface({
  projectId,
  sessionId,
  cwd,
  commit,
  onComment,
}: {
  projectId: string
  sessionId: string
  cwd: string
  commit?: string
  onComment: (comment: ReviewComment) => void
}) {
  const [scope, setScope] = useState<
    'working' | 'branch' | 'latest-turn' | 'commit'
  >('working')
  const [baseRef, setBaseRef] = useState<string>()
  const [diff, setDiff] = useState<GitDiff>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const load = () => {
    setLoading(true)
    void api
      .gitDiff(projectId, { cwd, sessionId, scope, baseRef, commit })
      .then((value) => {
        setDiff(value as GitDiff)
        setError(undefined)
      })
      .catch((cause) =>
        setError(
          cause instanceof Error ? cause.message : 'Could not load diff',
        ),
      )
      .finally(() => setLoading(false))
  }
  useEffect(() => {
    void api
      .gitStatus(projectId, cwd)
      .then((value) => {
        const status = value as {
          defaultBranch?: string | null
          branch?: string | null
        }
        setBaseRef(status.defaultBranch ?? status.branch ?? undefined)
      })
      .catch(() => undefined)
  }, [projectId, cwd])
  useEffect(() => {
    if (commit) setScope('commit')
  }, [commit])
  useEffect(load, [projectId, sessionId, cwd, scope, baseRef, commit])
  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="Git changes">
      <div className="flex min-h-[38px] flex-wrap items-center gap-1 border-b border-border px-2 py-1 pointer-coarse:min-h-11">
        {(['working', 'branch', 'latest-turn'] as const).map((value) => (
          <Button
            key={value}
            size="sm"
            variant={scope === value ? 'secondary' : 'ghost'}
            className="pointer-coarse:min-h-11"
            onClick={() => setScope(value)}
          >
            {value === 'latest-turn'
              ? 'Latest turn'
              : value === 'branch'
                ? 'Branch'
                : 'Working tree'}
          </Button>
        ))}
        <Button
          className="ml-auto pointer-coarse:size-11"
          size="icon-sm"
          variant="ghost"
          onClick={load}
          aria-label="Refresh changes"
        >
          <RefreshCw size={14} />
        </Button>
      </div>
      {loading && (
        <div className="p-4 text-muted-foreground" role="status">
          Loading changes…
        </div>
      )}
      {error && (
        <div className="p-4 text-destructive" role="alert">
          {error}
        </div>
      )}
      {!loading && !error && diff?.unavailable && (
        <div className="p-4 text-muted-foreground" role="status">
          Latest-turn history is unavailable.
        </div>
      )}
      {!loading &&
        !error &&
        diff &&
        !diff.unavailable &&
        diff.files.length === 0 && (
          <div className="p-4 text-muted-foreground" role="status">
            Working tree is clean.
          </div>
        )}
      {diff && !diff.unavailable && (
        <div className="min-h-0 flex-1 overflow-auto p-2">
          <div className="mb-2 text-xs text-muted-foreground">
            {diff.files.length} files ·{' '}
            <span className="text-success-foreground">+{diff.additions}</span>{' '}
            <span className="text-destructive">−{diff.deletions}</span>
          </div>
          {diff.files.map((file) => (
            <DiffFileView
              key={`${file.oldPath}:${file.newPath}`}
              file={file}
              collapsed={collapsed[file.newPath ?? file.oldPath ?? '']}
              onToggle={() =>
                setCollapsed((items) => ({
                  ...items,
                  [file.newPath ?? file.oldPath ?? '']:
                    !items[file.newPath ?? file.oldPath ?? ''],
                }))
              }
              onComment={onComment}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function DiffFileView({
  file,
  collapsed,
  onToggle,
  onComment,
}: {
  file: GitDiffFile
  collapsed: boolean
  onToggle: () => void
  onComment: (comment: ReviewComment) => void
}) {
  const path = file.newPath ?? file.oldPath ?? 'unknown'
  return (
    <article className="mb-3 overflow-hidden rounded-md border border-border">
      <button
        className="flex h-[38px] w-full items-center gap-2 bg-muted/40 px-2 text-left text-xs focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:h-11"
        onClick={onToggle}
        aria-expanded={!collapsed}
      >
        {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        <code className="min-w-0 flex-1 truncate">
          {file.status === 'renamed'
            ? `${file.oldPath} → ${file.newPath}`
            : path}
        </code>
        <span className="text-success-foreground">+{file.additions}</span>
        <span className="text-destructive">−{file.deletions}</span>
      </button>
      {!collapsed && (
        <div className="overflow-x-auto font-mono text-xs leading-[21px]">
          {file.status === 'binary' ? (
            <p className="p-3 text-muted-foreground">Binary file changed.</p>
          ) : (
            file.hunks.map((hunk, index) => (
              <div key={index}>
                <div className="flex h-7 items-center bg-muted/40 px-2 text-muted-foreground">
                  @@ −{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},
                  {hunk.newCount} @@
                </div>
                {hunk.lines.map((line, lineIndex) => {
                  const number = line.newLine ?? line.oldLine
                  const side = line.newLine === null ? 'old' : 'new'
                  return (
                    <div
                      key={lineIndex}
                      className={cn(
                        'group flex min-w-max border-l-[3px] border-transparent',
                        line.type === 'addition' &&
                          'border-l-success bg-success/10',
                        line.type === 'deletion' &&
                          'border-l-destructive bg-destructive/10',
                      )}
                    >
                      <span className="w-9 shrink-0 select-none px-2 text-right text-muted-foreground">
                        {number ?? ''}
                      </span>
                      <span className="w-7 shrink-0 select-none text-center">
                        {line.type === 'addition'
                          ? '+'
                          : line.type === 'deletion'
                            ? '−'
                            : ' '}
                      </span>
                      <span className="whitespace-pre px-1">
                        {line.text || ' '}
                      </span>
                      {number && line.type !== 'context' && (
                        <button
                          className="ml-2 inline-flex h-6 shrink-0 items-center rounded px-1 text-muted-foreground opacity-0 hover:bg-accent focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring group-hover:opacity-100 pointer-coarse:size-11 pointer-coarse:justify-center pointer-coarse:opacity-100"
                          onClick={() => {
                            const text = window.prompt(
                              `Comment on ${path}:${number}`,
                            )
                            if (text?.trim())
                              onComment({
                                path:
                                  line.type === 'deletion'
                                    ? (file.oldPath ?? path)
                                    : (file.newPath ?? path),
                                side,
                                line: number,
                                text: text.trim(),
                              })
                          }}
                          aria-label={`Comment on line ${number}`}
                        >
                          <MessageSquare size={12} />
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            ))
          )}
        </div>
      )}
    </article>
  )
}
