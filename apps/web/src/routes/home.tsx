import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { api } from '../lib/api'
import { folderName } from '../lib/folder-name'
import { FolderPicker } from '../components/FolderPicker'
import { useShellStore } from '../stores/shell'

export function HomeRoute() {
  const navigate = useNavigate()
  const [name, setName] = useState('Test project')
  const [nameTouched, setNameTouched] = useState(false)
  const [path, setPath] = useState('/tmp/forge-e2e-project')
  const [browsing, setBrowsing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const project = (await api.createProject({ name, path })) as {
        id: string
      }
      const session = (await api.createSession({
        projectId: project.id,
        harness: 'fake-acp-agent',
        cwd: path,
        kind: 'chat',
      })) as { id: string }
      useShellStore.getState().setLastSession(session.id)
      await navigate({ to: '/s/$sessionId', params: { sessionId: session.id } })
    } catch (cause) {
      console.error(cause)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="empty-panel">
      <h1>Welcome to Forge</h1>
      <p>Add a project to start a session.</p>
      <form
        className="project-form"
        onSubmit={(event) => {
          event.preventDefault()
          void create()
        }}
      >
        <label>
          Project name
          <input
            value={name}
            onChange={(event) => {
              setNameTouched(true)
              setName(event.target.value)
            }}
          />
        </label>
        <label>
          Project path
          <input
            value={path}
            onChange={(event) => setPath(event.target.value)}
          />
        </label>
        <button type="submit" disabled={busy || !name || !path}>
          {busy ? 'Creating…' : 'Add project'}
        </button>
        <button
          type="button"
          aria-expanded={browsing}
          onClick={() => setBrowsing((open) => !open)}
        >
          Browse folders
        </button>
        {browsing && (
          <FolderPicker
            initialPath={path}
            onSelect={(selected) => {
              setPath(selected)
              if (!nameTouched) setName(folderName(selected))
              setBrowsing(false)
            }}
            onCancel={() => setBrowsing(false)}
          />
        )}
        {error && <p role="alert">{error}</p>}
      </form>
    </section>
  )
}
