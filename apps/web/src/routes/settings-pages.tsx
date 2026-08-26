import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'
import { harnessConfigSchema, type HarnessConfig } from '@forge/protocol/config'
import { api } from '../lib/api'
import { useShellStore } from '../stores/shell'
import { useSettingsStore } from '../stores/settings'
import { Button } from '../components/ui/button'
import { ConfirmationDialog } from '../components/ui/confirmation-dialog'
import { Field } from '../components/ui/field'
import { Input } from '../components/ui/input'
import { Textarea } from '../components/ui/textarea'
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select'
import { validateEpicDefaults, type EpicDefaults } from './epic-settings-logic'

type Harness = HarnessConfig
const input = (value: string, onChange: (value: string) => void) => (
  <input
    value={value}
    onChange={(event) => onChange(event.target.value)}
    autoComplete="off"
  />
)

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
  const [defaultProject, setDefaultProject] = useState('')
  useEffect(() => {
    void load()
      .then(() =>
        setDefaultProject(useSettingsStore.getState().settings.defaultProject),
      )
      .catch((cause: unknown) =>
        setLoadError(cause instanceof Error ? cause.message : String(cause)),
      )
      .finally(() => setLoading(false))
  }, [load])
  const commit = (patch: {
    defaultProject?: string
    titleGeneration?: boolean
  }) => {
    void save('general', patch).catch(() => undefined)
  }
  return (
    <SettingsPage title="General" subtitle="Defaults for new sessions.">
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
      <label>
        Theme
        <Select
          value={shellTheme}
          onValueChange={(value) => {
            if (value === 'system' || value === 'light' || value === 'dark') {
              setShellTheme(value)
            }
          }}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="system">system</SelectItem>
            <SelectItem value="dark">dark</SelectItem>
            <SelectItem value="light">light</SelectItem>
          </SelectPopup>
        </Select>
      </label>
      <label>
        Default project
        <input
          value={defaultProject}
          onChange={(event) => setDefaultProject(event.target.value)}
          onBlur={() => commit({ defaultProject })}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
          autoComplete="off"
        />
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.titleGeneration}
          onChange={(e) => commit({ titleGeneration: e.target.checked })}
        />{' '}
        Generate plain-word session titles
      </label>
    </SettingsPage>
  )
}

export function HarnessSettings() {
  const [draft, setDraft] = useState<Record<string, Harness>>({})
  const [results, setResults] = useState<Record<string, string>>({})
  const [saveState, setSaveState] = useState<Record<string, 'loading' | 'dirty' | 'saving' | 'saved' | 'error'>>({})
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
        setSaveState(Object.fromEntries(Object.keys(value).map((key) => [key, 'saved'])))
      })
      .catch((error: unknown) => {
        setSaveError({ _page: error instanceof Error ? error.message : String(error) })
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
      setSaveError((current) => ({ ...current, [key]: invalid.error.issues[0]?.message ?? 'Invalid harness' }))
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
        setSaveError((current) => ({ ...current, [key]: error instanceof Error ? error.message : String(error) }))
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
                {saveState[key] === 'dirty' ? 'Unsaved changes' : saveState[key] === 'saving' ? 'Saving…' : saveState[key] === 'error' ? 'Error' : 'Saved.'}
              </span>
            </div>
            <SettingsSection title="Connection" description="Choose how Forge starts this harness.">
            <Field label="Name" htmlFor={`${key}-name`} description="A label shown in session controls.">
              <Input id={`${key}-name`} value={value.name} onChange={(event) => update(key, { name: event.target.value })} />
            </Field>
            <Field label="Command" htmlFor={`${key}-command`} description="The executable Forge starts.">
              <Input id={`${key}-command`} value={value.command} onChange={(event) => update(key, { command: event.target.value })} />
            </Field>
            <Field label="Arguments" htmlFor={`${key}-args`} description="Enter one argument per line.">
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
            <SettingsSection title="Environment" description="Secret values stay hidden until you reveal them.">
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
            <Field label="Protocol" description="ACP uses structured messages. PTY uses terminal output.">
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
                    .finally(() => setTesting((current) => ({ ...current, [key]: false })))
                }}
                disabled={
                  Boolean(validationError(value)) || testing[key] || saveState[key] === 'saving'
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
      {Object.entries(saveError).filter(([, error]) => error).map(([key, error]) => (
        <p className="settings-error" role="alert" key={key}>Could not save: {error}</p>
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
      {loadState === 'loading' && <RequestState state="loading" />}
      {loadState === 'error' && (
        <RequestState state="error" error={error} onRetry={load} />
      )}
      <div className="settings-stack">
        {projects.map((project) => (
          <article className="settings-card project-setting" key={project.id}>
            <div>
              {input(project.name, (name) =>
                setProjects((all) =>
                  all.map((item) =>
                    item.id === project.id ? { ...item, name } : item,
                  ),
                ),
              )}
              <small>{project.path}</small>
            </div>
            <Button
              loading={saving[project.id]}
              onClick={() => {
                setSaving((current) => ({ ...current, [project.id]: true }))
                setSaveState((current) => {
                  const next = { ...current }
                  delete next[project.id]
                  return next
                })
                void api
                  .renameProject(project.id, project.name)
                  .then(() => {
                    setSaveState((current) => ({
                      ...current,
                      [project.id]: 'saved',
                    }))
                  })
                  .catch(() => {
                    setSaveState((current) => ({
                      ...current,
                      [project.id]: 'error',
                    }))
                  })
                  .finally(() => {
                    setSaving((current) => ({
                      ...current,
                      [project.id]: false,
                    }))
                  })
              }}
            >
              Save
            </Button>
            <button
              disabled={Boolean(project.archived_at)}
              onClick={() => {
                setArchiveError(null)
                setArchiveProject(project)
              }}
            >
              {project.archived_at ? 'Archived' : 'Archive'}
            </button>
            {saveState[project.id] === 'saved' && (
              <span className="settings-status" role="status">
                Saved.
              </span>
            )}
            {saveState[project.id] === 'error' && (
              <span className="settings-error" role="alert">
                Could not save. Retry.
              </span>
            )}
          </article>
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
            setArchiveProject(null)
            load()
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
}

export function EpicSettings() {
  const [defaults, setDefaults] = useState<EpicDefaults>({
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
  })
  const [harnesses, setHarnesses] = useState<Record<string, { name: string }>>(
    {},
  )
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [loadState, setLoadState] = useState<'loading' | 'loaded' | 'error'>(
    'loading',
  )
  const [validationErrors, setValidationErrors] = useState<
    Record<string, string>
  >({})
  const [saving, setSaving] = useState(false)
  const [newTier, setNewTier] = useState('')
  useEffect(() => {
    void Promise.all([api.getSettings(), api.listHarnesses()])
      .then(([settings, available]) => {
        const value = settings as { epicDefaults?: Partial<EpicDefaults> }
        setDefaults((current) => ({
          ...current,
          ...value.epicDefaults,
          rolePolicy: value.epicDefaults?.rolePolicy ?? current.rolePolicy,
        }))
        setHarnesses(available as Record<string, { name: string }>)
        setLoadState('loaded')
      })
      .catch((cause: unknown) => {
        setSaveError(cause instanceof Error ? cause.message : String(cause))
        setLoadState('error')
      })
  }, [])
  const updateRole = (role: string, tier: string) =>
    setDefaults((current) => ({
      ...current,
      rolePolicy: {
        ...current.rolePolicy,
        roles: { ...current.rolePolicy.roles, [role]: tier },
      },
    }))
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
  const save = () => {
    setSaved(false)
    setSaveError(null)
    const errors = validateEpicDefaults(defaults, Object.keys(harnesses))
    setValidationErrors(errors)
    if (Object.keys(errors).length > 0) return
    setSaving(true)
    void api
      .saveSettings({ epicDefaults: defaults })
      .then(() => setSaved(true))
      .catch((cause) =>
        setSaveError(cause instanceof Error ? cause.message : String(cause)),
      )
      .finally(() => setSaving(false))
  }
  return (
    <SettingsPage title="Epics" subtitle="Defaults for the epic runner.">
      {loadState === 'loading' && (
        <p className="settings-status">Loading epic defaults…</p>
      )}
      {loadState === 'error' && (
        <p className="settings-error" role="alert">
          Could not load epic defaults: {saveError}
        </p>
      )}
      {loadState === 'loaded' && (
        <p className="muted">Choose how Forge runs this epic.</p>
      )}
      <label>
        Worker count
        <input
          type="number"
          min="1"
          value={defaults.workerCount}
          onChange={(event) =>
            setDefaults({
              ...defaults,
              workerCount: Number(event.target.value),
            })
          }
        />
      </label>
      <label>
        Default mode
        <Select
          value={defaults.mode}
          onValueChange={(value) => {
            if (value === 'pool' || value === 'serial' || value === 'auto') {
              setDefaults({ ...defaults, mode: value })
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
      </label>
      <label>
        Gate command
        <input
          value={
            typeof defaults.gateCommand === 'string'
              ? defaults.gateCommand
              : (defaults.gateCommand ?? []).join('\n')
          }
          placeholder="bun run test"
          onChange={(event) =>
            setDefaults({
              ...defaults,
              gateCommand: event.target.value || undefined,
            })
          }
          aria-invalid={Boolean(validationErrors.gateCommand)}
        />
        {validationErrors.gateCommand && (
          <small className="field-error">{validationErrors.gateCommand}</small>
        )}
      </label>
      <label>
        Install command
        <input
          value={
            typeof defaults.installCommand === 'string'
              ? defaults.installCommand
              : (defaults.installCommand ?? []).join('\n')
          }
          placeholder="bun install"
          onChange={(event) =>
            setDefaults({
              ...defaults,
              installCommand: event.target.value || undefined,
            })
          }
          aria-invalid={Boolean(validationErrors.installCommand)}
        />
        {validationErrors.installCommand && (
          <small className="field-error">
            {validationErrors.installCommand}
          </small>
        )}
      </label>
      <fieldset className="settings-env">
        <legend>Role policy</legend>
        <p className="muted">
          Each role uses a tier. Hops run from top to bottom until one works.
        </p>
        {Object.entries(defaults.rolePolicy.roles).map(([role, tier]) => (
          <label key={role}>
            {role}
            <Select
              value={tier}
              onValueChange={(value) => {
                if (typeof value === 'string') updateRole(role, value)
              }}
            >
              <SelectTrigger
                aria-invalid={Boolean(
                  validationErrors[`rolePolicy.roles.${role}`],
                )}
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
              <small className="field-error">
                {validationErrors[`rolePolicy.roles.${role}`]}
              </small>
            )}
          </label>
        ))}
        {Object.entries(defaults.rolePolicy.tiers).map(([tier, hops]) => (
          <div className="settings-card" key={tier}>
            <strong>{tier} fallback hops</strong>
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
                    aria-invalid={Boolean(
                      validationErrors[
                        `rolePolicy.tiers.${tier}.${index}.harness`
                      ],
                    )}
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
                  <small className="field-error">
                    {
                      validationErrors[
                        `rolePolicy.tiers.${tier}.${index}.harness`
                      ]
                    }
                  </small>
                )}
                <input
                  aria-label={`${tier} hop ${index + 1} model`}
                  placeholder="Model (optional)"
                  value={hop.model ?? ''}
                  onChange={(event) =>
                    updateHop(tier, index, {
                      model: event.target.value || undefined,
                    })
                  }
                />
                <button
                  type="button"
                  className="settings-env-remove"
                  aria-label={`Remove ${tier} hop ${index + 1}`}
                  onClick={() => removeHop(tier, index)}
                >
                  Remove
                </button>
              </div>
            ))}
            {validationErrors[`rolePolicy.tiers.${tier}`] && (
              <p className="field-error">
                {validationErrors[`rolePolicy.tiers.${tier}`]}
              </p>
            )}
            <button type="button" onClick={() => addHop(tier)}>
              Add fallback hop
            </button>
          </div>
        ))}
        <div className="settings-env-row settings-add-tier">
          <input
            aria-label="New tier name"
            placeholder="New tier name"
            value={newTier}
            onChange={(event) => setNewTier(event.target.value)}
          />
          <button type="button" onClick={addTier} disabled={!newTier.trim()}>
            Add tier
          </button>
        </div>
      </fieldset>
      <button onClick={save} disabled={saving || loadState !== 'loaded'}>
        {saving ? 'Saving…' : 'Save epic defaults'}
      </button>
      {saved && (
        <p className="muted" role="status">
          Saved.
        </p>
      )}
      {saveError && (
        <p className="settings-error" role="alert">
          Could not save: {saveError}
        </p>
      )}
    </SettingsPage>
  )
}
export function AboutSettings() {
  const [status, setStatus] = useState<{
    version?: string
    bootId?: string
    uptimeSec?: number
  }>({})
  const [state, setState] = useState<'loading' | 'saved' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const load = () => {
    setState('loading')
    void fetch('/api/status')
      .then((response) => {
        if (!response.ok)
          throw new Error(`Status request failed (${response.status})`)
        return response.json()
      })
      .then((value) => {
        setStatus(value)
        setState('saved')
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
        setState('error')
      })
  }
  useEffect(load, [])
  return (
    <SettingsPage title="About" subtitle="Forge runtime information.">
      <RequestState state={state} error={error} onRetry={load} />
      <dl className="about-list">
        <dt>Version</dt>
        <dd>{status.version ?? 'unknown'}</dd>
        <dt>Boot id</dt>
        <dd>
          <code>{status.bootId ?? 'unknown'}</code>
        </dd>
        <dt>Uptime</dt>
        <dd>{status.uptimeSec ?? 0}s</dd>
      </dl>
      <p className="muted">
        Updates will be available through the release pipeline.
      </p>
    </SettingsPage>
  )
}
export function KeybindingsSettings() {
  return (
    <SettingsPage
      title="Keybindings"
      subtitle="Shortcuts for common Forge actions."
    >
      <SettingsSection title="Keyboard shortcuts">
        <SettingsRow
          label="Open settings"
          description="Go to this Settings page."
        >
          <kbd>⌘ ,</kbd>
        </SettingsRow>
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
