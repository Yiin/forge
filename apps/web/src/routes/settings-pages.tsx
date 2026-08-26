import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api } from '../lib/api'
import { useShellStore } from '../stores/shell'
import { Button } from '../components/ui/button'
import { ConfirmationDialog } from '../components/ui/confirmation-dialog'

type Harness = {
  name: string
  command: string
  args: string[]
  env: Record<string, string>
  protocol: 'acp' | 'pty'
  enabled?: boolean
}
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
  const [settings, setSettings] = useState({
    theme: shellTheme,
    defaultProject: '',
    titleGeneration: true,
  })
  const [state, setState] = useState<'loading' | 'saving' | 'saved' | 'error'>(
    'loading',
  )
  const [error, setError] = useState<string | null>(null)
  const load = () => {
    setState('loading')
    void api
      .getSettings()
      .then((value) => {
        setSettings((current) => ({ ...current, ...(value as object) }))
        setState('saved')
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
        setState('error')
      })
  }
  useEffect(load, [])
  const save = (next: typeof settings) => {
    setSettings(next)
    setState('saving')
    setError(null)
    void api
      .saveSettings(next)
      .then(() => setState('saved'))
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
        setState('error')
      })
  }
  return (
    <SettingsPage title="General" subtitle="Defaults for new sessions.">
      <RequestState
        state={state}
        error={error}
        onRetry={state === 'error' ? load : undefined}
      />
      <label>
        Theme
        <select
          value={shellTheme}
          onChange={(e) => {
            const theme = e.target.value as 'system' | 'light' | 'dark'
            setShellTheme(theme)
            save({ ...settings, theme })
          }}
        >
          <option>system</option>
          <option>dark</option>
          <option>light</option>
        </select>
      </label>
      <label>
        Default project
        {input(settings.defaultProject, (defaultProject) =>
          save({ ...settings, defaultProject }),
        )}
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.titleGeneration}
          onChange={(e) =>
            save({ ...settings, titleGeneration: e.target.checked })
          }
        />{' '}
        Generate plain-word session titles
      </label>
    </SettingsPage>
  )
}

export function HarnessSettings() {
  const [harnesses, setHarnesses] = useState<Record<string, Harness>>({})
  const [results, setResults] = useState<Record<string, string>>({})
  const [saveError, setSaveError] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const saveQueue = useRef<Promise<void>>(Promise.resolve())
  useEffect(() => {
    void api
      .listHarnesses()
      .then((value) => setHarnesses(value as Record<string, Harness>))
  }, [])
  const save = (next: Record<string, Harness>) => {
    setHarnesses(next)
    setSaveError(null)
    saveQueue.current = saveQueue.current
      .then(() => api.saveHarnesses(next))
      .then(() => undefined)
      .catch((error: unknown) => {
        setSaveError(error instanceof Error ? error.message : String(error))
      })
  }
  const update = (key: string, patch: Partial<Harness>) =>
    save({ ...harnesses, [key]: { ...harnesses[key], ...patch } })
  const valid = (value: Harness) =>
    value.name.trim().length > 0 && value.command.trim().length > 0
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
    const key = `harness-${Object.keys(harnesses).length + 1}`
    save({
      ...harnesses,
      [key]: {
        name: 'New harness',
        command: '',
        args: [],
        env: {},
        protocol: 'acp',
      },
    })
  }
  return (
    <SettingsPage
      title="Harnesses"
      subtitle="A harness is a command and its runtime settings."
    >
      <div className="settings-stack">
        {Object.entries(harnesses).map(([key, value]) => (
          <article className="settings-card" key={key}>
            <div className="settings-card-head">
              <strong>{value.name || key}</strong>
              <button
                disabled={!valid(value)}
                onClick={() => {
                  setResults((current) => ({ ...current, [key]: 'Testing…' }))
                  void api
                    .testHarness(key)
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
                }}
              >
                Test
              </button>
              <button
                onClick={() => {
                  const next = { ...harnesses }
                  delete next[key]
                  save(next)
                }}
              >
                Delete
              </button>
            </div>
            <label>
              Name{input(value.name, (name) => update(key, { name }))}
            </label>
            <label>
              Command
              {input(value.command, (command) => update(key, { command }))}
            </label>
            <label>
              Arguments, one per line
              <textarea
                value={value.args.join('\n')}
                onChange={(e) =>
                  update(key, {
                    args: e.target.value.split('\n').filter(Boolean),
                  })
                }
              />
            </label>
            <fieldset className="settings-env">
              <legend>Environment variables</legend>
              {Object.entries(value.env).map(([name, envValue]) => (
                <div className="settings-env-row" key={name}>
                  <input
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
                  <input
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
            <label>
              Protocol
              <select
                value={value.protocol}
                onChange={(e) =>
                  update(key, {
                    protocol: e.target.value as Harness['protocol'],
                  })
                }
              >
                <option value="acp">ACP</option>
                <option value="pty">PTY</option>
              </select>
            </label>
            {results[key] && (
              <pre className="settings-result">{results[key]}</pre>
            )}
            {!valid(value) && (
              <p className="settings-error">
                Add a name and command before testing this harness.
              </p>
            )}
          </article>
        ))}
      </div>
      {saveError && (
        <p className="settings-error">Could not save: {saveError}</p>
      )}
      <button onClick={add}>Add harness</button>
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
  type Policy = {
    roles: Record<string, string>
    tiers: Record<string, Array<{ harness: string; model?: string }>>
  }
  type Defaults = {
    workerCount: number
    mode: 'pool' | 'serial' | 'auto'
    gateCommand?: string | string[]
    installCommand?: string | string[]
    rolePolicy: Policy
  }
  const [defaults, setDefaults] = useState<Defaults>({
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
  const [newTier, setNewTier] = useState('')
  useEffect(() => {
    void Promise.all([api.getSettings(), api.listHarnesses()]).then(
      ([settings, available]) => {
        const value = settings as { epicDefaults?: Partial<Defaults> }
        setDefaults((current) => ({
          ...current,
          ...(value.epicDefaults ?? {}),
          rolePolicy: value.epicDefaults?.rolePolicy ?? current.rolePolicy,
        }))
        setHarnesses(available as Record<string, { name: string }>)
      },
    )
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
    void api
      .saveSettings({ epicDefaults: defaults })
      .then(() => setSaved(true))
      .catch((cause) =>
        setSaveError(cause instanceof Error ? cause.message : String(cause)),
      )
  }
  return (
    <SettingsPage title="Epics" subtitle="Defaults for the epic runner.">
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
        <select
          value={defaults.mode}
          onChange={(event) =>
            setDefaults({
              ...defaults,
              mode: event.target.value as Defaults['mode'],
            })
          }
        >
          <option value="pool">Pool</option>
          <option value="serial">Serial</option>
        </select>
      </label>
      <fieldset className="settings-env">
        <legend>Role policy</legend>
        <p className="muted">
          Each role uses a tier. Hops run from top to bottom until one works.
        </p>
        {Object.entries(defaults.rolePolicy.roles).map(([role, tier]) => (
          <label key={role}>
            {role}
            <select
              value={tier}
              onChange={(event) => updateRole(role, event.target.value)}
            >
              {Object.keys(defaults.rolePolicy.tiers).map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </label>
        ))}
        {Object.entries(defaults.rolePolicy.tiers).map(([tier, hops]) => (
          <div className="settings-card" key={tier}>
            <strong>{tier} fallback hops</strong>
            {hops.map((hop, index) => (
              <div className="settings-env-row" key={`${tier}-${index}`}>
                <select
                  aria-label={`${tier} hop ${index + 1} harness`}
                  value={hop.harness}
                  onChange={(event) =>
                    updateHop(tier, index, { harness: event.target.value })
                  }
                >
                  {Object.keys(harnesses).map((name) => (
                    <option key={name}>{name}</option>
                  ))}
                </select>
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
      <button onClick={save}>Save epic defaults</button>
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
function SettingsPage({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle: string
  children: ReactNode
}) {
  return (
    <section className="settings-page">
      <p className="eyebrow">Settings</p>
      <h1>{title}</h1>
      <p className="muted">{subtitle}</p>
      <div className="settings-form">{children}</div>
    </section>
  )
}
