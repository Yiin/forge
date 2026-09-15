import { useCallback, useEffect, useRef, useState } from 'react'
import { Plus, RefreshCw, X } from 'lucide-react'
import {
  terminalEventSchema,
  terminalCollectionSchema,
  type TerminalDescriptor,
} from '@forge/protocol/terminal'
import { Button } from '../ui/button'

type Target = {
  cwd: string | null
  workspaceId?: string | null
  workspaceRevision?: number | null
}

function socketUrl(path: string) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}${path}`
}

function decode(value: string) {
  const bytes = Uint8Array.from(atob(value), (character) =>
    character.charCodeAt(0),
  )
  return new TextDecoder().decode(bytes)
}

function ansi(value: string) {
  const parts = value.split(/(\x1b\[[0-9;]*m)/g)
  let color = ''
  return parts.map((part, index) => {
    const match = /^\x1b\[([0-9;]*)m$/.exec(part)
    if (match) {
      const code = match[1] ?? ''
      color =
        code === '31'
          ? 'text-red-300'
          : code === '32'
            ? 'text-green-200'
            : code === '33'
              ? 'text-yellow-200'
              : code === '34'
                ? 'text-blue-300'
                : code === '35'
                  ? 'text-fuchsia-300'
                  : code === '36'
                    ? 'text-cyan-200'
                    : ''
      return null
    }
    return (
      <span key={index} className={color}>
        {part}
      </span>
    )
  })
}

export function TerminalSurface({
  sessionId,
  target,
}: {
  sessionId: string
  target: Target
}) {
  const [terminals, setTerminals] = useState<TerminalDescriptor[]>([])
  const [activeId, setActiveId] = useState<string>()
  const [output, setOutput] = useState<Record<string, string>>({})
  const [error, setError] = useState<string>()
  const [creating, setCreating] = useState(false)
  const active = terminals.find((terminal) => terminal.id === activeId)
  const cursors = useRef<Record<string, number>>({})
  const sockets = useRef<Record<string, WebSocket>>({})

  const open = useCallback(
    (terminal: TerminalDescriptor) => {
      sockets.current[terminal.id]?.close()
      const cursor = cursors.current[terminal.id] ?? 0
      const socket = new WebSocket(
        socketUrl(
          `/api/sessions/${encodeURIComponent(sessionId)}/terminals/${encodeURIComponent(terminal.id)}/events?afterSeq=${cursor}`,
        ),
      )
      sockets.current[terminal.id] = socket
      socket.onmessage = (message) => {
        let value: unknown
        try {
          value = JSON.parse(String(message.data))
        } catch {
          return
        }
        const parsed = terminalEventSchema.safeParse(value)
        if (!parsed.success) return
        const event = parsed.data
        if (event.type === 'snapshot') {
          setTerminals((items) =>
            items.map((item) =>
              item.id === terminal.id ? event.descriptor : item,
            ),
          )
          return
        }
        cursors.current[terminal.id] = Math.max(
          cursors.current[terminal.id] ?? 0,
          event.seq,
        )
        if (event.type === 'data')
          setOutput((items) => ({
            ...items,
            [terminal.id]: (items[terminal.id] ?? '') + decode(event.data),
          }))
        if (event.type === 'exit')
          setTerminals((items) =>
            items.map((item) =>
              item.id === terminal.id
                ? {
                    ...item,
                    state: 'exited',
                    exitCode: event.exitCode,
                    signal: event.signal,
                    outputComplete: event.outputComplete,
                    cleanup: event.cleanup,
                  }
                : item,
            ),
          )
      }
      socket.onclose = () => {
        if (sockets.current[terminal.id] === socket)
          delete sockets.current[terminal.id]
      }
    },
    [sessionId],
  )

  const load = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/terminals`,
      )
      const value = terminalCollectionSchema.parse(await response.json())
      setTerminals(value.terminals)
      if (value.terminals[0] && !activeId) setActiveId(value.terminals[0].id)
      value.terminals.forEach(open)
      setError(undefined)
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not load terminals',
      )
    }
  }, [open, sessionId])

  useEffect(() => {
    void load()
    return () =>
      Object.values(sockets.current).forEach((socket) => socket.close())
  }, [load])

  const create = async () => {
    if (!target.workspaceId || !target.workspaceRevision || creating) return
    setCreating(true)
    try {
      const response = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/terminals`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            expectedWorkspaceId: target.workspaceId,
            expectedWorkspaceRevision: target.workspaceRevision,
            cols: 100,
            rows: 30,
          }),
        },
      )
      const terminal = (await response.json()) as TerminalDescriptor
      if (!response.ok)
        throw new Error(
          (terminal as unknown as { error?: { message?: string } }).error
            ?.message ?? 'Could not create terminal',
        )
      cursors.current[terminal.id] = 0
      setTerminals((items) => [...items, terminal])
      setActiveId(terminal.id)
      open(terminal)
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not create terminal',
      )
    } finally {
      setCreating(false)
    }
  }

  const send = (data: string) => {
    if (!active) return
    void fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/terminals/${encodeURIComponent(active.id)}/input`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data }),
      },
    ).catch(() => setError('Terminal input failed'))
  }

  const resize = useCallback(
    (cols: number, rows: number) => {
      if (!active) return
      void fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/terminals/${encodeURIComponent(active.id)}/resize`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cols, rows }),
        },
      )
    },
    [active, sessionId],
  )

  const close = async (terminal: TerminalDescriptor) => {
    await fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/terminals/${encodeURIComponent(terminal.id)}`,
      { method: 'DELETE' },
    )
    sockets.current[terminal.id]?.close()
    setTerminals((items) => items.filter((item) => item.id !== terminal.id))
    if (activeId === terminal.id)
      setActiveId(terminals.find((item) => item.id !== terminal.id)?.id)
  }

  return (
    <section
      className="flex h-full min-h-0 flex-col bg-black text-green-200"
      aria-label="Terminal surface"
    >
      <div
        className="flex min-h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-white/15 bg-background px-2 text-foreground"
        role="tablist"
        aria-label="Terminal tabs"
      >
        {terminals.map((terminal) => (
          <div key={terminal.id} className="flex shrink-0 items-center">
            <button
              role="tab"
              aria-selected={terminal.id === activeId}
              className="pointer-coarse:min-h-11 px-3 text-xs"
              onClick={() => setActiveId(terminal.id)}
            >
              {terminal.title}
            </button>
            <button
              className="pointer-coarse:size-11 p-2 text-muted-foreground"
              aria-label={`Close ${terminal.title}`}
              onClick={() => void close(terminal)}
            >
              <X size={13} />
            </button>
          </div>
        ))}
        <Button
          variant="ghost"
          size="icon-sm"
          className="pointer-coarse:size-11"
          disabled={!target.cwd || creating}
          onClick={() => void create()}
          aria-label="Create terminal"
        >
          <Plus size={16} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="pointer-coarse:size-11 text-foreground"
          onClick={() => void load()}
          aria-label="Reconnect terminals"
        >
          <RefreshCw size={15} />
        </Button>
      </div>
      {error && (
        <div
          className="shrink-0 border-b border-red-400/40 bg-red-950/40 px-3 py-2 text-xs text-red-200"
          role="alert"
        >
          {error}
        </div>
      )}
      {!target.cwd ? (
        <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
          No workspace is attached to this session.
        </div>
      ) : !active ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
          <p>No terminal is open.</p>
          <Button
            variant="outline"
            className="pointer-coarse:min-h-11"
            onClick={() => void create()}
            disabled={creating}
          >
            Open terminal
          </Button>
        </div>
      ) : (
        <TerminalView
          value={output[active.id] ?? ''}
          onInput={send}
          onResize={resize}
        />
      )}
    </section>
  )
}

function TerminalView({
  value,
  onInput,
  onResize,
}: {
  value: string
  onInput: (value: string) => void
  onResize: (cols: number, rows: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  useEffect(() => {
    onResize(100, 30)
  }, [onResize])
  return (
    <div
      ref={ref}
      role="textbox"
      aria-label="Terminal input"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          onInput('\r')
        } else if (event.key === 'Backspace') {
          event.preventDefault()
          onInput('\u007f')
        } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey)
          onInput(event.key)
      }}
      onPaste={(event) => {
        event.preventDefault()
        onInput(event.clipboardData.getData('text'))
      }}
      className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap border-0 bg-black p-3 font-mono text-sm leading-5 text-green-200 outline-none"
      spellCheck={false}
    >
      {value ? ansi(value) : ' '}
    </div>
  )
}
