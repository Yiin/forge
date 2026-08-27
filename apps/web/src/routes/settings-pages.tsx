import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { AlertCircle, ArrowLeft, Eye, EyeOff, X } from 'lucide-react'
import { harnessConfigSchema, type HarnessConfig } from '@forge/protocol/config'
import { api } from '../lib/api'
import { useShellStore } from '../stores/shell'
import { useSettingsStore } from '../stores/settings'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { validateEpicDefaults, type EpicDefaults } from './epic-settings-logic'
import { openProjectCreation } from '../components/ProjectCreationDialog'
import {
  displayShortcut,
  setShortcutOverrides,
  shortcutDefault,
  shortcutKey,
  shortcutDefinitions,
  type ShortcutId,
} from '../lib/shortcuts'

type Harness = HarnessConfig

function ErrorRow({
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

const defaultGeneralSettings = { titleGeneration: true }

export function GeneralSettings() {
  const shellTheme = useShellStore((state) => state.theme)
  const setShellTheme = useShellStore((state) => state.setTheme)
  const settings = useSettingsStore((state) => state.settings)
  const settingsState = useSettingsStore((state) => state.scopes.general)
  const load = useSettingsStore((state) => state.load)
  const save = useSettingsStore((state) => state.save)
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
  const commit = (patch: { titleGeneration: boolean }) => {
    void save('general', patch).catch(() => undefined)
  }
  const resetTitleGeneration = () => commit(defaultGeneralSettings)
  const restoreDefaults = async () => {
    setShellTheme('system')
    resetTitleGeneration()
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
        <SettingsRow
          label="Plain-word titles"
          description="Generate simple words for new session titles."
          reset={
            settings.titleGeneration !==
              defaultGeneralSettings.titleGeneration && (
              <Button variant="ghost" size="sm" onClick={resetTitleGeneration}>
                Reset
              </Button>
            )
          }
        >
          <Switch
            checked={settings.titleGeneration}
            aria-label="Generate plain-word session titles"
            onCheckedChange={(checked) => commit({ titleGeneration: checked })}
          />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title="About" description="Forge runtime information.">
        <RequestState
          state={aboutState}
          error={aboutError}
          onRetry={loadAbout}
        />
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

export function HarnessSettings() {
  const [draft, setDraft] = useState<Record<string, Harness>>({})
  const [results, setResults] = useState<Record<string, string>>({})
  const [saveState, setSaveState] = useState<
    Record<string, 'loading' | 'dirty' | 'saving' | 'saved' | 'error'>
  >({})
  const [saveError, setSaveError] = useState<Record<string, string | null>>({})
  const [testing, setTesting] = useState<Record<string, boolean>>({})
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const [deleteKey, setDeleteKey] = useState<string | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  const saveQueue = useRef<Record<string, Promise<void>>>({})
  useEffect(() => {
    void api
      .listHarnesses()
      .then((value) => {
        setDraft(value as Record<string, Harness>)
        setSaveState(
          Object.fromEntries(Object.keys(value).map((key) => [key, 'saved'])),
        )
      })
      .catch((error: unknown) => {
        setSaveError({
          _page: error instanceof Error ? error.message : String(error),
        })
      })
  }, [])
  const update = (key: string, patch: Partial<Harness>) => {
    setDraft((current) => ({
      ...current,
      [key]: { ...current[key], ...patch },
    }))
    setSaveState((current) => ({ ...current, [key]: 'dirty' }))
    setSaveError((current) => ({ ...current, [key]: null }))
  }
  const saveDraft = (next: Record<string, Harness>, key: string) => {
    const parsed = Object.fromEntries(
      Object.entries(next).map(([key, value]) => [
        key,
        harnessConfigSchema.safeParse(value),
      ]),
    )
    const invalid = Object.values(parsed).find((result) => !result.success)
    if (invalid && !invalid.success) {
      setSaveError((current) => ({
        ...current,
        [key]: invalid.error.issues[0]?.message ?? 'Invalid harness',
      }))
      setSaveState((current) => ({ ...current, [key]: 'error' }))
      return
    }
    const snapshot = Object.fromEntries(
      Object.entries(parsed).map(([key, result]) => [
        key,
        result.success ? result.data : undefined,
      ]),
    ) as Record<string, Harness>
    setSaveState((current) => ({ ...current, [key]: 'saving' }))
    setSaveError((current) => ({ ...current, [key]: null }))
    saveQueue.current[key] = (saveQueue.current[key] ?? Promise.resolve())
      .then(() => api.saveHarnesses(snapshot))
      .then(() => setSaveState((current) => ({ ...current, [key]: 'saved' })))
      .catch((error: unknown) => {
        setSaveError((current) => ({
          ...current,
          [key]: error instanceof Error ? error.message : String(error),
        }))
        setSaveState((current) => ({ ...current, [key]: 'error' }))
      })
  }
  const save = (key: string) => {
    if (draft[key]) saveDraft(draft, key)
  }
  const validationError = (value: Harness) => {
    const parsed = harnessConfigSchema.safeParse(value)
    return parsed.success
      ? null
      : (parsed.error.issues[0]?.message ??
          'Enter a valid harness configuration.')
  }
  const formatResult = (result: unknown) => {
    if (!result || typeof result !== 'object') return String(result)
    const value = result as {
      ok?: boolean
      agentName?: string | null
      stderrTail?: string
      capabilities?: Record<string, unknown>
    }
    if (!value.ok) return `Failed\n${value.stderrTail ?? 'Unknown error'}`
    const capabilities = Object.entries(value.capabilities ?? {})
      .map(([key, enabled]) => `${key}: ${enabled ? 'yes' : 'no'}`)
      .join('\n')
    return [
      'Connection succeeded',
      value.agentName ? `Agent: ${value.agentName}` : null,
      capabilities ? `Capabilities:\n${capabilities}` : null,
    ]
      .filter(Boolean)
      .join('\n')
  }
  const add = () => {
    const key = `harness-${Object.keys(draft).length + 1}`
    setDraft((current) => ({
      ...current,
      [key]: {
        name: 'New harness',
        command: '',
        args: [],
        env: {},
        protocol: 'acp',
        enabled: true,
      },
    }))
    setSaveState((current) => ({ ...current, [key]: 'dirty' }))
  }
  const confirmDelete = async () => {
    if (!deleteKey) return
    const next = { ...draft }
    delete next[deleteKey]
    await api.saveHarnesses(next)
    setDraft((current) => {
      const next = { ...current }
      delete next[deleteKey]
      return next
    })
    setSaveState((current) => ({ ...current, [deleteKey]: 'saved' }))
    setDeleteKey(null)
  }
  return (
    <SettingsPage
      title="Harnesses"
      subtitle="A harness is a command and its runtime settings."
    >
      <div className="flex flex-col gap-6">
        {Object.values(saveState).some((state) => state === 'loading') && (
          <p className="text-sm text-muted-foreground" role="status">
            Loading harnesses…
          </p>
        )}
        {Object.entries(draft).map(([key, value]) => (
          <Card key={key}>
            <CardHeader>
              <CardTitle className="text-base">{value.name || key}</CardTitle>
              <CardAction>
                <span className="text-xs text-muted-foreground" role="status">
                  {saveState[key] === 'dirty'
                    ? 'Unsaved changes'
                    : saveState[key] === 'saving'
                      ? 'Saving…'
                      : saveState[key] === 'error'
                        ? 'Error'
                        : 'Saved.'}
                </span>
              </CardAction>
            </CardHeader>
            <CardContent className="flex flex-col gap-6">
              <div className="flex flex-col gap-4">
                <Field>
                  <FieldLabel htmlFor={`${key}-name`}>Name</FieldLabel>
                  <Input
                    id={`${key}-name`}
                    value={value.name}
                    onChange={(event) =>
                      update(key, { name: event.target.value })
                    }
                  />
                  <FieldDescription>
                    A label shown in session controls.
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${key}-command`}>Command</FieldLabel>
                  <Input
                    id={`${key}-command`}
                    className="font-mono text-sm"
                    value={value.command}
                    onChange={(event) =>
                      update(key, { command: event.target.value })
                    }
                  />
                  <FieldDescription>
                    The executable Forge starts.
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${key}-args`}>Arguments</FieldLabel>
                  <Textarea
                    id={`${key}-args`}
                    className="font-mono text-sm"
                    value={value.args.join('\n')}
                    onChange={(e) =>
                      update(key, {
                        args: e.target.value.split('\n').filter(Boolean),
                      })
                    }
                  />
                  <FieldDescription>
                    Enter one argument per line.
                  </FieldDescription>
                </Field>
              </div>
              <fieldset className="rounded-md border p-3">
                <legend className="px-1 text-xs font-medium text-muted-foreground">
                  Environment variables
                </legend>
                <div className="flex flex-col gap-2">
                  {Object.entries(value.env).map(([name, envValue]) => (
                    <div
                      className="flex flex-wrap items-center gap-2"
                      key={name}
                    >
                      <Input
                        className="min-w-32 flex-1 font-mono text-sm"
                        aria-label="Environment variable name"
                        value={name}
                        placeholder="NAME"
                        autoCapitalize="characters"
                        autoComplete="off"
                        onChange={(event) => {
                          const next = { ...value.env }
                          delete next[name]
                          if (event.target.value)
                            next[event.target.value] = envValue
                          update(key, { env: next })
                        }}
                      />
                      <Input
                        className="min-w-32 flex-1 font-mono text-sm"
                        aria-label={`Value for ${name}`}
                        type={revealed[`${key}:${name}`] ? 'text' : 'password'}
                        value={envValue}
                        placeholder="Value"
                        autoComplete="new-password"
                        onChange={(event) =>
                          update(key, {
                            env: { ...value.env, [name]: event.target.value },
                          })
                        }
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={
                          revealed[`${key}:${name}`]
                            ? 'Hide value'
                            : 'Show value'
                        }
                        onClick={() =>
                          setRevealed((current) => ({
                            ...current,
                            [`${key}:${name}`]: !current[`${key}:${name}`],
                          }))
                        }
                      >
                        {revealed[`${key}:${name}`] ? (
                          <EyeOff className="size-4" />
                        ) : (
                          <Eye className="size-4" />
                        )}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove ${name}`}
                        onClick={() => {
                          const next = { ...value.env }
                          delete next[name]
                          update(key, { env: next })
                        }}
                      >
                        <X className="size-4" />
                      </Button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-fit"
                    onClick={() => {
                      let name = 'NEW_VARIABLE'
                      let suffix = 1
                      while (name in value.env)
                        name = `NEW_VARIABLE_${suffix++}`
                      update(key, { env: { ...value.env, [name]: '' } })
                    }}
                  >
                    Add variable
                  </Button>
                </div>
              </fieldset>
              <Field>
                <FieldLabel>Protocol</FieldLabel>
                <Select
                  value={value.protocol}
                  onValueChange={(selected) => {
                    if (selected === 'acp' || selected === 'pty') {
                      update(key, { protocol: selected })
                    }
                  }}
                >
                  <SelectTrigger
                    className="w-32"
                    aria-label={`${key} protocol`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="acp">ACP</SelectItem>
                    <SelectItem value="pty">PTY</SelectItem>
                  </SelectContent>
                </Select>
                <FieldDescription>
                  ACP uses structured messages. PTY uses terminal output.
                </FieldDescription>
              </Field>
              {results[key] && (
                <pre
                  className="max-h-40 overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap"
                  role="status"
                >
                  {results[key]}
                </pre>
              )}
              {validationError(value) && (
                <p
                  className="flex items-center gap-2 text-sm text-destructive"
                  role="alert"
                >
                  <AlertCircle className="size-4 shrink-0" />
                  {validationError(value)}
                </p>
              )}
            </CardContent>
            <CardFooter className="justify-between gap-2 border-t pt-6">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  onClick={() => save(key)}
                  disabled={Boolean(validationError(value))}
                >
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setResults((current) => ({ ...current, [key]: 'Testing…' }))
                    setTesting((current) => ({ ...current, [key]: true }))
                    void api
                      .testHarness(key, value)
                      .then((result) =>
                        setResults((current) => ({
                          ...current,
                          [key]: formatResult(result),
                        })),
                      )
                      .catch((error: unknown) =>
                        setResults((current) => ({
                          ...current,
                          [key]:
                            error instanceof Error
                              ? error.message
                              : String(error),
                        })),
                      )
                      .finally(() =>
                        setTesting((current) => ({ ...current, [key]: false })),
                      )
                  }}
                  disabled={
                    Boolean(validationError(value)) ||
                    testing[key] ||
                    saveState[key] === 'saving'
                  }
                >
                  {testing[key] && <Spinner className="size-4" />}
                  Test
                </Button>
              </div>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => setDeleteKey(key)}
              >
                Delete
              </Button>
            </CardFooter>
          </Card>
        ))}
      </div>
      {Object.entries(saveError)
        .filter(([, error]) => error)
        .map(([key, error]) => (
          <p
            className="mt-4 flex items-center gap-2 text-sm text-destructive"
            role="alert"
            key={key}
          >
            <AlertCircle className="size-4 shrink-0" />
            Could not save: {error}
          </p>
        ))}
      <div className="mt-6">
        <Button onClick={add}>Add harness</Button>
      </div>
      <AlertDialog
        open={deleteKey !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteKey(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete harness?</AlertDialogTitle>
            <AlertDialogDescription>
              Delete “{deleteKey ? draft[deleteKey]?.name || deleteKey : ''}”?
              Save the remaining harnesses to apply this change.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletePending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deletePending}
              onClick={async (event) => {
                event.preventDefault()
                setDeletePending(true)
                try {
                  await confirmDelete()
                } finally {
                  setDeletePending(false)
                }
              }}
            >
              {deletePending ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
  const load = () => {
    setLoadState('loading')
    void api
      .listSettingsProjects()
      .then((value) => {
        setProjects(value as typeof projects)
        setLoadState('saved')
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
          </SettingsSection>
        ))}
      </div>
      {loadState === 'saved' && projects.length === 0 && (
        <p className="text-sm text-muted-foreground">No projects yet.</p>
      )}
      {archiveError && (
        <ErrorRow>Could not archive project: {archiveError}</ErrorRow>
      )}
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
}

export function EpicSettings() {
  const initialDefaults: EpicDefaults = {
    workerCount: 3,
    mode: 'pool',
    rolePolicy: {
      roles: {
        'iteration-worker': 'default',
        'triage-control': 'default',
        'title-generation': 'default',
      },
      tiers: { default: [{ harness: 'claude-code-acp' }] },
    },
  }
  const [defaults, setDefaults] = useState<EpicDefaults>(initialDefaults)
  const [savedDefaults, setSavedDefaults] =
    useState<EpicDefaults>(initialDefaults)
  const [harnesses, setHarnesses] = useState<Record<string, { name: string }>>(
    {},
  )
  const [validationErrors, setValidationErrors] = useState<
    Record<string, string>
  >({})
  const [newTier, setNewTier] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const invalidRefs = useRef<Record<string, HTMLElement | null>>({})
  const settingsState = useSettingsStore((state) => state.scopes.epics)
  const load = useSettingsStore((state) => state.load)
  const saveSettings = useSettingsStore((state) => state.save)
  const retry = useSettingsStore((state) => state.retry)
  const dirty = JSON.stringify(defaults) !== JSON.stringify(savedDefaults)
  const setField = <K extends keyof EpicDefaults>(
    key: K,
    value: EpicDefaults[K],
  ) => setDefaults((current) => ({ ...current, [key]: value }))
  useEffect(() => {
    void Promise.all([load(), api.listHarnesses()])
      .then(([, available]) => {
        const value = useSettingsStore.getState().settings as {
          epicDefaults?: Partial<EpicDefaults>
        }
        const next = {
          ...initialDefaults,
          ...value.epicDefaults,
          rolePolicy:
            value.epicDefaults?.rolePolicy ?? initialDefaults.rolePolicy,
        }
        setDefaults(next)
        setSavedDefaults(next)
        setHarnesses(available as Record<string, { name: string }>)
      })
      .catch((cause: unknown) =>
        setLoadError(cause instanceof Error ? cause.message : String(cause)),
      )
  }, [load])
  useEffect(() => {
    if (settingsState.status === 'saved') setSavedDefaults(defaults)
  }, [defaults, settingsState.status])
  const updatePolicy = (patch: Partial<EpicDefaults['rolePolicy']>) =>
    setDefaults((current) => ({
      ...current,
      rolePolicy: { ...current.rolePolicy, ...patch },
    }))
  const updateRole = (role: string, tier: string) =>
    updatePolicy({
      roles: { ...defaults.rolePolicy.roles, [role]: tier },
    })
  const updateHop = (
    tier: string,
    index: number,
    patch: { harness?: string; model?: string },
  ) =>
    setDefaults((current) => ({
      ...current,
      rolePolicy: {
        ...current.rolePolicy,
        tiers: {
          ...current.rolePolicy.tiers,
          [tier]: current.rolePolicy.tiers[tier].map((hop, hopIndex) =>
            hopIndex === index ? { ...hop, ...patch } : hop,
          ),
        },
      },
    }))
  const addTier = () => {
    const name = newTier.trim()
    if (!name || name in defaults.rolePolicy.tiers) return
    setDefaults((current) => ({
      ...current,
      rolePolicy: {
        ...current.rolePolicy,
        tiers: {
          ...current.rolePolicy.tiers,
          [name]: [{ harness: Object.keys(harnesses)[0] ?? '' }],
        },
      },
    }))
    setNewTier('')
  }
  const addHop = (tier: string) =>
    setDefaults((current) => ({
      ...current,
      rolePolicy: {
        ...current.rolePolicy,
        tiers: {
          ...current.rolePolicy.tiers,
          [tier]: [
            ...current.rolePolicy.tiers[tier],
            { harness: Object.keys(harnesses)[0] ?? '' },
          ],
        },
      },
    }))
  const removeHop = (tier: string, index: number) =>
    setDefaults((current) => ({
      ...current,
      rolePolicy: {
        ...current.rolePolicy,
        tiers: {
          ...current.rolePolicy.tiers,
          [tier]: current.rolePolicy.tiers[tier].filter(
            (_, hopIndex) => hopIndex !== index,
          ),
        },
      },
    }))
  const moveHop = (tier: string, index: number, direction: -1 | 1) => {
    const hops = defaults.rolePolicy.tiers[tier]
    const target = index + direction
    if (target < 0 || target >= hops.length) return
    const next = [...hops]
    ;[next[index], next[target]] = [next[target], next[index]]
    updatePolicy({ tiers: { ...defaults.rolePolicy.tiers, [tier]: next } })
  }
  const save = () => {
    const errors = validateEpicDefaults(defaults, Object.keys(harnesses))
    setValidationErrors(errors)
    const first = Object.keys(errors)[0]
    if (first) {
      invalidRefs.current[first]?.focus()
      return
    }
    void saveSettings('epics', { epicDefaults: defaults }).then(() =>
      setSavedDefaults(defaults),
    )
  }
  const reset = () => {
    setDefaults(savedDefaults)
    setValidationErrors({})
  }
  const status =
    settingsState.status === 'saving'
      ? 'Saving…'
      : settingsState.status === 'error'
        ? settingsState.error
        : dirty
          ? 'Unsaved changes'
          : settingsState.status === 'saved'
            ? 'Saved.'
            : null
  return (
    <SettingsPage title="Epics" subtitle="Defaults for the epic runner.">
      {loadError && (
        <ErrorRow onRetry={() => window.location.reload()}>
          Could not load epic defaults: {loadError}
        </ErrorRow>
      )}
      {settingsState.status === 'error' && (
        <ErrorRow onRetry={() => void retry('epics')}>
          Could not save: {settingsState.error}
        </ErrorRow>
      )}
      <SettingsSection
        title="Run model"
        description="Choose how Forge runs an epic."
      >
        <SettingsRow
          label="Worker count"
          description="Number of workers in the run."
        >
          <Input
            className="w-24"
            aria-label="Worker count"
            type="number"
            min="1"
            value={defaults.workerCount}
            onChange={(event) =>
              setField('workerCount', Number(event.target.value))
            }
          />
        </SettingsRow>
        <SettingsRow
          label="Default mode"
          description="How workers run by default."
        >
          <Select
            value={defaults.mode}
            onValueChange={(value) => {
              if (value === 'pool' || value === 'serial' || value === 'auto') {
                setField('mode', value)
              }
            }}
          >
            <SelectTrigger className="w-32" aria-label="Default mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="pool">Pool</SelectItem>
              <SelectItem value="serial">Serial</SelectItem>
              <SelectItem value="auto">Auto</SelectItem>
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow
          label="Gate command"
          description="Command used to check the work."
        >
          <div className="flex flex-col gap-1">
            <Input
              className="w-64 font-mono text-sm"
              aria-label="Gate command"
              value={
                typeof defaults.gateCommand === 'string'
                  ? defaults.gateCommand
                  : (defaults.gateCommand ?? []).join('\n')
              }
              placeholder="bun run test"
              onChange={(event) =>
                setField('gateCommand', event.target.value || undefined)
              }
              ref={(node) => {
                invalidRefs.current.gateCommand = node
              }}
              aria-invalid={Boolean(validationErrors.gateCommand)}
              aria-describedby={
                validationErrors.gateCommand
                  ? 'epic-error-gateCommand'
                  : undefined
              }
            />
            {validationErrors.gateCommand && (
              <small
                id="epic-error-gateCommand"
                className="text-sm text-destructive"
              >
                {validationErrors.gateCommand}
              </small>
            )}
          </div>
        </SettingsRow>
        <SettingsRow
          label="Install command"
          description="Command used before the gate."
        >
          <div className="flex flex-col gap-1">
            <Input
              className="w-64 font-mono text-sm"
              aria-label="Install command"
              value={
                typeof defaults.installCommand === 'string'
                  ? defaults.installCommand
                  : (defaults.installCommand ?? []).join('\n')
              }
              placeholder="bun install"
              onChange={(event) =>
                setField('installCommand', event.target.value || undefined)
              }
              ref={(node) => {
                invalidRefs.current.installCommand = node
              }}
              aria-invalid={Boolean(validationErrors.installCommand)}
              aria-describedby={
                validationErrors.installCommand
                  ? 'epic-error-installCommand'
                  : undefined
              }
            />
            {validationErrors.installCommand && (
              <small
                id="epic-error-installCommand"
                className="text-sm text-destructive"
              >
                {validationErrors.installCommand}
              </small>
            )}
          </div>
        </SettingsRow>
      </SettingsSection>
      <SettingsSection
        title="Role policy"
        description="Each role uses a tier. Hops run from top to bottom until one works."
      >
        {Object.entries(defaults.rolePolicy.roles).map(([role, tier]) => (
          <SettingsRow
            key={role}
            label={role}
            description="Tier used for this role."
          >
            <div className="flex flex-col gap-1">
              <Select
                value={tier}
                onValueChange={(value) => {
                  if (typeof value === 'string') updateRole(role, value)
                }}
              >
                <SelectTrigger
                  className="w-40"
                  aria-label={`${role} tier`}
                  ref={(node) => {
                    invalidRefs.current[`rolePolicy.roles.${role}`] = node
                  }}
                  aria-invalid={Boolean(
                    validationErrors[`rolePolicy.roles.${role}`],
                  )}
                  aria-describedby={
                    validationErrors[`rolePolicy.roles.${role}`]
                      ? `epic-error-role-${role}`
                      : undefined
                  }
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.keys(defaults.rolePolicy.tiers).map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {validationErrors[`rolePolicy.roles.${role}`] && (
                <small
                  id={`epic-error-role-${role}`}
                  className="text-sm text-destructive"
                >
                  {validationErrors[`rolePolicy.roles.${role}`]}
                </small>
              )}
            </div>
          </SettingsRow>
        ))}
        {Object.entries(defaults.rolePolicy.tiers).map(([tier, hops]) => (
          <div className="rounded-md border p-3" key={tier}>
            <p className="mb-2 text-sm font-medium">{tier} fallback order</p>
            <div className="flex flex-col gap-2">
              {hops.map((hop, index) => (
                <div
                  className="flex flex-wrap items-center gap-2"
                  key={`${tier}-${index}`}
                >
                  <div className="flex flex-col gap-1">
                    <Select
                      value={hop.harness}
                      onValueChange={(value) => {
                        if (typeof value === 'string')
                          updateHop(tier, index, { harness: value })
                      }}
                    >
                      <SelectTrigger
                        className="w-40"
                        aria-label={`${tier} hop ${index + 1} harness`}
                        ref={(node) => {
                          invalidRefs.current[
                            `rolePolicy.tiers.${tier}.${index}.harness`
                          ] = node
                        }}
                        aria-invalid={Boolean(
                          validationErrors[
                            `rolePolicy.tiers.${tier}.${index}.harness`
                          ],
                        )}
                        aria-describedby={
                          validationErrors[
                            `rolePolicy.tiers.${tier}.${index}.harness`
                          ]
                            ? `epic-error-hop-${tier}-${index}`
                            : undefined
                        }
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.keys(harnesses).map((name) => (
                          <SelectItem key={name} value={name}>
                            {name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {validationErrors[
                      `rolePolicy.tiers.${tier}.${index}.harness`
                    ] && (
                      <small
                        id={`epic-error-hop-${tier}-${index}`}
                        className="text-sm text-destructive"
                      >
                        {
                          validationErrors[
                            `rolePolicy.tiers.${tier}.${index}.harness`
                          ]
                        }
                      </small>
                    )}
                  </div>
                  <Input
                    className="w-40 font-mono text-sm"
                    aria-label={`${tier} hop ${index + 1} model`}
                    placeholder="Model (optional)"
                    value={hop.model ?? ''}
                    onChange={(event) =>
                      updateHop(tier, index, {
                        model: event.target.value || undefined,
                      })
                    }
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={index === 0}
                    aria-label={`Move ${tier} hop ${index + 1} up`}
                    onClick={() => moveHop(tier, index, -1)}
                  >
                    Move up
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={index === hops.length - 1}
                    aria-label={`Move ${tier} hop ${index + 1} down`}
                    onClick={() => moveHop(tier, index, 1)}
                  >
                    Move down
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove ${tier} hop ${index + 1}`}
                    onClick={() => removeHop(tier, index)}
                  >
                    Remove
                  </Button>
                </div>
              ))}
              {validationErrors[`rolePolicy.tiers.${tier}`] && (
                <p className="text-sm text-destructive">
                  {validationErrors[`rolePolicy.tiers.${tier}`]}
                </p>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-fit"
                onClick={() => addHop(tier)}
              >
                Add fallback hop
              </Button>
            </div>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="w-48"
            aria-label="New tier name"
            placeholder="New tier name"
            value={newTier}
            onChange={(event) => setNewTier(event.target.value)}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addTier}
            disabled={!newTier.trim()}
          >
            Add tier
          </Button>
        </div>
      </SettingsSection>
      <div className="flex flex-wrap items-center justify-end gap-3">
        {status && (
          <p
            className={
              settingsState.status === 'error'
                ? 'text-sm text-destructive'
                : 'text-sm text-muted-foreground'
            }
            role="status"
          >
            {status}
          </p>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!dirty || settingsState.status === 'saving'}
          onClick={reset}
        >
          Reset
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!dirty || settingsState.status === 'saving'}
          onClick={save}
        >
          Save changes
        </Button>
      </div>
    </SettingsPage>
  )
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
}: {
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
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

export function SettingsPage({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle: string
  children: ReactNode
}) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => headingRef.current?.focus(), [title])
  return (
    <section className="mx-auto max-w-3xl px-4 py-6 sm:px-6 md:py-10">
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2 mb-2"
        onClick={() => window.history.back()}
        aria-label="Back to workspace"
      >
        <ArrowLeft className="size-4" />
        Back
      </Button>
      <h1
        ref={headingRef}
        tabIndex={-1}
        className="text-xl font-semibold tracking-tight outline-none"
        style={{ outline: 'none', boxShadow: 'none' }}
      >
        {title}
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
      <div className="mt-6 flex flex-col gap-6">{children}</div>
    </section>
  )
}
