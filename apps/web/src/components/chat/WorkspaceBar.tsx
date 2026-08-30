import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { api } from '../../lib/api'
import { useDraftsStore } from '../../stores/drafts'
import { useSessionsStore, type SessionSummary } from '../../stores/sessions'
import type { GitRef, GitRefsPage, GitStatus } from '@forge/protocol/git'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Button } from '@/components/ui/button'
import {
  branchTriggerLabel,
  currentWorkspaceLabel,
  defaultBaseRef,
  effectiveWorkspaceMode,
  isModeLocked,
  workspaceModeLabel,
  type WorkspaceMode,
} from './workspace-picker-logic'

const PILL_TRIGGER_CLASS =
  'h-9 w-auto min-w-0 max-w-40 shrink-0 gap-1 border-transparent bg-transparent px-2 text-xs text-muted-foreground/70 shadow-none before:hidden hover:bg-accent/50 hover:text-foreground/80 sm:h-8 sm:max-w-48'

export function WorkspaceBar({
  projectId,
  sessionId,
  draftId,
  disabled,
}: {
  projectId: string
  sessionId?: string
  draftId?: string
  disabled?: boolean
}) {
  const session = useSessionsStore((state) =>
    state.sessions.find((item) => item.id === sessionId),
  )
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [refs, setRefs] = useState<GitRefsPage | null>(null)
  const [query, setQuery] = useState('')
  const draft = useDraftsStore((state) =>
    draftId ? state.drafts[draftId] : undefined,
  )
  const mode = effectiveWorkspaceMode({
    worktreePath: session?.worktreePath ?? null,
    hasSession: Boolean(sessionId),
    draftMode: draft?.workspaceMode,
  })
  const worktreePath = session?.worktreePath ?? null
  const branch = session?.branch ?? status?.branch ?? draft?.baseRef ?? null
  const locked = isModeLocked({ hasSession: Boolean(sessionId), worktreePath })
  const cwd = worktreePath ?? undefined
  useEffect(() => {
    if (projectId)
      void api
        .gitStatus(projectId, cwd)
        .then((value) => setStatus(value as GitStatus))
        .catch(() => setStatus(null))
  }, [projectId, cwd])
  useEffect(() => {
    if (!projectId || status?.isRepo === false) return
    const timer = setTimeout(() => {
      void api
        .gitBranches(projectId, { cwd, query, limit: 30 })
        .then((value) => setRefs(value as GitRefsPage))
        .catch(() => setRefs(null))
    }, 200)
    return () => clearTimeout(timer)
  }, [projectId, cwd, query, status?.isRepo])
  const visibleRefs = useMemo(() => refs?.refs.slice(0, 30) ?? [], [refs])
  if (status && !status.isRepo) return null
  if (!status) return null
  const updateWorkspace = async (next: {
    mode: WorkspaceMode
    branch?: string
    baseRef?: string
  }) => {
    if (draftId) {
      useDraftsStore.getState().update(draftId, {
        workspaceMode: next.mode,
        baseRef: next.baseRef ?? next.branch,
      })
      return
    }
    if (!sessionId) return
    try {
      await api.setSessionWorkspace(sessionId, next)
      const updated = await api.getSession(sessionId)
      useSessionsStore.getState().upsertSession(updated as SessionSummary)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Could not update workspace',
      )
    }
  }
  const selectedBase = defaultBaseRef(visibleRefs, status.branch)
  return (
    <div
      className="mx-auto flex w-full max-w-3xl items-center gap-1 px-2.5 pb-1 pt-1 sm:px-3"
      data-testid="workspace-bar"
    >
      {locked ? (
        <span
          className="truncate px-2 text-xs text-muted-foreground"
          aria-label="Workspace"
        >
          {currentWorkspaceLabel(worktreePath)}
        </span>
      ) : (
        <Select
          value={mode}
          onValueChange={(value) =>
            value &&
            void updateWorkspace({
              mode: value as WorkspaceMode,
              baseRef:
                value === 'worktree'
                  ? (draft?.baseRef ?? selectedBase ?? undefined)
                  : undefined,
            })
          }
          disabled={disabled}
        >
          <SelectTrigger aria-label="Workspace" className={PILL_TRIGGER_CLASS}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="local">
              {currentWorkspaceLabel(worktreePath)}
            </SelectItem>
            <SelectItem value="worktree">
              {workspaceModeLabel('worktree')}
            </SelectItem>
          </SelectContent>
        </Select>
      )}
      <Popover>
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              aria-label="Branch"
              className={PILL_TRIGGER_CLASS}
              disabled={disabled}
            >
              {branchTriggerLabel({ mode, worktreePath, branch })}
            </Button>
          }
        />
        <PopoverContent className="w-72 p-0">
          <Command>
            <CommandInput
              placeholder="Search branches…"
              value={query}
              onValueChange={setQuery}
            />
            <CommandList>
              <CommandEmpty>
                {refs ? 'No branches found' : 'Loading branches…'}
              </CommandEmpty>
              {visibleRefs.map((ref: GitRef) => (
                <CommandItem
                  key={ref.name}
                  value={ref.name}
                  onSelect={() => {
                    void updateWorkspace(
                      mode === 'worktree' && !worktreePath
                        ? { mode, baseRef: ref.name }
                        : { mode, branch: ref.name },
                    )
                    setQuery('')
                  }}
                >
                  {ref.name}
                </CommandItem>
              ))}
              {refs?.nextCursor !== null && refs && (
                <div className="px-3 py-2 text-xs text-muted-foreground">
                  Showing {visibleRefs.length} of {refs.totalCount}
                </div>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  )
}
