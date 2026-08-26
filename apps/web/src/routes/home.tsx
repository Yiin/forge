import { Button } from '../components/ui/button'
import { openProjectCreation } from '../components/ProjectCreationDialog'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { openNewDraft } from '../lib/draft-entry'

export function HomeRoute() {
  const navigate = useNavigate()
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const open = () => {
    setState('loading')
    void openNewDraft(navigate).then((result) => setState(result.kind === 'empty' ? 'ready' : 'loading')).catch(() => setState('error'))
  }
  useEffect(() => open(), [])
  if (state === 'loading') return <section className="empty-panel" role="status"><p>Loading projects…</p></section>
  if (state === 'error') return <section className="empty-panel"><h1>Forge could not load</h1><p>Try again to open a draft.</p><Button variant="primary" onClick={open}>Try again</Button></section>
  return (
    <section className="empty-panel">
      <h1>Welcome to Forge</h1>
      <p>Add a project to start a session.</p>
      <Button variant="primary" onClick={openProjectCreation}>
        Add project
      </Button>
    </section>
  )
}
