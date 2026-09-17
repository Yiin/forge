import { useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  MessageSquare,
  RefreshCw,
} from 'lucide-react'
import {
  gitDiffSchema,
  type GitDiff,
  type GitDiffFile,
  type GitRefsPage,
} from '@forge/protocol/git'
import { resolvedWorkspaceSchema } from '@forge/protocol/workspace'
import { api } from '../../lib/api'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { cn } from '../../lib/utils'
import { splitDiffLines } from './diff-lines'
import type { ReviewNote } from '@forge/protocol/review'
import {
  captureGitReviewNote,
  type ReviewWorkspace,
  type ReviewRevisionListener,
} from '../../lib/review-notes'

const responseSchema = gitDiffSchema.extend({
  workspace: resolvedWorkspaceSchema.pick({
    workspaceId: true,
    workspaceRevision: true,
  }),
})

export function GitReviewSurface({
  projectId,
  sessionId,
  cwd,
  commit,
  onComment,
  workspace,
  onRevision,
  reanchorNote,
}: {
  projectId: string
  sessionId: string
  cwd: string
  commit?: string
  onComment: (comment: ReviewNote) => void
  workspace: ReviewWorkspace
  onRevision?: ReviewRevisionListener
  reanchorNote?: ReviewNote
}) {
  const [scope, setScope] = useState<
    'working' | 'branch' | 'latest-turn' | 'commit'
  >('working')
  const [baseRef, setBaseRef] = useState<string>()
  const [refs, setRefs] = useState<GitRefsPage['refs']>([])
  const [split, setSplit] = useState(false),
    [wrap, setWrap] = useState(false)
  const requestEpoch = useRef(0)
  const baseEdited = useRef(false)
  const effectiveScope = commit ? 'commit' : scope

  const targetKey = JSON.stringify([
    projectId,
    sessionId,
    cwd,
    workspace.workspaceId,
    workspace.workspaceRevision,
  ])
  const currentTarget = useRef(targetKey)
  currentTarget.current = targetKey
  const [loaded, setLoaded] = useState<{
    diff: GitDiff
    workspace: ReviewWorkspace
    targetKey: string
  }>()
  const diff = loaded?.targetKey === targetKey ? loaded.diff : undefined
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const revisionListener = useRef(onRevision)
  revisionListener.current = onRevision
  const load = () => {
    const epoch = ++requestEpoch.current
    const capturedWorkspace = {
      workspaceId: workspace.workspaceId,
      workspaceRevision: workspace.workspaceRevision,
    }
    const capturedListener = revisionListener.current
    setLoading(true)
    setError(undefined)
    void api
      .gitDiff(projectId, {
        cwd,
        sessionId,
        scope: effectiveScope,
        baseRef,
        commit,
      })
      .then((value) => {
        if (
          epoch !== requestEpoch.current ||
          currentTarget.current !== targetKey
        )
          return
        const next = responseSchema.parse(value)
        if (
          next.workspace.workspaceId !== capturedWorkspace.workspaceId ||
          next.workspace.workspaceRevision !==
            capturedWorkspace.workspaceRevision
        )
          throw new Error(
            'Workspace changed. Refresh the workspace before reviewing this diff.',
          )
        setLoaded({ diff: next, workspace: next.workspace, targetKey })
        capturedListener?.(next.workspace, {
          kind: 'git',
          scope: next.scope,
          revision: next.revision,
        })
        setError(undefined)
      })
      .catch(
        (cause) =>
          epoch === requestEpoch.current &&
          setError(
            cause instanceof Error ? cause.message : 'Could not load diff',
          ),
      )
      .finally(() => {
        if (epoch === requestEpoch.current) setLoading(false)
      })
  }
  useEffect(() => {
    let active = true
    setBaseRef(undefined)
    baseEdited.current = false
    void api
      .gitStatus(projectId, cwd, sessionId)
      .then((value) => {
        const status = value as {
          defaultBranch?: string | null
          branch?: string | null
        }
        if (active && !baseEdited.current)
          setBaseRef(status.defaultBranch ?? status.branch ?? undefined)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [
    projectId,
    cwd,
    sessionId,
    workspace.workspaceId,
    workspace.workspaceRevision,
  ])
  useEffect(() => {
    if (commit) setScope('commit')
  }, [commit])
  useEffect(() => {
    load()
    return () => {
      requestEpoch.current++
    }
  }, [
    projectId,
    sessionId,
    cwd,
    scope,
    baseRef,
    commit,
    workspace.workspaceId,
    workspace.workspaceRevision,
  ])
  useEffect(() => {
    let active = true
    void api
      .gitBranches(projectId, { cwd, sessionId, limit: 100 })
      .then((value) => {
        if (active) setRefs((value as GitRefsPage).refs)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [
    projectId,
    cwd,
    sessionId,
    workspace.workspaceId,
    workspace.workspaceRevision,
  ])
  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="Git changes">
      <div className="flex min-h-[38px] flex-wrap items-center gap-1 border-b border-border px-2 py-1 pointer-coarse:min-h-11">
        {(!commit ? (['working', 'branch', 'latest-turn'] as const) : []).map(
          (value) => (
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
          ),
        )}
        {effectiveScope === 'branch' && (
          <>
            <label className="text-xs">
              Base{' '}
              <Input
                aria-label="Diff base branch"
                list={`diff-refs-${sessionId}`}
                value={baseRef ?? ''}
                onChange={(event) => {
                  baseEdited.current = true
                  setBaseRef(event.target.value)
                }}
                className="max-w-36 rounded border border-input bg-background px-1 py-1"
              />
            </label>
            <datalist id={`diff-refs-${sessionId}`}>
              {refs.map((ref) => (
                <option key={ref.name} value={ref.name} />
              ))}
            </datalist>
          </>
        )}
        {commit && <span className="text-xs">Commit {commit.slice(0, 7)}</span>}
        <Button
          size="sm"
          variant={split ? 'secondary' : 'ghost'}
          aria-pressed={split}
          onClick={() => setSplit((value) => !value)}
        >
          Split
        </Button>
        <Button
          size="sm"
          variant={wrap ? 'secondary' : 'ghost'}
          aria-pressed={wrap}
          onClick={() => setWrap((value) => !value)}
        >
          Wrap
        </Button>
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
      {!loading && !error && diff && !diff.unavailable && (
        <div className="min-h-0 flex-1 overflow-auto p-2">
          <div className="mb-2 text-xs text-muted-foreground">
            {diff.files.length} files ·{' '}
            <span className="text-success-foreground">+{diff.additions}</span>{' '}
            <span className="text-destructive">−{diff.deletions}</span>
          </div>
          {diff.truncated && (
            <p role="status" className="mb-2 text-xs text-muted-foreground">
              Diff truncated. Some files or lines are omitted.
            </p>
          )}
          {diff.files.map((file) => (
            <DiffFileView
              key={`${file.oldPath}:${file.newPath}`}
              file={file}
              split={split}
              wrap={wrap}
              collapsed={collapsed[file.newPath ?? file.oldPath ?? '']}
              onToggle={() =>
                setCollapsed((items) => ({
                  ...items,
                  [file.newPath ?? file.oldPath ?? '']:
                    !items[file.newPath ?? file.oldPath ?? ''],
                }))
              }
              onComment={(side, line, body) =>
                onComment(
                  captureGitReviewNote(
                    loaded!.workspace,
                    diff,
                    file,
                    side,
                    line,
                    body,
                  ),
                )
              }
              reanchorNote={reanchorNote}
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
  split,
  wrap,
  reanchorNote,
}: {
  file: GitDiffFile
  collapsed: boolean
  onToggle: () => void
  onComment: (side: 'old' | 'new', line: number, body: string) => void
  reanchorNote?: ReviewNote
  split: boolean
  wrap: boolean
}) {
  const path = file.newPath ?? file.oldPath ?? 'unknown'
  const lineView = (
    line: GitDiffFile['hunks'][number]['lines'][number] | undefined,
    side?: 'old' | 'new',
  ) => {
    if (!line)
      return (
        <div className="min-h-[21px] min-w-0 bg-muted/20" aria-hidden="true" />
      )
    const number =
      side === 'old'
        ? line.oldLine
        : side === 'new'
          ? line.newLine
          : (line.newLine ?? line.oldLine)
    const anchorSide = side ?? (line.newLine === null ? 'old' : 'new')
    return (
      <div
        className={cn(
          'group flex min-w-0 border-l-[3px] border-transparent',
          !wrap && 'min-w-max',
          line.type === 'addition' && 'border-l-success bg-success/10',
          line.type === 'deletion' && 'border-l-destructive bg-destructive/10',
        )}
      >
        {!side && (
          <span className="w-9 shrink-0 select-none px-1 text-right text-muted-foreground">
            {line.oldLine ?? ''}
          </span>
        )}
        <span className="w-9 shrink-0 select-none px-1 text-right text-muted-foreground">
          {side ? number : (line.newLine ?? '')}
        </span>
        <span className="w-5 shrink-0 select-none text-center">
          {line.type === 'addition'
            ? '+'
            : line.type === 'deletion'
              ? '−'
              : ' '}
        </span>
        <span
          className={cn(
            'min-w-0 flex-1 px-1',
            wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre',
          )}
        >
          {line.text || ' '}
        </span>
        {number && line.type !== 'context' && line.type !== 'meta' && (
          <button
            className="ml-1 inline-flex h-6 shrink-0 items-center rounded px-1 text-muted-foreground opacity-0 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring group-hover:opacity-100 pointer-coarse:size-11 pointer-coarse:opacity-100"
            aria-label={`Comment on ${anchorSide} line ${number}`}
            onClick={() => {
              const text =
                reanchorNote?.body ??
                window.prompt(`Comment on ${path}:${number}`)
              if (text?.trim()) onComment(anchorSide, number, text.trim())
            }}
          >
            <MessageSquare size={12} />
          </button>
        )}
      </div>
    )
  }
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
        <div
          className="overflow-x-auto font-mono text-xs leading-[21px]"
          data-layout={split ? 'split' : 'unified'}
          data-wrap={wrap}
        >
          {file.contentTruncated && (
            <p role="status" className="p-2 text-muted-foreground">
              File diff truncated. Some lines are omitted.
            </p>
          )}
          {file.status === 'binary' ? (
            <p className="p-3 text-muted-foreground">Binary file changed.</p>
          ) : file.status === 'submodule' ? (
            <p className="p-3 text-muted-foreground">Submodule changed.</p>
          ) : split ? (
            <table
              className={cn(
                'w-full border-collapse',
                wrap ? 'table-fixed' : 'min-w-max',
              )}
              aria-label="Split diff"
            >
              <colgroup>
                <col className="w-1/2" />
                <col className="w-1/2" />
              </colgroup>
              {file.hunks.map((hunk, index) => (
                <tbody key={index}>
                  <tr>
                    <td
                      colSpan={2}
                      className="h-7 bg-muted/40 px-2 text-muted-foreground"
                    >
                      @@ −{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},
                      {hunk.newCount} @@
                    </td>
                  </tr>
                  {splitDiffLines(hunk.lines).map((pair, i) => (
                    <tr key={i}>
                      <td className="border-r border-border p-0 align-top">
                        {lineView(pair[0], 'old')}
                      </td>
                      <td className="p-0 align-top">
                        {lineView(pair[1], 'new')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          ) : (
            file.hunks.map((hunk, index) => (
              <div key={index}>
                <div className="flex h-7 items-center bg-muted/40 px-2 text-muted-foreground">
                  @@ −{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},
                  {hunk.newCount} @@
                </div>
                {hunk.lines.map((line, i) => (
                  <div key={i}>{lineView(line)}</div>
                ))}
              </div>
            ))
          )}
        </div>
      )}
    </article>
  )
}
