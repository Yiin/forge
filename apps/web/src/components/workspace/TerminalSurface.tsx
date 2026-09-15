import { useEffect, useRef, useState, useId } from 'react'
import { Plus, RefreshCw, X } from 'lucide-react'
import {
  terminalDescriptorSchema,
  terminalCollectionSchema,
  type TerminalDescriptor,
} from '@forge/protocol/terminal'
import { Button } from '../ui/button'
import { TerminalView } from './TerminalView'

type Target = {
  cwd: string | null
  workspaceId?: string | null
  workspaceRevision?: number | null
}
export function TerminalSurface({
  sessionId,
  target,
}: {
  sessionId: string
  target: Target
}) {
  const tabPrefix = useId()
  const [terminals, setTerminals] = useState<TerminalDescriptor[]>([])
  const [activeId, setActiveId] = useState<string>()
  const [error, setError] = useState<string>()
  const [creating, setCreating] = useState(false)
  const [revision, setRevision] = useState(0)
  const [renaming, setRenaming] = useState<string>()
  const [title, setTitle] = useState('')
  const active = terminals.find((terminal) => terminal.id === activeId)
  const operations = useRef(new Set<AbortController>())
  const generation = useRef(0)
  const creatingRef = useRef(false)
  const listing = useRef(0)
  const endpoint = `/api/sessions/${encodeURIComponent(sessionId)}/terminals`
  const request = async (path = '', method = 'GET', body?: unknown) => {
    if (operations.current.size >= 16)
      throw Error('Too many terminal requests are pending.')
    const controller = new AbortController()
    operations.current.add(controller)
    try {
      const response = await fetch(`${endpoint}${path}`, {
        method,
        signal: controller.signal,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      if (!response.ok)
        throw Error(`Terminal request failed (${response.status})`)
      return response.status === 204 ? null : await response.json()
    } finally {
      operations.current.delete(controller)
    }
  }
  const load = async () => {
    const requestId = ++listing.current
    const owner = generation.current
    try {
      const value = terminalCollectionSchema.parse(await request())
      if (owner !== generation.current) return
      if (value.terminals.some((terminal) => terminal.sessionId !== sessionId))
        throw Error('Terminal session owner changed')
      if (requestId !== listing.current) return
      setTerminals(value.terminals)
      setActiveId((current) =>
        value.terminals.some((terminal) => terminal.id === current)
          ? current
          : value.terminals[0]?.id,
      )
      setError(undefined)
      setRevision((value) => value + 1)
    } catch (cause) {
      if (owner === generation.current)
        setError(
          cause instanceof Error ? cause.message : 'Could not load terminals',
        )
    }
  }
  useEffect(() => {
    generation.current += 1
    setTerminals([])
    setActiveId(undefined)
    creatingRef.current = false
    setCreating(false)
    void load()
    return () => {
      generation.current += 1
      for (const operation of operations.current) operation.abort()
    }
  }, [sessionId])
  const create = async () => {
    if (!target.workspaceId || !target.workspaceRevision || creatingRef.current)
      return
    const owner = generation.current
    creatingRef.current = true
    setCreating(true)
    try {
      const terminal = terminalDescriptorSchema.parse(
        await request('', 'POST', {
          expectedWorkspaceId: target.workspaceId,
          expectedWorkspaceRevision: target.workspaceRevision,
        }),
      )
      if (owner !== generation.current) return
      if (terminal.sessionId !== sessionId)
        throw Error('Terminal session owner changed')
      listing.current += 1
      setTerminals((items) => [
        ...items.filter((item) => item.id !== terminal.id),
        terminal,
      ])
      setActiveId(terminal.id)
      setError(undefined)
    } catch (cause) {
      if (owner === generation.current)
        setError(
          cause instanceof Error ? cause.message : 'Could not create terminal',
        )
    } finally {
      if (owner === generation.current) {
        creatingRef.current = false
        setCreating(false)
      }
    }
  }
  const close = async (terminal: TerminalDescriptor) => {
    const owner = generation.current
    try {
      await request(`/${encodeURIComponent(terminal.id)}`, 'DELETE')
      if (owner !== generation.current) return
      listing.current += 1
      setTerminals((items) => items.filter((item) => item.id !== terminal.id))
      setActiveId((current) =>
        current === terminal.id
          ? terminals.find((item) => item.id !== terminal.id)?.id
          : current,
      )
    } catch (cause) {
      if (owner === generation.current)
        setError(
          cause instanceof Error ? cause.message : 'Terminal cleanup failed',
        )
    }
  }
  const rename = async (terminal: TerminalDescriptor) => {
    const owner = generation.current
    try {
      const updated = terminalDescriptorSchema.parse(
        await request(`/${encodeURIComponent(terminal.id)}`, 'PATCH', {
          title,
        }),
      )
      if (owner !== generation.current) return
      listing.current += 1
      setTerminals((items) =>
        items.map((item) => (item.id === terminal.id ? updated : item)),
      )
      setRenaming(undefined)
    } catch (cause) {
      if (owner === generation.current)
        setError(
          cause instanceof Error ? cause.message : 'Terminal rename failed',
        )
    }
  }
  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col bg-black"
      aria-label="Terminal surface"
    >
      <div className="flex min-h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-background px-2 text-foreground">
        {terminals.some((terminal) => terminal.id !== renaming) && (
          <div
            role="tablist"
            className="contents"
            aria-label="Terminal tabs"
            aria-owns={terminals
              .filter((terminal) => terminal.id !== renaming)
              .map((terminal) => `${tabPrefix}-${terminal.id}`)
              .join(' ')}
          />
        )}
        {terminals.map((terminal, index) => (
          <div key={terminal.id} className="flex shrink-0 items-center">
            {renaming === terminal.id ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  void rename(terminal)
                }}
              >
                <input
                  aria-label="Terminal title"
                  autoFocus
                  className="w-32 bg-background px-2 text-sm"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setRenaming(undefined)
                  }}
                />
              </form>
            ) : (
              <button
                role="tab"
                id={`${tabPrefix}-${terminal.id}`}
                tabIndex={terminal.id === activeId ? 0 : -1}
                aria-selected={terminal.id === activeId}
                className="pointer-coarse:min-h-11 px-3 text-xs"
                title="Double-click or press F2 to rename. Alt+Left/Right reorders."
                onClick={() => setActiveId(terminal.id)}
                onDoubleClick={() => {
                  setRenaming(terminal.id)
                  setTitle(terminal.title)
                }}
                onKeyDown={(event) => {
                  if (
                    !event.altKey &&
                    ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(
                      event.key,
                    )
                  ) {
                    event.preventDefault()
                    const next =
                      event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? terminals.length - 1
                          : (index +
                              (event.key === 'ArrowLeft' ? -1 : 1) +
                              terminals.length) %
                            terminals.length
                    setActiveId(terminals[next].id)
                    document
                      .getElementById(`${tabPrefix}-${terminals[next].id}`)
                      ?.focus()
                  }
                  if (event.key === 'F2') {
                    event.preventDefault()
                    setRenaming(terminal.id)
                    setTitle(terminal.title)
                  }
                  if (
                    event.altKey &&
                    (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
                  ) {
                    event.preventDefault()
                    const next = index + (event.key === 'ArrowLeft' ? -1 : 1)
                    if (next >= 0 && next < terminals.length)
                      setTerminals((items) => {
                        const result = [...items]
                        ;[result[index], result[next]] = [
                          result[next],
                          result[index],
                        ]
                        return result
                      })
                  }
                }}
              >
                {terminal.title}
              </button>
            )}
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
          disabled={
            !target.workspaceId || !target.workspaceRevision || creating
          }
          onClick={() => void create()}
          aria-label="Create terminal"
        >
          <Plus size={16} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="pointer-coarse:size-11"
          onClick={() => void load()}
          aria-label="Reconnect terminals"
        >
          <RefreshCw size={15} />
        </Button>
      </div>
      {error && (
        <div
          role="alert"
          className="shrink-0 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {error}
        </div>
      )}
      {!target.cwd ? (
        <p className="p-6 text-sm text-muted-foreground">
          No workspace is attached to this session.
        </p>
      ) : !active ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
          <p>No terminal is open.</p>
          <Button
            variant="outline"
            onClick={() => void create()}
            disabled={
              creating || !target.workspaceId || !target.workspaceRevision
            }
          >
            Open terminal
          </Button>
        </div>
      ) : (
        <>
          <TerminalView
            key={`${sessionId}:${active.id}:${revision}`}
            sessionId={sessionId}
            terminal={active}
            onError={setError}
            onDescriptor={(updated) =>
              setTerminals((items) =>
                items.map((item) => (item.id === updated.id ? updated : item)),
              )
            }
          />
          {active.state !== 'running' && (
            <p
              role="status"
              className="shrink-0 px-3 py-1 text-xs text-muted-foreground"
            >
              Terminal {active.state}
              {active.exitCode !== null ? ` (${active.exitCode})` : ''}
              {active.cleanup === 'unknown' ? '. Cleanup is unconfirmed.' : ''}
            </p>
          )}
        </>
      )}
    </section>
  )
}
