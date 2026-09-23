import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, RefObject } from 'react'
import { ChevronDown, Folder, FolderGit2, GitBranch } from 'lucide-react'
import { api } from '../../lib/api'
import { useDraftsStore } from '../../stores/drafts'
import { useSessionsStore } from '../../stores/sessions'
import type { GitRef, GitRefsPage, GitStatus } from '@forge/protocol/git'
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import {
  CARD_CLASS,
  CARD_VIEWPORT_CLASS,
  FOOTER_CHIP_CLASS,
  FOOTER_LABEL_CLASS,
  MENU_EMPTY_CLASS,
  MENU_ROW_CLASS,
  SEARCH_FIELD_CLASS,
} from '../composer/zeron-styles'
import { EDGE_FADE_CLASS, useEdgeFade } from '../composer/useEdgeFade'
import {
  branchTriggerLabel,
  defaultBaseRef,
  effectiveWorkspaceMode,
  sessionCheckoutLabel,
  workspaceModeLabel,
  type WorkspaceMode,
} from './workspace-picker-logic'

const ICON_CLASS = 'size-3 shrink-0'

/**
 * Checkout and branch under the composer pill. A session shows read-only
 * labels; a draft shows chips that pick the checkout mode and the ref.
 */
export function WorkspaceBar({
  projectId,
  sessionId,
  draftId,
}: {
  projectId: string
  sessionId?: string
  draftId?: string
}) {
  const session = useSessionsStore((state) =>
    state.sessions.find((item) => item.id === sessionId),
  )
  const [status, setStatus] = useState<GitStatus | null>(null)
  const worktreePath = session?.worktreePath ?? null
  const cwd = worktreePath ?? undefined
  useEffect(() => {
    if (projectId)
      void api
        .gitStatus(projectId, cwd)
        .then((value) => setStatus(value as GitStatus))
        .catch(() => setStatus(null))
  }, [projectId, cwd])
  if (!status || !status.isRepo) return null
  if (!draftId) {
    const branch = session?.branch ?? status.branch
    const Icon = worktreePath ? FolderGit2 : Folder
    return (
      <>
        <span className={FOOTER_LABEL_CLASS} aria-label="Workspace">
          <Icon aria-hidden className={ICON_CLASS} />
          <span className="truncate">{sessionCheckoutLabel(worktreePath)}</span>
        </span>
        <span className={FOOTER_LABEL_CLASS} aria-label="Branch">
          <GitBranch aria-hidden className={ICON_CLASS} />
          <span className="truncate">{branch ?? 'No ref'}</span>
        </span>
      </>
    )
  }
  return (
    <DraftWorkspace
      projectId={projectId}
      draftId={draftId}
      currentBranch={status.branch}
    />
  )
}

function DraftWorkspace({
  projectId,
  draftId,
  currentBranch,
}: {
  projectId: string
  draftId: string
  currentBranch: string | null
}) {
  const draft = useDraftsStore((state) => state.drafts[draftId])
  const [query, setQuery] = useState('')
  const [refs, setRefs] = useState<GitRefsPage | null>(null)
  useEffect(() => {
    if (!projectId) return
    const timer = setTimeout(() => {
      void api
        .gitBranches(projectId, { query, limit: 30 })
        .then((value) => setRefs(value as GitRefsPage))
        .catch(() => setRefs(null))
    }, 200)
    return () => clearTimeout(timer)
  }, [projectId, query])
  const visible = useMemo(() => refs?.refs.slice(0, 30) ?? [], [refs])
  const mode = effectiveWorkspaceMode({
    worktreePath: null,
    hasSession: false,
    draftMode: draft?.workspaceMode,
  })
  const update = (next: WorkspaceMode, ref: string | undefined) =>
    useDraftsStore.getState().update(draftId, {
      workspaceMode: next,
      baseRef: ref,
    })
  return (
    <>
      <CheckoutChip
        mode={mode}
        onPick={(next) =>
          update(
            next,
            next === 'worktree'
              ? (draft?.baseRef ??
                  defaultBaseRef(visible, currentBranch) ??
                  undefined)
              : undefined,
          )
        }
      />
      <BranchChip
        mode={mode}
        branch={draft?.baseRef ?? currentBranch}
        query={query}
        onQuery={setQuery}
        refs={refs}
        visible={visible}
        onPick={(ref) => update(mode, ref)}
      />
    </>
  )
}

function CheckoutChip({
  mode,
  onPick,
}: {
  mode: WorkspaceMode
  onPick: (mode: WorkspaceMode) => void
}) {
  const [open, setOpen] = useState(false)
  const Icon = mode === 'worktree' ? FolderGit2 : Folder
  const modes: WorkspaceMode[] = ['local', 'worktree']
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Workspace"
            className={FOOTER_CHIP_CLASS}
          />
        }
      >
        <Icon
          aria-hidden
          className={cn(ICON_CLASS, 'text-muted-foreground/70')}
        />
        <span className="truncate">{workspaceModeLabel(mode)}</span>
        <ChevronDown
          aria-hidden
          className={cn(ICON_CLASS, 'text-muted-foreground/50')}
        />
      </PopoverTrigger>
      <PopoverPopup
        side="bottom"
        align="start"
        sideOffset={6}
        className={cn(CARD_CLASS, 'w-[224px]')}
        viewportClassName={CARD_VIEWPORT_CLASS}
      >
        <div
          role="listbox"
          aria-label="Workspace"
          className="flex flex-col gap-0.5"
        >
          {modes.map((value) => {
            const RowIcon = value === 'worktree' ? FolderGit2 : Folder
            return (
              <button
                key={value}
                type="button"
                role="option"
                aria-selected={value === mode}
                data-active={value === mode}
                onClick={() => {
                  onPick(value)
                  setOpen(false)
                }}
                className={MENU_ROW_CLASS}
              >
                <RowIcon
                  aria-hidden
                  className="size-3.5 shrink-0 text-muted-foreground"
                />
                <span className="truncate">{workspaceModeLabel(value)}</span>
              </button>
            )
          })}
        </div>
      </PopoverPopup>
    </Popover>
  )
}

function BranchChip({
  mode,
  branch,
  query,
  onQuery,
  refs,
  visible,
  onPick,
}: {
  mode: WorkspaceMode
  branch: string | null
  query: string
  onQuery: (query: string) => void
  refs: GitRefsPage | null
  visible: GitRef[]
  onPick: (ref: string) => void
}) {
  const [open, setOpen] = useState(false)
  const search = useRef<HTMLInputElement>(null)
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) onQuery('')
      }}
    >
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Branch"
            className={FOOTER_CHIP_CLASS}
          />
        }
      >
        <GitBranch
          aria-hidden
          className={cn(ICON_CLASS, 'text-muted-foreground/70')}
        />
        <span className="truncate">
          {branchTriggerLabel({ mode, worktreePath: null, branch })}
        </span>
        <ChevronDown
          aria-hidden
          className={cn(ICON_CLASS, 'text-muted-foreground/50')}
        />
      </PopoverTrigger>
      <PopoverPopup
        side="bottom"
        align="start"
        sideOffset={6}
        initialFocus={search}
        className={cn(CARD_CLASS, 'w-[320px] max-w-[calc(100vw-16px)]')}
        viewportClassName={CARD_VIEWPORT_CLASS}
      >
        <RefList
          search={search}
          query={query}
          onQuery={onQuery}
          refs={refs}
          visible={visible}
          selected={branch}
          onPick={(name) => {
            onPick(name)
            setOpen(false)
          }}
        />
      </PopoverPopup>
    </Popover>
  )
}

function RefList({
  search,
  query,
  onQuery,
  refs,
  visible,
  selected,
  onPick,
}: {
  search: RefObject<HTMLInputElement | null>
  query: string
  onQuery: (query: string) => void
  refs: GitRefsPage | null
  visible: GitRef[]
  selected: string | null
  onPick: (name: string) => void
}) {
  const list = useEdgeFade<HTMLDivElement>()
  const [cursor, setCursor] = useState(() =>
    visible.findIndex((ref) => ref.name === selected),
  )
  useEffect(() => {
    list.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [cursor, list])
  const onKeyDown = (event: KeyboardEvent) => {
    const down =
      event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'n')
    const up = event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'p')
    if ((down || up) && visible.length > 0) {
      event.preventDefault()
      setCursor((current) =>
        current < 0
          ? down
            ? 0
            : visible.length - 1
          : (current + (down ? 1 : -1) + visible.length) % visible.length,
      )
    } else if (event.key === 'Enter') {
      const ref = visible[cursor]
      if (ref) {
        event.preventDefault()
        onPick(ref.name)
      }
    }
  }
  return (
    <div className="flex flex-col" onKeyDown={onKeyDown}>
      <input
        ref={search}
        aria-label="Search refs"
        placeholder="Search refs…"
        value={query}
        onChange={(event) => {
          onQuery(event.target.value)
          setCursor(0)
        }}
        className={SEARCH_FIELD_CLASS}
      />
      <div
        ref={list}
        role="listbox"
        aria-label="Refs"
        className={cn(
          'flex max-h-[300px] flex-col gap-0.5 overflow-y-auto',
          EDGE_FADE_CLASS,
        )}
      >
        {!refs ? (
          Array.from({ length: 3 }, (_, index) => (
            <div
              key={index}
              aria-hidden
              className="h-7 shrink-0 animate-pulse rounded-[6px] bg-ink/4"
            />
          ))
        ) : visible.length === 0 ? (
          <p className={MENU_EMPTY_CLASS}>No refs found.</p>
        ) : (
          visible.map((ref, index) => (
            <button
              key={ref.name}
              type="button"
              role="option"
              aria-selected={ref.name === selected}
              data-active={index === cursor}
              onMouseEnter={() => setCursor(index)}
              onClick={() => onPick(ref.name)}
              className={MENU_ROW_CLASS}
            >
              <span className="min-w-0 flex-1 truncate">{ref.name}</span>
              {(ref.current || ref.worktreePath) && (
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {ref.current ? 'current' : 'worktree'}
                </span>
              )}
            </button>
          ))
        )}
      </div>
      {refs && refs.nextCursor !== null && (
        <p className="mt-1 border-t border-ink/6 px-2 pt-1.5 pb-0.5 text-[11px] text-faint-foreground">
          Showing {visible.length} of {refs.totalCount} refs
        </p>
      )}
    </div>
  )
}
