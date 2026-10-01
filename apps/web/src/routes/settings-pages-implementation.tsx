import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { AlertCircle } from 'lucide-react'
import { api } from '../lib/api'
import { useShellStore } from '../stores/shell'
import { useSettingsStore } from '../stores/settings'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { SettingsPage } from '../components/settings/settings-layout'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { Spinner } from '@/components/ui/spinner'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { openProjectCreation } from '../components/ProjectCreationDialog'
import {
  displayShortcut,
  setShortcutOverrides,
  shortcutDefault,
  shortcutKey,
  shortcutDefinitions,
  type ShortcutId,
} from '../lib/shortcuts'

export function ErrorRow({
  children,
  onRetry,
}: {
  children: ReactNode
  onRetry?: () => void
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-2 text-sm text-destructive"
      role="alert"
    >
      <AlertCircle className="size-4 shrink-0" />
      <span>{children}</span>
      {onRetry && (
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0 text-destructive"
          onClick={onRetry}
        >
          Retry
        </Button>
      )}
    </div>
  )
}

function RequestState({
  state,
  error,
  onRetry,
}: {
  state: 'loading' | 'saving' | 'saved' | 'error'
  error?: string | null
  onRetry?: () => void
}) {
  if (state === 'loading')
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (state === 'saving')
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Saving…
      </p>
    )
  if (state === 'saved')
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Saved.
      </p>
    )
  return (
    <ErrorRow onRetry={onRetry}>
      Could not load or save{error ? `: ${error}` : '.'}
    </ErrorRow>
  )
}

export function GeneralSettings() {
  const shellTheme = useShellStore((state) => state.theme)
  const setShellTheme = useShellStore((state) => state.setTheme)
  const settingsState = useSettingsStore((state) => state.scopes.general)
  const load = useSettingsStore((state) => state.load)
  const retry = useSettingsStore((state) => state.retry)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [about, setAbout] = useState<{
    version?: string
    bootId?: string
    uptimeSec?: number
  }>({})
  const [aboutState, setAboutState] = useState<'loading' | 'saved' | 'error'>(
    'loading',
  )
  const [aboutError, setAboutError] = useState<string | null>(null)
  useEffect(() => {
    void load()
      .catch((cause: unknown) =>
        setLoadError(cause instanceof Error ? cause.message : String(cause)),
      )
      .finally(() => setLoading(false))
  }, [load])
  const loadAbout = () => {
    setAboutState('loading')
    setAboutError(null)
    void fetch('/api/status')
      .then((response) => {
        if (!response.ok)
          throw new Error(`Status request failed (${response.status})`)
        return response.json()
      })
      .then((value) => {
        setAbout(value as typeof about)
        setAboutState('saved')
      })
      .catch((cause: unknown) => {
        setAboutError(cause instanceof Error ? cause.message : String(cause))
        setAboutState('error')
      })
  }
  useEffect(loadAbout, [])
  const restoreDefaults = async () => {
    setShellTheme('system')
  }
  return (
    <SettingsPage
      title="General"
      subtitle="Preferences for your Forge workspace."
    >
      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {loadError && <ErrorRow>Could not load: {loadError}</ErrorRow>}
      {!loading && !loadError && settingsState.status !== 'idle' && (
        <RequestState
          state={
            settingsState.status === 'dirty' ? 'saving' : settingsState.status
          }
          error={settingsState.error}
          onRetry={
            settingsState.status === 'error'
              ? () => void retry('general')
              : undefined
          }
        />
      )}
      <SettingsSection
        title="Workspace preferences"
        description="Changes apply to this Forge workspace."
        footer={
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRestoreOpen(true)}
          >
            Restore defaults
          </Button>
        }
      >
        <SettingsRow
          label="Theme"
          description="Choose the color theme for Forge."
          reset={
            shellTheme !== 'system' && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShellTheme('system')}
              >
                Reset
              </Button>
            )
          }
        >
          <Select
            value={shellTheme}
            items={{ system: 'System', light: 'Light', dark: 'Dark' }}
            onValueChange={(value) => {
              if (value === 'system' || value === 'light' || value === 'dark')
                setShellTheme(value)
            }}
          >
            <SelectTrigger className="w-36" aria-label="Theme">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">System</SelectItem>
              <SelectItem value="light">Light</SelectItem>
              <SelectItem value="dark">Dark</SelectItem>
            </SelectContent>
          </Select>
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title="About" description="Forge runtime information.">
        {/* About only reads /api/status, so the success state has nothing to
            report: showing "Saved." here would be wrong and leaves a gap. */}
        {aboutState !== 'saved' && (
          <RequestState
            state={aboutState}
            error={aboutError}
            onRetry={loadAbout}
          />
        )}
        <SettingsRow label="Version" description="The running Forge version.">
          <code className="font-mono text-sm">
            {about.version ?? 'unknown'}
          </code>
        </SettingsRow>
        <SettingsRow
          label="Boot ID"
          description="The identifier for this server start."
        >
          <code className="font-mono text-sm">{about.bootId ?? 'unknown'}</code>
        </SettingsRow>
        <SettingsRow
          label="Uptime"
          description="Time since the server started."
        >
          <span className="text-sm">{about.uptimeSec ?? 0}s</span>
        </SettingsRow>
        <p className="text-sm text-muted-foreground">
          Updates will be available through the release pipeline.
        </p>
      </SettingsSection>
      <ConfirmDialog
        open={restoreOpen}
        onOpenChange={setRestoreOpen}
        onConfirm={restoreDefaults}
        title="Restore General defaults"
        confirmLabel="Restore defaults"
      >
        This restores the theme and title generation settings. Other settings
        stay unchanged.
      </ConfirmDialog>
    </SettingsPage>
  )
}

export function ProjectSettings() {
  const [projects, setProjects] = useState<
    Array<{
      id: string
      name: string
      path: string
      archived_at?: number | null
    }>
  >([])
  const [loadState, setLoadState] = useState<'loading' | 'saved' | 'error'>(
    'loading',
  )
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [saveState, setSaveState] = useState<Record<string, 'saved' | 'error'>>(
    {},
  )
  const [archiveProject, setArchiveProject] = useState<
    (typeof projects)[number] | null
  >(null)
  const [archiveError, setArchiveError] = useState<string | null>(null)
  const [worktrees, setWorktrees] = useState<
    Record<
      string,
      Array<{
        path: string
        branch: string | null
        dirty: boolean
        activeSession: boolean
      }>
    >
  >({})
  const [worktreeState, setWorktreeState] = useState<
    Record<string, 'loading' | 'error' | 'ready'>
  >({})
  const [removing, setRemoving] = useState<string | null>(null)
  const [worktreeError, setWorktreeError] = useState<string | null>(null)
  const load = () => {
    setLoadState('loading')
    void api
      .listSettingsProjects()
      .then((value) => {
        const nextProjects = value as typeof projects
        setProjects(nextProjects)
        setLoadState('saved')
        for (const project of nextProjects) void loadWorktrees(project.id)
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
        setLoadState('error')
      })
  }
  useEffect(load, [])
  return (
    <SettingsPage
      title="Projects"
      subtitle="Rename or archive projects. Sessions stay safe when you archive one."
    >
      <div className="mb-6">
        <Button onClick={openProjectCreation}>Add project</Button>
      </div>
      {loadState === 'loading' && <RequestState state="loading" />}
      {loadState === 'error' && (
        <RequestState state="error" error={error} onRetry={load} />
      )}
      <div className="flex flex-col gap-6">
        {projects.map((project) => (
          <SettingsSection key={project.id} title={project.name}>
            <SettingsRow label="Name" description="The project display name.">
              <Input
                aria-label={`${project.name} name`}
                value={project.name}
                onChange={(event) =>
                  setProjects((all) =>
                    all.map((item) =>
                      item.id === project.id
                        ? { ...item, name: event.target.value }
                        : item,
                    ),
                  )
                }
                onBlur={() => void renameProject(project)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    event.currentTarget.blur()
                  }
                }}
              />
              {saveState[project.id] === 'saved' && (
                <span className="text-sm text-muted-foreground" role="status">
                  Saved.
                </span>
              )}
              {saveState[project.id] === 'error' && (
                <span
                  className="flex items-center gap-2 text-sm text-destructive"
                  role="alert"
                >
                  Could not save.
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-destructive"
                    onClick={() => void renameProject(project)}
                  >
                    Retry
                  </Button>
                </span>
              )}
            </SettingsRow>
            <SettingsRow
              label="Path"
              description="The selected project folder."
            >
              <span className="text-sm text-muted-foreground">
                {project.path}
              </span>
            </SettingsRow>
            <SettingsRow
              label="State"
              description="Archived projects cannot start new work."
            >
              <Button
                variant="outline"
                size="sm"
                disabled={Boolean(project.archived_at) || saving[project.id]}
                aria-busy={saving[project.id] || undefined}
                onClick={() => {
                  setArchiveError(null)
                  setArchiveProject(project)
                }}
              >
                {saving[project.id] && <Spinner className="size-4" />}
                {project.archived_at ? 'Archived' : 'Archive'}
              </Button>
            </SettingsRow>
            <SettingsRow
              label="Session worktrees"
              description="Worktrees created for sessions. Remove them only when no session uses them."
            >
              <div className="w-full space-y-2">
                {worktreeState[project.id] === 'loading' && (
                  <p className="text-sm text-muted-foreground">Loading…</p>
                )}
                {worktreeState[project.id] === 'error' && (
                  <ErrorRow onRetry={() => void loadWorktrees(project.id)}>
                    Could not load worktrees.
                  </ErrorRow>
                )}
                {worktreeState[project.id] === 'ready' &&
                  worktrees[project.id]?.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                      No session worktrees.
                    </p>
                  )}
                {worktrees[project.id]?.map((worktree) => (
                  <div
                    key={worktree.path}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {worktree.branch ?? 'Detached worktree'}
                      </p>
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        {worktree.path}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {worktree.activeSession
                          ? 'Active session uses this worktree.'
                          : worktree.dirty
                            ? 'Uncommitted changes.'
                            : 'Clean.'}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={
                        worktree.activeSession || removing === worktree.path
                      }
                      aria-label={`Remove worktree ${worktree.branch ?? worktree.path}`}
                      onClick={() =>
                        void removeWorktree(project.id, worktree.path)
                      }
                    >
                      {removing === worktree.path && (
                        <Spinner className="size-4" />
                      )}
                      Remove
                    </Button>
                  </div>
                ))}
              </div>
            </SettingsRow>
          </SettingsSection>
        ))}
      </div>
      {loadState === 'saved' && projects.length === 0 && (
        <p className="text-sm text-muted-foreground">No projects yet.</p>
      )}
      {archiveError && (
        <ErrorRow>Could not archive project: {archiveError}</ErrorRow>
      )}
      {worktreeError && <ErrorRow>{worktreeError}</ErrorRow>}
      <ConfirmDialog
        open={archiveProject !== null}
        onOpenChange={(open) => {
          if (!open) setArchiveProject(null)
        }}
        title="Archive project?"
        confirmLabel="Archive"
        onConfirm={async () => {
          if (!archiveProject) return
          try {
            await api.archiveProjectById(archiveProject.id)
            setProjects((all) =>
              all.map((project) =>
                project.id === archiveProject.id
                  ? { ...project, archived_at: Date.now() }
                  : project,
              ),
            )
            setArchiveProject(null)
          } catch (cause: unknown) {
            setArchiveError(
              cause instanceof Error ? cause.message : String(cause),
            )
            throw cause
          }
        }}
      >
        {archiveProject
          ? `${archiveProject.name} will be archived. Sessions will be kept.`
          : ''}
      </ConfirmDialog>
    </SettingsPage>
  )

  async function renameProject(project: (typeof projects)[number]) {
    const name = project.name.trim()
    if (!name) return
    setSaving((current) => ({ ...current, [project.id]: true }))
    setSaveState((current) => {
      const next = { ...current }
      delete next[project.id]
      return next
    })
    try {
      await api.renameProject(project.id, name)
      setProjects((all) =>
        all.map((item) => (item.id === project.id ? { ...item, name } : item)),
      )
      setSaveState((current) => ({ ...current, [project.id]: 'saved' }))
    } catch {
      setSaveState((current) => ({ ...current, [project.id]: 'error' }))
    } finally {
      setSaving((current) => ({ ...current, [project.id]: false }))
    }
  }

  async function loadWorktrees(projectId: string) {
    setWorktreeState((current) => ({ ...current, [projectId]: 'loading' }))
    try {
      const value = (await api.listWorktrees(projectId)) as {
        worktrees: Array<{
          path: string
          branch: string | null
          dirty: boolean
          activeSession: boolean
        }>
      }
      setWorktrees((current) => ({ ...current, [projectId]: value.worktrees }))
      setWorktreeState((current) => ({ ...current, [projectId]: 'ready' }))
    } catch {
      setWorktreeState((current) => ({ ...current, [projectId]: 'error' }))
    }
  }

  async function removeWorktree(projectId: string, path: string) {
    setRemoving(path)
    setWorktreeError(null)
    try {
      await api.removeWorktree(projectId, { path })
      setWorktrees((current) => ({
        ...current,
        [projectId]:
          current[projectId]?.filter((worktree) => worktree.path !== path) ??
          [],
      }))
    } catch (cause: unknown) {
      setWorktreeError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRemoving(null)
    }
  }
}

export function KeybindingsSettings() {
  const load = useSettingsStore((state) => state.load)
  const save = useSettingsStore((state) => state.save)
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [capture, setCapture] = useState<string | null>(null)
  const [captureError, setCaptureError] = useState<string | null>(null)
  useEffect(() => {
    void load().then(() => {
      const value = useSettingsStore.getState().settings.keybindings
      setDraft(value)
      setShortcutOverrides(value)
    })
  }, [load])
  const commands = shortcutDefinitions.map(([id, , label]) => ({
    id,
    label,
    key: shortcutKey(id),
  }))
  const visible = commands.filter((command) =>
    `${command.label} ${command.key} ${displayShortcut(command.key)}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  )
  const commit = (id: string, value?: string) => {
    const next = { ...draft }
    if (value && value !== shortcutDefault(id as ShortcutId)) next[id] = value
    else delete next[id]
    setDraft(next)
    setShortcutOverrides(next)
    void save('general', { keybindings: next }).catch(() => undefined)
  }
  const captureKey = (event: KeyboardEvent) => {
    if (!capture) return
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') {
      setCapture(null)
      return
    }
    if (['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) return
    const parts = [
      event.ctrlKey || event.metaKey ? 'mod' : '',
      event.altKey ? 'alt' : '',
      event.shiftKey ? 'shift' : '',
      event.key.toLowerCase(),
    ].filter(Boolean)
    const value = parts.join('+')
    if (/^mod\+[1-9]$/.test(value)) {
      setCaptureError('Browser-owned numeric shortcuts cannot be changed.')
      return
    }
    const conflict = commands.find(
      (item) => item.id !== capture && item.key === value,
    )
    if (conflict) {
      setCaptureError(`Conflicts with ${conflict.label}.`)
      return
    }
    commit(capture, value)
    setCapture(null)
  }
  return (
    <SettingsPage
      title="Keybindings"
      subtitle="Shortcuts for common Forge actions."
    >
      <SettingsSection
        title="Keyboard shortcuts"
        description="Search, edit, or restore shortcuts."
        footer={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setDraft({})
              setShortcutOverrides({})
              void save('general', { keybindings: {} }).catch(() => undefined)
            }}
          >
            Restore all defaults
          </Button>
        }
      >
        <Input
          aria-label="Search keybindings"
          placeholder="Search commands or shortcuts"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {captureError && <ErrorRow>{captureError}</ErrorRow>}
        {visible.map((command) => (
          <SettingsRow
            key={command.id}
            label={command.label}
            description={
              command.key === shortcutDefault(command.id as ShortcutId)
                ? 'Default shortcut'
                : 'Custom shortcut'
            }
          >
            {capture === command.id ? (
              <Input
                autoFocus
                className="w-48"
                aria-label={`Capture shortcut for ${command.label}`}
                onKeyDown={captureKey}
                placeholder="Press a key combination"
                readOnly
              />
            ) : (
              <Kbd aria-keyshortcuts={displayShortcut(command.key)}>
                {displayShortcut(command.key)}
              </Kbd>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setCapture(command.id)
                setCaptureError(null)
              }}
            >
              {capture === command.id ? 'Capturing…' : 'Edit'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => commit(command.id)}
            >
              Reset
            </Button>
          </SettingsRow>
        ))}
        {!visible.length && (
          <p className="text-sm text-muted-foreground">
            No matching shortcuts.
          </p>
        )}
      </SettingsSection>
    </SettingsPage>
  )
}

export function SettingsSection({
  title,
  description,
  children,
  footer,
  headerAction,
}: {
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
  headerAction?: ReactNode
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">{title}</CardTitle>
            {description && <CardDescription>{description}</CardDescription>}
          </div>
          {headerAction}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col divide-y divide-border p-0 [&>*]:px-6 [&>*]:py-3">
        {children}
      </CardContent>
      {footer && (
        <CardFooter className="justify-end gap-2 border-t pt-6">
          {footer}
        </CardFooter>
      )}
    </Card>
  )
}

export function SettingsRow({
  label,
  description,
  status,
  children,
  reset,
}: {
  label: string
  description?: string
  status?: ReactNode
  children: ReactNode
  reset?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="flex flex-none flex-wrap items-center justify-end gap-2">
        {children}
        {status}
        {reset}
      </div>
    </div>
  )
}

export { SettingsPage }
