import { useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Anvil, FolderPlus, RotateCw } from 'lucide-react'
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
  // zeron's onboarding card: a faint mark, one line of title, one line of
  // help, and a solid primary button.
  return (
    <div className="grid h-full place-items-center p-6">
      <div className="flex flex-col items-center text-center duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] animate-in fade-in-0 slide-in-from-bottom-1 motion-reduce:animate-none">
        <Anvil
          aria-hidden
          strokeWidth={1.25}
          className="size-12 text-foreground/15"
        />
        <h1 className="mt-6 text-[16px] font-medium text-foreground">
          Welcome to Forge
        </h1>
        <p className="mt-1.5 text-[13px] text-muted-foreground/70">
          Add a project to start a session.
        </p>
        <button
          type="button"
          onClick={openProjectCreation}
          className="mt-5 inline-flex cursor-pointer items-center gap-1.5 rounded-[8px] bg-foreground px-3 py-1.5 text-[13px] font-medium text-background outline-none transition-opacity duration-150 hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:min-h-11"
        >
          <FolderPlus aria-hidden className="size-3.5" />
          Add project
        </button>
      </div>
    </div>
  )
}
