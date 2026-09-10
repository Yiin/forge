import { Copy, MoreHorizontal, Pencil, Terminal } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api } from '../../lib/api'
import { useSessionsStore } from '../../stores/sessions'
import { registerShortcuts } from '../../lib/shortcuts'
import { cn } from '../../lib/utils'
import { folderName } from '../../lib/folder-name'
import { accountKindForHarness } from '../../lib/harness-accounts-logic'
import { harnessHealthResponseSchema } from '@forge/protocol/status'
import claudeMark from '../../assets/providers/claude.svg'
import codexMark from '../../assets/providers/openai.svg'
import opencodeMark from '../../assets/providers/opencode.svg'
import cursorMark from '../../assets/providers/cursor.svg'
import grokMark from '../../assets/providers/grok.svg'
import hermesMark from '../../assets/providers/hermes.svg'
import piMark from '../../assets/providers/pi.svg'
import devinMark from '../../assets/providers/devin.svg'

import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../ui/tooltip'

const providerMarks: Record<string, string> = {
  claude: claudeMark,
  codex: codexMark,
  opencode: opencodeMark,
  cursor: cursorMark,
  grok: grokMark,
  hermes: hermesMark,
  pi: piMark,
  devin: devinMark,
}

export function SessionHeader({
  sessionId,
  className,
  embedded = false,
}: {
  sessionId: string
  className?: string
  embedded?: boolean
}) {
  const session = useSessionsStore((state) =>
    state.sessions.find((item) => item.id === sessionId),
  )
  const projects = useSessionsStore((state) => state.projects)
  const upsertSession = useSessionsStore((state) => state.upsertSession)
  const [provider, setProvider] = useState<{
    name: string
    kind: string
  } | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    setProvider(null)
    void fetch('/api/harnesses/health', { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return
        if (!response.ok) throw new Error('Provider information unavailable')
        return response.json()
      })
      .then((value) => {
        if (controller.signal.aborted) return
        const health = harnessHealthResponseSchema.parse(value)
        const entry = health.find((item) => item.key === session?.harness)
        if (!entry) return
        const account = entry.accounts.find(
          (item) => item.id === session?.accountId,
        )
        setProvider({
          name: entry.name,
          kind:
            account?.kind ??
            accountKindForHarness(entry.key, entry) ??
            entry.key,
        })
      })
      .catch(() => undefined)
    return () => {
      controller.abort()
    }
  }, [session?.harness, session?.accountId])
  const [editing, setEditing] = useState(false)
  const [infoSource, setInfoSource] = useState<'title' | 'menu' | null>(null)
  const [title, setTitle] = useState(session?.title ?? 'New session')
  useEffect(
    () => setTitle(session?.title ?? 'New session'),
    [sessionId, session?.title],
  )
  useEffect(() => {
    setEditing(false)
    setInfoSource(null)
  }, [sessionId])
  useEffect(
    () =>
      registerShortcuts({
        'session.rename': () => {
          setInfoSource(null)
          setEditing(true)
        },
      }),
    [],
  )
  if (!session) return null
  const current = session
  async function rename() {
    const clean = title.trim()
    setEditing(false)
    if (!clean || clean === current.title) return
    upsertSession({ ...current, title: clean })
    try {
      await api.renameSession(current.id, clean)
    } catch {
      upsertSession(current)
    }
  }
  async function copyId() {
    if (!navigator.clipboard) {
      toast.error('Copy is not available')
      return
    }
    await navigator.clipboard.writeText(current.id)
    toast.success('Session ID copied')
  }
  const createdAt = current.createdAt
    ? new Date(current.createdAt)
    : current.created_at
      ? new Date(current.created_at)
      : undefined
  const projectId = current.projectId ?? current.project_id
  const project = projects.find((project) => project.id === projectId)
  const projectName = project?.name
  const workspacePath = current.cwd ?? current.worktreePath ?? project?.path
  const workspaceLabel = workspacePath
    ? workspacePath === project?.path && projectName
      ? projectName
      : folderName(workspacePath)
    : 'Workspace unavailable'
  const contextLabel =
    current.contextMethod === 'exact'
      ? 'Exact fork'
      : 'Synthetic context · reduced confidence'
  const providerName =
    provider?.name ?? current.harness ?? 'Provider unavailable'
  const providerMark = providerMarks[provider?.kind ?? current.harness ?? '']
  const infoPanel = (
    <>
      <strong className="block truncate text-foreground">
        {current.title}
      </strong>
      <dl className="space-y-1 text-xs text-muted-foreground">
        <div className="flex justify-between gap-2">
          <dt>Harness</dt>
          <dd className="text-foreground">{current.harness ?? 'default'}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>Project</dt>
          <dd className="truncate text-foreground">
            {projectName ?? (projectId ? 'Untitled project' : 'none')}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>Workspace</dt>
          <dd className="min-w-0 break-all text-right text-foreground">
            {workspacePath ?? 'Unavailable'}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>Model</dt>
          <dd className="truncate text-foreground">
            {current.model ?? 'default'}
          </dd>
        </div>
        {current.contextMethod && (
          <div className="flex justify-between gap-2">
            <dt>Context</dt>
            <dd className="min-w-0 text-right text-foreground">
              {contextLabel}
            </dd>
          </div>
        )}
        <div className="flex justify-between gap-2">
          <dt>Created</dt>
          <dd className="text-foreground">
            {createdAt && !Number.isNaN(createdAt.getTime())
              ? createdAt.toLocaleString()
              : 'unknown'}
          </dd>
        </div>
      </dl>
      <div className="flex flex-col gap-1 border-t border-border pt-2">
        <Button
          variant="ghost"
          size="sm"
          className="justify-start text-muted-foreground"
          onClick={() => {
            setInfoSource(null)
            setEditing(true)
          }}
        >
          <Pencil className="size-3.5" /> Rename session
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="justify-start text-muted-foreground"
          onClick={() => void copyId()}
        >
          <Copy className="size-3.5" /> Copy session ID
        </Button>
      </div>
    </>
  )
  return (
    <TooltipProvider delay={300}>
      <div
        className={cn(
          embedded
            ? 'session-header contents'
            : 'session-header flex h-[38px] items-center gap-2 border-b border-border px-3 sm:px-5',
          className,
        )}
      >
        <span
          className={cn(
            'size-2 shrink-0 rounded-full',
            current.status === 'running'
              ? 'animate-pulse bg-primary'
              : current.status === 'errored'
                ? 'bg-destructive'
                : 'bg-muted-foreground/50',
          )}
          aria-label={current.status ?? 'idle'}
        />
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="flex min-w-0 shrink-0 items-center gap-2 text-muted-foreground" />
            }
          >
            {providerMark ? (
              <span
                aria-hidden="true"
                className="size-3.5 shrink-0 bg-current"
                style={{
                  maskImage: `url("${providerMark}")`,
                  maskSize: 'contain',
                  maskRepeat: 'no-repeat',
                  maskPosition: 'center',
                }}
              />
            ) : (
              <Terminal className="size-3.5 shrink-0" aria-hidden="true" />
            )}
            <span className="max-w-20 truncate text-xs">{providerName}</span>
          </TooltipTrigger>
          <TooltipContent>{providerName}</TooltipContent>
        </Tooltip>
        {editing ? (
          <Input
            className="h-8 min-w-0 max-w-72 flex-1"
            aria-label="Session title"
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => void rename()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void rename()
              if (event.key === 'Escape') {
                setTitle(current.title)
                setEditing(false)
              }
            }}
          />
        ) : (
          <Popover
            open={infoSource === 'title'}
            onOpenChange={(open) => setInfoSource(open ? 'title' : null)}
          >
            <PopoverTrigger
              render={
                <button
                  className="min-w-0 truncate text-left text-sm font-medium text-foreground hover:text-primary"
                  title="Toggle session information"
                  type="button"
                />
              }
            >
              {current.title}
            </PopoverTrigger>
            <PopoverContent
              align="start"
              className="w-80 max-w-[calc(100vw-2rem)] space-y-2 text-sm"
            >
              {infoPanel}
            </PopoverContent>
          </Popover>
        )}
        <span
          className="min-w-0 max-w-[30%] truncate text-xs text-muted-foreground"
          title={workspacePath ?? workspaceLabel}
        >
          {workspaceLabel}
        </span>
        {current.contextMethod && (
          <Badge
            variant="outline"
            className="min-w-0 max-w-[40%] shrink text-muted-foreground"
            title={contextLabel}
          >
            <span className="truncate md:hidden">
              {current.contextMethod === 'exact'
                ? 'Exact fork'
                : 'Synthetic fork'}
            </span>
            <span className="hidden truncate md:inline">{contextLabel}</span>
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Rename session"
                  onClick={() => {
                    setInfoSource(null)
                    setEditing(true)
                  }}
                />
              }
            >
              <Pencil className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent>Rename session</TooltipContent>
          </Tooltip>
          <Popover
            open={infoSource === 'menu'}
            onOpenChange={(open) => setInfoSource(open ? 'menu' : null)}
          >
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Session information"
                />
              }
            >
              <MoreHorizontal className="size-4" />
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="w-80 max-w-[calc(100vw-2rem)] space-y-2 text-sm"
            >
              {infoPanel}
            </PopoverContent>
          </Popover>
        </div>
      </div>
    </TooltipProvider>
  )
}
