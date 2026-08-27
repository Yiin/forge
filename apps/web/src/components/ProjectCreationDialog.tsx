import { useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { AlertCircle, FolderSearch } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Spinner } from './ui/spinner'
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
      useSessionsStore
        .getState()
        .setProjects([
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
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create project</DialogTitle>
          <DialogDescription>
            Choose a folder. Forge will use its name until you edit it.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void create()
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="project-name">Name</Label>
            <Input
              id="project-name"
              required
              value={name}
              onChange={(event) => {
                setNameTouched(true)
                setName(event.target.value)
              }}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="project-path">Folder path</Label>
            <Input
              id="project-path"
              required
              value={path}
              onChange={(event) => setPath(event.target.value)}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-fit"
              onClick={() => setBrowsing((value) => !value)}
              aria-expanded={browsing}
            >
              <FolderSearch />
              {browsing ? 'Hide folders' : 'Browse folders'}
            </Button>
            {browsing && (
              <FolderPicker
                initialPath={path || undefined}
                onSelect={choosePath}
                onCancel={() => setBrowsing(false)}
              />
            )}
          </div>
          {error && (
            <p
              className="flex items-center gap-1.5 text-sm text-destructive"
              role="alert"
            >
              <AlertCircle className="size-4 shrink-0" />
              Could not create project: {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={busy || !name.trim() || !path.trim()}
            >
              {busy && <Spinner />}
              Create project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
