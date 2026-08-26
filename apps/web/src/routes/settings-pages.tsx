import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api } from '../lib/api'

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

export function GeneralSettings() {
  const [settings, setSettings] = useState({
    theme: 'dark',
    defaultProject: '',
    titleGeneration: true,
  })
  useEffect(() => {
    void api
      .getSettings()
      .then((value) =>
        setSettings((current) => ({ ...current, ...(value as object) })),
      )
  }, [])
  const save = (next: typeof settings) => {
    setSettings(next)
    void api.saveSettings(next)
  }
  return (
    <SettingsPage title="General" subtitle="Defaults for new sessions.">
      <label>
        Theme
        <select
          value={settings.theme}
          onChange={(e) => save({ ...settings, theme: e.target.value })}
        >
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
  const load = () =>
    void api
      .listSettingsProjects()
      .then((value) => setProjects(value as typeof projects))
  useEffect(load, [])
  return (
    <SettingsPage
      title="Projects"
      subtitle="Rename or archive projects. Sessions stay safe when you archive one."
    >
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
            <button
              onClick={() => void api.renameProject(project.id, project.name)}
            >
              Save
            </button>
            <button
              onClick={() => {
                if (
                  window.confirm(
                    `Archive ${project.name}? Sessions will be kept.`,
                  )
                )
                  void api.archiveProjectById(project.id).then(load)
              }}
            >
              {project.archived_at ? 'Archived' : 'Archive'}
            </button>
          </article>
        ))}
      </div>
    </SettingsPage>
  )
}

export function EpicSettings() {
  return (
    <SettingsPage title="Epics" subtitle="Defaults for the epic runner.">
      <label>
        Worker count
        <input type="number" min="1" defaultValue="3" />
      </label>
      <label>
        Default mode
        <select defaultValue="pool">
          <option value="pool">Pool</option>
          <option value="serial">Serial</option>
        </select>
      </label>
      <p className="muted">
        Role and model policy editing is owned by the epic runner.
      </p>
    </SettingsPage>
  )
}
export function AboutSettings() {
  const [status, setStatus] = useState<{
    version?: string
    bootId?: string
    uptimeSec?: number
  }>({})
  useEffect(() => {
    void fetch('/api/status')
      .then((response) => response.json())
      .then(setStatus)
      .catch(() => undefined)
  }, [])
  return (
    <SettingsPage title="About" subtitle="Forge runtime information.">
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
