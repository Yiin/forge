import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from '@tanstack/react-router'
import {
  Check,
  Copy,
  File,
  FolderPlus,
  Moon,
  Play,
  Search,
  Settings,
  Sun,
  Plus,
} from 'lucide-react'
import { toast } from 'sonner'
import { useShellStore } from '../../stores/shell'
import { useSessionsStore } from '../../stores/sessions'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '../ui/command'
import { Dialog } from '../ui/dialog'
import { openProjectCreation } from '../ProjectCreationDialog'
import { messageHitUrl, runHitUrl, searchUrl } from './palette-logic'
import { parseSnippet } from '../search/search-logic'
import { registerShortcuts, shortcutCommands } from '../../lib/shortcuts'
import { openNewDraft } from '../../lib/draft-entry'
type SearchResult = {
  sessions: Array<{ sessionId: string; title: string; snippet: string }>
  messages: Array<{
    sessionId: string
    seq: number
    snippet: string
    sessionTitle: string
  }>
  runs: Array<{ runId: string; title: string; snippet: string; status: string }>
}
export function CommandPalette() {
  const navigate = useNavigate()
  const location = useLocation()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [changedAt, setChangedAt] = useState(0)
  const [results, setResults] = useState<SearchResult>({
    sessions: [],
    messages: [],
    runs: [],
  })
  const [searchState, setSearchState] = useState<
    'idle' | 'loading' | 'success' | 'error'
  >('idle')
  const request = useRef<AbortController | null>(null)
  const [shortcutHelp, setShortcutHelp] = useState(false)
  const sessions = useSessionsStore((state) => state.sessions)
  const projects = useMemo(
    () => new Set(sessions.map((session) => session.projectId).filter(Boolean)),
    [sessions],
  )
  const sessionId = location.pathname.match(/^\/s\/([^/]+)/)?.[1]
  useEffect(
    () =>
      registerShortcuts({
        'palette.open': () => setOpen(true),
        'help.shortcuts': () => {
          setShortcutHelp(true)
          setOpen(true)
        },
      }),
    [],
  )
  useEffect(() => {
    request.current?.abort()
    if (!query.trim()) {
      setResults({ sessions: [], messages: [], runs: [] })
      setSearchState('idle')
      return
    }
    setSearchState('loading')
    const controller = new AbortController()
    request.current = controller
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/search?scope=all&limit=5&q=${encodeURIComponent(query.trim())}`,
          { signal: controller.signal },
        )
        if (!response.ok) throw new Error('Search request failed')
        if (request.current === controller) {
          setResults((await response.json()) as SearchResult)
          setSearchState('success')
        }
      } catch (error) {
        if (
          (error as Error).name !== 'AbortError' &&
          request.current === controller
        ) {
          setResults({ sessions: [], messages: [], runs: [] })
          setSearchState('error')
        }
      }
    }, 150)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [query, changedAt])
  const close = () => {
    setOpen(false)
    setQuery('')
    setResults({ sessions: [], messages: [], runs: [] })
    setSearchState('idle')
    setShortcutHelp(false)
  }
  const go = (to: string) => {
    close()
    void navigate({ to: to as never })
  }
  const newDraft = () => {
    close()
    void openNewDraft(navigate).catch(() => undefined)
  }
  const copySession = async () => {
    if (!sessionId) return
    await navigator.clipboard.writeText(sessionId)
    toast.success('Session ID copied')
    close()
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Command
        loop
        shouldFilter={!results.messages.length && !results.runs.length}
      >
        <CommandInput
          value={query}
          onValueChange={(value: string) => {
            setQuery(value)
            setChangedAt(Date.now())
          }}
          placeholder="Search actions, sessions, and messages…"
          autoFocus
        />
        <CommandList>
          <CommandEmpty>No matching commands.</CommandEmpty>
          <CommandGroup heading="Actions">
            <CommandItem onSelect={newDraft}>
              <Plus />
              New session{projects.size > 1 ? ' in a project' : ''}
            </CommandItem>
            <CommandItem
              onSelect={() => {
                close()
                openProjectCreation()
              }}
            >
              <FolderPlus />
              New project
            </CommandItem>
            <CommandItem onSelect={() => go('/runs')}>
              <Play />
              Go to Runs
            </CommandItem>
            <CommandItem onSelect={() => go('/files')}>
              <File />
              Go to Files
            </CommandItem>
            <CommandItem onSelect={() => go('/settings')}>
              <Settings />
              Go to Settings
            </CommandItem>
            <CommandItem
              onSelect={() => {
                useShellStore.getState().toggleTheme()
                close()
              }}
            >
              {useShellStore.getState().theme === 'dark' ? <Sun /> : <Moon />}
              Toggle theme
            </CommandItem>
            {sessionId && (
              <CommandItem onSelect={() => void copySession()}>
                <Copy />
                Copy current session id
              </CommandItem>
            )}
          </CommandGroup>
          {shortcutHelp && (
            <CommandGroup heading="Keyboard shortcuts" forceMount>
              {shortcutCommands().map((command) => (
                <CommandItem
                  key={command.id}
                  value={`${command.label} ${command.ariaKeyshortcuts}`}
                >
                  <kbd>{command.ariaKeyshortcuts}</kbd>
                  {command.label}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          <CommandGroup heading="Sessions">
            {sessions.map((session) => (
              <CommandItem
                key={session.id}
                value={`${session.title} ${session.id}`}
                onSelect={() => go(`/s/${session.id}`)}
              >
                <Search />
                {session.title || 'Untitled session'}
              </CommandItem>
            ))}
          </CommandGroup>
          {query.trim() && searchState === 'loading' && (
            <CommandGroup heading="Search status" forceMount>
              <CommandItem disabled>Searching…</CommandItem>
            </CommandGroup>
          )}
          {query.trim() && searchState === 'error' && (
            <CommandGroup heading="Search status" forceMount>
              <CommandItem disabled role="alert">
                Search is unavailable. Commands remain available.
              </CommandItem>
              <CommandItem onSelect={() => setChangedAt(Date.now())}>
                Try search again
              </CommandItem>
            </CommandGroup>
          )}
          {(results.messages.length > 0 || results.runs.length > 0) && (
            <CommandGroup heading="Search results" forceMount>
              {results.messages.map((hit) => (
                <CommandItem
                  key={`message-${hit.sessionId}-${hit.seq}`}
                  value={hit.snippet}
                  onSelect={() => go(messageHitUrl(hit.sessionId, hit.seq))}
                >
                  <Search />
                  <span>
                    {parseSnippet(hit.snippet).map((segment, index) =>
                      segment.highlighted ? (
                        <mark key={index}>{segment.text}</mark>
                      ) : (
                        <span key={index}>{segment.text}</span>
                      ),
                    )}
                  </span>
                </CommandItem>
              ))}
              {results.runs.map((hit) => (
                <CommandItem
                  key={`run-${hit.runId}`}
                  value={hit.title}
                  onSelect={() => go(runHitUrl(hit.runId))}
                >
                  <Play />
                  {hit.title}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {query.trim() && (
            <>
              <CommandSeparator />
              <CommandItem
                value="search everywhere"
                onSelect={() => go(searchUrl(query.trim()))}
              >
                <Check />
                Search everywhere for “{query.trim()}”
              </CommandItem>
            </>
          )}
        </CommandList>
      </Command>
    </Dialog>
  )
}
