import { useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Dialog, DialogDescription, DialogTitle } from './ui/dialog'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { FolderPicker } from './FolderPicker'
import { api } from '../lib/api'
import { folderName } from '../lib/folder-name'
import { useDraftsStore } from '../stores/drafts'
import { useSessionsStore } from '../stores/sessions'

export const OPEN_PROJECT_CREATION = 'forge:open-project-creation'

export function openProjectCreation() {
  window.dispatchEvent(new Event(OPEN_PROJECT_CREATION))
}

export function ProjectCreationDialog() {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const show = () => {
      setName('')
      setPath('')
      setNameTouched(false)
      setBrowsing(false)
      setError(null)
      setOpen(true)
    }
    window.addEventListener(OPEN_PROJECT_CREATION, show)
    return () => window.removeEventListener(OPEN_PROJECT_CREATION, show)
  }, [])

  const choosePath = (nextPath: string) => {
    setPath(nextPath)
    if (!nameTouched) setName(folderName(nextPath))
    setBrowsing(false)
  }

  const create = async () => {
    if (!name.trim() || !path.trim()) return
    setBusy(true)
    setError(null)
    try {
      const project = (await api.createProject({
        name: name.trim(),
        path: path.trim(),
      })) as { id: string; name?: string; path?: string }
      useSessionsStore.getState().setProjects([
        ...useSessionsStore.getState().projects,
        { id: project.id, name: name.trim(), path: path.trim() },
      ])
      const draft = useDraftsStore.getState().getOrCreate(project.id)
      setOpen(false)
      await navigate({ to: '/draft/$draftId', params: { draftId: draft.id } })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen} title="Create project">
      <DialogTitle>Create project</DialogTitle>
      <DialogDescription>
        Choose a folder. Forge will use its name until you edit it.
      </DialogDescription>
      <form
        className="project-create-form"
        onSubmit={(event) => {
          event.preventDefault()
          void create()
        }}
      >
        <label>
          Name
          <Input
            required
            value={name}
            onChange={(event) => {
              setNameTouched(true)
              setName(event.target.value)
            }}
          />
        </label>
        <label>
          Folder path
          <Input
            required
            value={path}
            onChange={(event) => setPath(event.target.value)}
          />
        </label>
        <Button
          type="button"
          size="compact"
          onClick={() => setBrowsing((value) => !value)}
          aria-expanded={browsing}
        >
          {browsing ? 'Hide folders' : 'Browse folders'}
        </Button>
        {browsing && (
          <FolderPicker
            initialPath={path || undefined}
            onSelect={choosePath}
            onCancel={() => setBrowsing(false)}
          />
        )}
        {error && (
          <p className="settings-error" role="alert">
            Could not create project: {error}
          </p>
        )}
        <div className="project-create-actions">
          <Button type="button" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={busy}
            disabled={!name.trim() || !path.trim()}
          >
            Create project
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
