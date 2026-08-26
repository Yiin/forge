import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { ArrowLeft } from 'lucide-react'
import { harnessConfigSchema, type HarnessConfig } from '@forge/protocol/config'
import { api } from '../lib/api'
import { useShellStore } from '../stores/shell'
import { useSettingsStore } from '../stores/settings'
import { Button } from '../components/ui/button'
import { ConfirmationDialog } from '../components/ui/confirmation-dialog'
import { Field } from '../components/ui/field'
import { Input } from '../components/ui/input'
import { Switch } from '../components/ui/switch'
import { Textarea } from '../components/ui/textarea'
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select'
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

function RequestState({
  state,
  error,
  onRetry,
}: {
  state: 'loading' | 'saving' | 'saved' | 'error'
  error?: string | null
  onRetry?: () => void
}) {
  if (state === 'loading') return <p className="settings-status">Loading…</p>
  if (state === 'saving')
    return (
      <p className="settings-status" role="status">
        Saving…
      </p>
    )
  if (state === 'saved')
    return (
      <p className="settings-status" role="status">
        Saved.
      </p>
    )
  return (
    <div className="settings-error" role="alert">
      <span>Could not load or save{error ? `: ${error}` : '.'}</span>
      {onRetry && (
        <Button size="compact" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
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
  const [aboutState, setAboutState] = useState<'loading' | 'saved' | 'error'>('loading')
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
        if (!response.ok) throw new Error(`Status request failed (${response.status})`)
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
    <SettingsPage title="General" subtitle="Preferences for your Forge workspace.">
      {loading && <p className="settings-status">Loading…</p>}
      {loadError && (
        <p className="settings-error" role="alert">
          Could not load: {loadError}
        </p>
      )}
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
      <SettingsSection title="Workspace preferences" description="Changes apply to this Forge workspace.">
        <SettingsRow
          label="Theme"
          description="Choose the color theme for Forge."
          reset={
            shellTheme !== 'system' && (
              <Button size="compact" onClick={() => setShellTheme('system')}>
                Reset
              </Button>
            )
          }
        >
          <Select
            value={shellTheme}
            onValueChange={(value) => {
              if (value === 'system' || value === 'light' || value === 'dark') setShellTheme(value)
            }}
          >
            <SelectTrigger aria-label="Theme">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="system">System</SelectItem>
              <SelectItem value="light">Light</SelectItem>
              <SelectItem value="dark">Dark</SelectItem>
            </SelectPopup>
          </Select>
        </SettingsRow>
        <SettingsRow
          label="Plain-word titles"
          description="Generate simple words for new session titles."
          reset={
            settings.titleGeneration !== defaultGeneralSettings.titleGeneration && (
              <Button size="compact" onClick={resetTitleGeneration}>Reset</Button>
            )
          }
        >
          <Switch
            checked={settings.titleGeneration}
            aria-label="Generate plain-word session titles"
            onCheckedChange={(checked) => commit({ titleGeneration: checked })}
          />
        </SettingsRow>
        <div className="settings-actions">
          <Button onClick={() => setRestoreOpen(true)}>Restore defaults</Button>
        </div>
      </SettingsSection>
      <SettingsSection title="About" description="Forge runtime information.">
        <RequestState state={aboutState} error={aboutError} onRetry={loadAbout} />
        <SettingsRow label="Version" description="The running Forge version.">
          <code>{about.version ?? 'unknown'}</code>
        </SettingsRow>
        <SettingsRow label="Boot ID" description="The identifier for this server start.">
          <code>{about.bootId ?? 'unknown'}</code>
        </SettingsRow>
        <SettingsRow label="Uptime" description="Time since the server started.">
          <span>{about.uptimeSec ?? 0}s</span>
        </SettingsRow>
        <p className="muted">Updates will be available through the release pipeline.</p>
      </SettingsSection>
      <ConfirmationDialog
        open={restoreOpen}
        onOpenChange={setRestoreOpen}
        onConfirm={restoreDefaults}
        title="Restore General defaults"
        confirmLabel="Restore defaults"
      >
        This restores the theme and title generation settings. Other settings stay unchanged.
      </ConfirmationDialog>
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
  return (
    <SettingsPage
      title="Harnesses"
      subtitle="A harness is a command and its runtime settings."
    >
      <div className="settings-stack">
        {Object.values(saveState).some((state) => state === 'loading') && (
          <p className="settings-status" role="status">
            Loading harnesses…
          </p>
        )}
        {Object.entries(draft).map(([key, value]) => (
          <article className="settings-card" key={key}>
            <div className="settings-card-head">
              <strong>{value.name || key}</strong>
              <span className="settings-status" role="status">
                {saveState[key] === 'dirty'
                  ? 'Unsaved changes'
                  : saveState[key] === 'saving'
                    ? 'Saving…'
                    : saveState[key] === 'error'
                      ? 'Error'
                      : 'Saved.'}
              </span>
            </div>
            <SettingsSection
              title="Connection"
              description="Choose how Forge starts this harness."
            >
              <Field
                label="Name"
                htmlFor={`${key}-name`}
                description="A label shown in session controls."
              >
                <Input
                  id={`${key}-name`}
                  value={value.name}
                  onChange={(event) =>
                    update(key, { name: event.target.value })
                  }
                />
              </Field>
              <Field
                label="Command"
                htmlFor={`${key}-command`}
                description="The executable Forge starts."
              >
                <Input
                  id={`${key}-command`}
                  value={value.command}
                  onChange={(event) =>
                    update(key, { command: event.target.value })
                  }
                />
              </Field>
              <Field
                label="Arguments"
                htmlFor={`${key}-args`}
                description="Enter one argument per line."
              >
                <Textarea
                  id={`${key}-args`}
                  value={value.args.join('\n')}
                  onChange={(e) =>
                    update(key, {
                      args: e.target.value.split('\n').filter(Boolean),
                    })
                  }
                />
              </Field>
            </SettingsSection>
            <SettingsSection
              title="Environment"
              description="Secret values stay hidden until you reveal them."
            >
              <fieldset className="settings-env">
                <legend>Environment variables</legend>
                {Object.entries(value.env).map(([name, envValue]) => (
                  <div className="settings-env-row" key={name}>
                    <Input
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
                    <button
                      type="button"
                      className="settings-env-toggle"
                      aria-label={
                        revealed[`${key}:${name}`] ? 'Hide value' : 'Show value'
                      }
                      onClick={() =>
                        setRevealed((current) => ({
                          ...current,
                          [`${key}:${name}`]: !current[`${key}:${name}`],
                        }))
                      }
                    >
                      {revealed[`${key}:${name}`] ? 'Hide' : 'Show'}
                    </button>
                    <button
                      type="button"
                      className="settings-env-remove"
                      aria-label={`Remove ${name}`}
                      onClick={() => {
                        const next = { ...value.env }
                        delete next[name]
                        update(key, { env: next })
                      }}
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    let name = 'NEW_VARIABLE'
                    let suffix = 1
                    while (name in value.env) name = `NEW_VARIABLE_${suffix++}`
                    update(key, { env: { ...value.env, [name]: '' } })
                  }}
                >
                  Add variable
                </button>
              </fieldset>
            </SettingsSection>
            <Field
              label="Protocol"
              description="ACP uses structured messages. PTY uses terminal output."
            >
              <Select
                value={value.protocol}
                onValueChange={(selected) => {
                  if (selected === 'acp' || selected === 'pty') {
                    update(key, { protocol: selected })
                  }
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="acp">ACP</SelectItem>
                  <SelectItem value="pty">PTY</SelectItem>
                </SelectPopup>
              </Select>
            </Field>
            {results[key] && (
              <pre className="settings-result" role="status">
                {results[key]}
              </pre>
            )}
            {validationError(value) && (
              <p className="settings-error" role="alert">
                {validationError(value)}
              </p>
            )}
            <div className="settings-actions">
              <Button
                variant="primary"
                onClick={() => save(key)}
                disabled={Boolean(validationError(value))}
              >
                Save
              </Button>
              <Button
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
                Test
              </Button>
              <Button variant="danger" onClick={() => setDeleteKey(key)}>
                Delete
              </Button>
            </div>
          </article>
        ))}
      </div>
      {Object.entries(saveError)
        .filter(([, error]) => error)
        .map(([key, error]) => (
          <p className="settings-error" role="alert" key={key}>
            Could not save: {error}
          </p>
        ))}
      <div className="settings-actions">
        <Button onClick={add}>Add harness</Button>
      </div>
      <ConfirmationDialog
        open={deleteKey !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteKey(null)
        }}
        title="Delete harness?"
        confirmLabel="Delete"
        onConfirm={async () => {
          if (!deleteKey) return
          const next = { ...draft }
          delete next[deleteKey]
          await api.saveHarnesses(next)
          setDraft((current) => {
            const next = { ...current }
            delete next[deleteKey]
            return next
          })
          setDeleteKey(null)
          setSaveState((current) => ({ ...current, [deleteKey]: 'saved' }))
        }}
      >
        Delete “{deleteKey ? draft[deleteKey]?.name || deleteKey : ''}”? Save
        the remaining harnesses to apply this change.
      </ConfirmationDialog>
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
      <Button variant="primary" onClick={openProjectCreation}>
        Add project
      </Button>
      {loadState === 'loading' && <RequestState state="loading" />}
      {loadState === 'error' && (
        <RequestState state="error" error={error} onRetry={load} />
      )}
      <div className="settings-stack">
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
                <span role="status">Saved.</span>
              )}
              {saveState[project.id] === 'error' && (
                <span role="alert">
                  Could not save.{' '}
                  <Button
                    size="compact"
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
              <span>{project.path}</span>
            </SettingsRow>
            <SettingsRow
              label="State"
              description="Archived projects cannot start new work."
            >
              <Button
                loading={saving[project.id]}
                disabled={Boolean(project.archived_at)}
                onClick={() => {
                  setArchiveError(null)
                  setArchiveProject(project)
                }}
              >
                {project.archived_at ? 'Archived' : 'Archive'}
              </Button>
            </SettingsRow>
          </SettingsSection>
        ))}
      </div>
      {loadState === 'saved' && projects.length === 0 && (
        <p className="settings-status">No projects yet.</p>
      )}
      {archiveError && (
        <p className="settings-error" role="alert">
          Could not archive project: {archiveError}
        </p>
      )}
      <ConfirmationDialog
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
      </ConfirmationDialog>
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
        <div className="settings-error" role="alert">
          Could not load epic defaults: {loadError}
          <Button size="compact" onClick={() => window.location.reload()}>
            Retry
          </Button>
        </div>
      )}
      {settingsState.status === 'error' && (
        <div className="settings-error" role="alert">
          Could not save: {settingsState.error}
          <Button size="compact" onClick={() => void retry('epics')}>
            Retry
          </Button>
        </div>
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
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="pool">Pool</SelectItem>
              <SelectItem value="serial">Serial</SelectItem>
              <SelectItem value="auto">Auto</SelectItem>
            </SelectPopup>
          </Select>
        </SettingsRow>
        <SettingsRow
          label="Gate command"
          description="Command used to check the work."
        >
          <Input
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
            <small id="epic-error-gateCommand" className="field-error">
              {validationErrors.gateCommand}
            </small>
          )}
        </SettingsRow>
        <SettingsRow
          label="Install command"
          description="Command used before the gate."
        >
          <Input
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
            <small id="epic-error-installCommand" className="field-error">
              {validationErrors.installCommand}
            </small>
          )}
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
            <Select
              value={tier}
              onValueChange={(value) => {
                if (typeof value === 'string') updateRole(role, value)
              }}
            >
              <SelectTrigger
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
              <SelectPopup>
                {Object.keys(defaults.rolePolicy.tiers).map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {validationErrors[`rolePolicy.roles.${role}`] && (
              <small id={`epic-error-role-${role}`} className="field-error">
                {validationErrors[`rolePolicy.roles.${role}`]}
              </small>
            )}
          </SettingsRow>
        ))}
        {Object.entries(defaults.rolePolicy.tiers).map(([tier, hops]) => (
          <div className="settings-card settings-fallback-list" key={tier}>
            <strong>{tier} fallback order</strong>
            {hops.map((hop, index) => (
              <div className="settings-env-row" key={`${tier}-${index}`}>
                <Select
                  aria-label={`${tier} hop ${index + 1} harness`}
                  value={hop.harness}
                  onValueChange={(value) => {
                    if (typeof value === 'string')
                      updateHop(tier, index, { harness: value })
                  }}
                >
                  <SelectTrigger
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
                  <SelectPopup>
                    {Object.keys(harnesses).map((name) => (
                      <SelectItem key={name} value={name}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                {validationErrors[
                  `rolePolicy.tiers.${tier}.${index}.harness`
                ] && (
                  <small
                    id={`epic-error-hop-${tier}-${index}`}
                    className="field-error"
                  >
                    {
                      validationErrors[
                        `rolePolicy.tiers.${tier}.${index}.harness`
                      ]
                    }
                  </small>
                )}
                <Input
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
                  size="compact"
                  disabled={index === 0}
                  aria-label={`Move ${tier} hop ${index + 1} up`}
                  onClick={() => moveHop(tier, index, -1)}
                >
                  Move up
                </Button>
                <Button
                  type="button"
                  size="compact"
                  disabled={index === hops.length - 1}
                  aria-label={`Move ${tier} hop ${index + 1} down`}
                  onClick={() => moveHop(tier, index, 1)}
                >
                  Move down
                </Button>
                <Button
                  type="button"
                  size="compact"
                  aria-label={`Remove ${tier} hop ${index + 1}`}
                  onClick={() => removeHop(tier, index)}
                >
                  Remove
                </Button>
              </div>
            ))}
            {validationErrors[`rolePolicy.tiers.${tier}`] && (
              <p className="field-error">
                {validationErrors[`rolePolicy.tiers.${tier}`]}
              </p>
            )}
            <Button type="button" size="compact" onClick={() => addHop(tier)}>
              Add fallback hop
            </Button>
          </div>
        ))}
        <div className="settings-env-row settings-add-tier">
          <Input
            aria-label="New tier name"
            placeholder="New tier name"
            value={newTier}
            onChange={(event) => setNewTier(event.target.value)}
          />
          <Button
            type="button"
            size="compact"
            onClick={addTier}
            disabled={!newTier.trim()}
          >
            Add tier
          </Button>
        </div>
      </SettingsSection>
      <div className="settings-actions">
        {status && (
          <p
            className={
              settingsState.status === 'error'
                ? 'settings-error'
                : 'settings-status'
            }
            role="status"
          >
            {status}
          </p>
        )}
        <Button
          type="button"
          variant="secondary"
          disabled={!dirty || settingsState.status === 'saving'}
          onClick={reset}
        >
          Reset
        </Button>
        <Button
          type="button"
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
      >
        <Input
          aria-label="Search keybindings"
          placeholder="Search commands or shortcuts"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {captureError && (
          <p className="settings-error" role="alert">
            {captureError}
          </p>
        )}
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
                aria-label={`Capture shortcut for ${command.label}`}
                onKeyDown={captureKey}
                placeholder="Press a key combination"
                readOnly
              />
            ) : (
              <kbd aria-keyshortcuts={displayShortcut(command.key)}>
                {displayShortcut(command.key)}
              </kbd>
            )}
            <Button
              size="compact"
              onClick={() => {
                setCapture(command.id)
                setCaptureError(null)
              }}
            >
              {capture === command.id ? 'Capturing…' : 'Edit'}
            </Button>
            <Button size="compact" onClick={() => commit(command.id)}>
              Reset
            </Button>
          </SettingsRow>
        ))}
        {!visible.length && <p className="muted">No matching shortcuts.</p>}
        <Button
          onClick={() => {
            setDraft({})
            setShortcutOverrides({})
            void save('general', { keybindings: {} }).catch(() => undefined)
          }}
        >
          Restore all defaults
        </Button>
      </SettingsSection>
    </SettingsPage>
  )
}

export function SettingsSection({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: ReactNode
}) {
  return (
    <section className="settings-section">
      <div className="settings-section-heading">
        <h2>{title}</h2>
        {description && <p className="muted">{description}</p>}
      </div>
      <div className="settings-rows">{children}</div>
    </section>
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
    <div className="settings-row">
      <div className="settings-row-copy">
        <strong>{label}</strong>
        {description && <span className="muted">{description}</span>}
      </div>
      <div className="settings-row-control">
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
    <section className="settings-page">
      <p className="eyebrow">Settings</p>
      <div className="settings-page-heading">
        <button
          type="button"
          className="settings-back"
          onClick={() => window.history.back()}
          aria-label="Back to workspace"
        >
          <ArrowLeft size={16} />
          Back
        </button>
        <h1 ref={headingRef} tabIndex={-1}>
          {title}
        </h1>
      </div>
      <p className="muted">{subtitle}</p>
      <div className="settings-form">{children}</div>
    </section>
  )
}
