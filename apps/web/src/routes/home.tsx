import { useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { FolderPlus, RotateCw } from 'lucide-react'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { openProjectCreation } from '../components/ProjectCreationDialog'
import { openNewDraft } from '../lib/draft-entry'

export function HomeRoute() {
  const navigate = useNavigate()
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const open = () => {
    setState('loading')
    void openNewDraft(navigate)
      .then((result) => setState(result.kind === 'empty' ? 'ready' : 'loading'))
      .catch(() => setState('error'))
  }
  useEffect(() => open(), [])
  if (state === 'loading')
    return (
      <Empty className="h-full" role="status">
        <EmptyHeader>
          <EmptyMedia>
            <Spinner className="size-6" />
          </EmptyMedia>
          <EmptyTitle>Loading projects…</EmptyTitle>
        </EmptyHeader>
      </Empty>
    )
  if (state === 'error')
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyTitle>Forge could not load</EmptyTitle>
          <EmptyDescription>Try again to open a draft.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button onClick={open}>
            <RotateCw />
            Try again
          </Button>
        </EmptyContent>
      </Empty>
    )
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyTitle
          role="heading"
          aria-level={1}
          className="text-2xl font-semibold tracking-tight"
        >
          Welcome to Forge
        </EmptyTitle>
        <EmptyDescription>Add a project to start a session.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button onClick={openProjectCreation}>
          <FolderPlus />
          Add project
        </Button>
      </EmptyContent>
    </Empty>
  )
}
