import { useEffect, useRef, useState } from 'react'
import {
  ChevronLeft,
  GripVertical,
  Maximize2,
  Minimize2,
  PanelRight,
  Plus,
  X,
} from 'lucide-react'
import { Button } from '../ui/button'
import { cn } from '@/lib/utils'
import { BrowserPreview } from './BrowserPreview'
import { TerminalSurface } from './TerminalSurface'
import { GitReviewSurface, type ReviewComment } from './GitReviewSurface'
import { GitHistorySurface } from './GitHistorySurface'
import { WorkspaceFilesSurface } from './WorkspaceFilesSurface'
import { SubagentTranscript } from '../chat/SubagentTranscript'
import { connectForgeSocket } from '../../lib/socket'
import { SessionSnapshot } from '@forge/protocol/ws'
import { useMessagesStore } from '../../stores/messages'
import { useSessionsStore } from '../../stores/sessions'
import {
  DOCK_CHAT_MIN_WIDTH,
  type DockSurfaceKind,
  type DockTab,
  useShellStore,
} from '@/stores/shell'

const EMPTY_MESSAGES: never[] = []

type WorkspaceTarget = {
  cwd: string | null
  workspaceId?: string | null
  workspaceRevision?: number | null
}

const surfaceLabels: Record<DockSurfaceKind, string> = {
  files: 'Files',
  file: 'File',
  diff: 'Diff',
  history: 'History',
  terminal: 'Terminal',
  browser: 'Browser',
  subagent: 'Child transcript',
}

export function WorkspaceDock({
  sessionId,
  target,
  projectId,
  onReviewComment,
  mobile = false,
}: {
  sessionId: string
  target: WorkspaceTarget
  projectId: string
  onReviewComment?: (comment: ReviewComment) => void
  mobile?: boolean
}) {
  const dock = useShellStore((state) => state.dock(sessionId))
  const width = useShellStore((state) => state.dockWidth)
  const closeDock = useShellStore((state) => state.closeDock)
  const setTakeover = useShellStore((state) => state.setDockTakeover)
  const setWidth = useShellStore((state) => state.setDockWidth)
  const openTab = useShellStore((state) => state.openDockTab)
  const closeTab = useShellStore((state) => state.closeDockTab)
  const selectTab = useShellStore((state) => state.setActiveDockTab)
  const [adding, setAdding] = useState(false)
  const drag = useRef<{ x: number; width: number } | null>(null)

  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!drag.current) return
      setWidth(drag.current.width - (event.clientX - drag.current.x))
    }
    const up = () => {
      drag.current = null
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [setWidth])

  if (!dock.open) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="pointer-coarse:min-h-11"
        onClick={() => setAdding(true)}
        aria-label="Open workspace dock"
      >
        <PanelRight size={16} /> Workspace
      </Button>
    )
  }

  const add = (kind: DockSurfaceKind) => {
    const tab: DockTab = {
      id: `${kind}-${crypto.randomUUID()}`,
      kind,
      title: surfaceLabels[kind],
    }
    openTab(sessionId, tab)
    setAdding(false)
  }
  const active = dock.tabs.find((tab) => tab.id === dock.activeTabId)
  const content = active ? (
    <SurfaceContent
      kind={active.kind}
      target={target}
      sessionId={sessionId}
      projectId={projectId}
      onReviewComment={onReviewComment}
      commit={active.commit}
      path={active.path}
      childSessionId={active.childSessionId}
      onCommit={(sha) => {
        openTab(sessionId, {
          id: `commit-${sha}`,
          kind: 'diff',
          title: `Commit ${sha.slice(0, 7)}`,
          commit: sha,
        })
      }}
    />
  ) : (
    <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
      Select a workspace surface.
    </div>
  )
  return (
    <aside
      className={cn(
        'workspace-dock flex min-h-0 flex-col border-l border-border bg-background',
        dock.takeover || mobile
          ? 'fixed inset-0 z-30'
          : 'shrink-0 max-sm:fixed max-sm:inset-0 max-sm:z-30',
      )}
      style={
        !dock.takeover && !mobile
          ? { width: `min(${width}px, calc(100% - ${DOCK_CHAT_MIN_WIDTH}px))` }
          : undefined
      }
      aria-label="Workspace dock"
    >
      {!dock.takeover && !mobile && (
        <button
          className="absolute -ml-3 hidden h-full w-6 cursor-col-resize items-center justify-center md:flex"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize workspace dock"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') setWidth(width + 16)
            if (event.key === 'ArrowRight') setWidth(width - 16)
          }}
          onPointerDown={(event) => {
            drag.current = { x: event.clientX, width }
          }}
        >
          <GripVertical size={14} />
        </button>
      )}
      <header className="flex min-h-[38px] shrink-0 items-center gap-1 border-b border-border px-2">
        {(mobile || dock.takeover) && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="pointer-coarse:size-11"
            onClick={() => setTakeover(sessionId, false)}
            aria-label="Return to conversation"
          >
            <ChevronLeft size={16} />
          </Button>
        )}
        <div
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
          role="tablist"
          aria-label="Workspace tabs"
        >
          {dock.tabs.map((tab, index) => (
            <div
              key={tab.id}
              className="flex shrink-0 items-center rounded-md bg-muted/60"
              role="presentation"
            >
              <button
                role="tab"
                aria-selected={tab.id === dock.activeTabId}
                className="pointer-coarse:min-h-11 px-2 text-xs"
                onKeyDown={(event) => {
                  if (event.key === 'Delete') closeTab(sessionId, tab.id)
                  if (event.key === 'Tab' && event.ctrlKey) {
                    event.preventDefault()
                    selectTab(
                      sessionId,
                      dock.tabs[(index + 1) % dock.tabs.length].id,
                    )
                  }
                }}
                onClick={() => selectTab(sessionId, tab.id)}
              >
                {tab.title}
              </button>
              <button
                className="pointer-coarse:size-11 p-2 text-muted-foreground hover:text-foreground"
                aria-label={`Close ${tab.title}`}
                onClick={() => closeTab(sessionId, tab.id)}
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="pointer-coarse:size-11"
          onClick={() => setAdding((value) => !value)}
          aria-label="Add workspace tab"
        >
          <Plus size={16} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="pointer-coarse:size-11"
          onClick={() => setTakeover(sessionId, !dock.takeover)}
          aria-label={
            dock.takeover ? 'Restore workspace dock' : 'Take over workspace'
          }
        >
          {dock.takeover ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="pointer-coarse:size-11"
          onClick={() => closeDock(sessionId)}
          aria-label="Hide workspace dock"
        >
          <X size={16} />
        </Button>
      </header>
      {adding && <SurfacePicker onSelect={add} />}
      <div className="min-h-0 flex-1 overflow-hidden">{content}</div>
    </aside>
  )
}

function SurfacePicker({
  onSelect,
}: {
  onSelect: (kind: DockSurfaceKind) => void
}) {
  return (
    <div
      className="flex flex-wrap gap-1 border-b border-border p-2"
      role="menu"
      aria-label="Workspace surfaces"
    >
      {(Object.keys(surfaceLabels) as DockSurfaceKind[]).map((kind) => (
        <Button
          key={kind}
          variant="outline"
          size="sm"
          className="pointer-coarse:min-h-11"
          onClick={() => onSelect(kind)}
        >
          {surfaceLabels[kind]}
        </Button>
      ))}
    </div>
  )
}

function SurfaceContent({
  kind,
  target,
  sessionId,
  projectId,
  onReviewComment = () => undefined,
  commit,
  path,
  childSessionId,
  onCommit = () => undefined,
}: {
  kind: DockSurfaceKind
  target: WorkspaceTarget
  sessionId: string
  projectId: string
  onReviewComment?: (comment: ReviewComment) => void
  commit?: string
  path?: string
  childSessionId?: string
  onCommit?: (sha: string) => void
}) {
  if (kind === 'subagent')
    return <ChildTranscriptSurface sessionId={childSessionId} />
  if (kind === 'browser') return <BrowserPreview sessionId={sessionId} />
  if (kind === 'terminal')
    return <TerminalSurface sessionId={sessionId} target={target} />
  if (kind === 'files' || kind === 'file')
    return (
      <WorkspaceFilesSurface
        sessionId={sessionId}
        target={target}
        initialPath={kind === 'file' ? path : undefined}
      />
    )
  if (!target.cwd)
    return (
      <div className="p-6 text-sm" role="status">
        No workspace is attached to this session.
      </div>
    )
  if (kind === 'diff')
    return (
      <GitReviewSurface
        projectId={projectId}
        sessionId={sessionId}
        cwd={target.cwd!}
        commit={commit}
        onComment={onReviewComment}
      />
    )
  if (kind === 'history')
    return (
      <GitHistorySurface
        projectId={projectId}
        sessionId={sessionId}
        cwd={target.cwd!}
        onCommit={onCommit}
      />
    )
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground"
      role="status"
    >
      <p>{surfaceLabels[kind]} surface is not available yet.</p>
      <p className="max-w-sm text-xs">
        This host does not show sample content. The surface will use:
      </p>
      <code
        className="max-w-full truncate rounded bg-muted px-2 py-1 text-xs"
        title={target.cwd}
      >
        {target.cwd}
      </code>
    </div>
  )
}

function ChildTranscriptSurface({ sessionId }: { sessionId?: string }) {
  const child = useSessionsStore((state) =>
    sessionId
      ? state.sessions.find((session) => session.id === sessionId)
      : null,
  )
  const messages = useMessagesStore(
    (state) =>
      (sessionId ? state.bySession[sessionId] : undefined) ?? EMPTY_MESSAGES,
  )
  const messagesVersion = useMessagesStore((state) => state.lastSeq)

  useEffect(() => {
    if (!sessionId) return
    let active = true
    void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`)
      .then((response) => {
        if (!response.ok) throw new Error('Could not load transcript')
        return response.json()
      })
      .then((rows: unknown) => {
        const snapshot = SessionSnapshot.safeParse({
          ...(rows as object),
          type: 'sessionSnapshot',
          sessionId,
        })
        if (active && snapshot.success)
          useMessagesStore.getState().loadSnapshot(snapshot.data)
      })
      .catch(() => undefined)
    const socket = connectForgeSocket({ sessions: [sessionId] })
    return () => {
      active = false
      socket.stop()
    }
  }, [sessionId])

  if (!child)
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Child session is unavailable.
      </div>
    )
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border px-3 py-2 text-sm font-medium">
        {child.title || 'Child transcript'}
      </div>
      <SubagentTranscript
        messages={messages}
        messagesVersion={messagesVersion}
        skills={[]}
      />
    </div>
  )
}
