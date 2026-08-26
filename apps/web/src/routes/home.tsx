import { Button } from '../components/ui/button'
import { openProjectCreation } from '../components/ProjectCreationDialog'

export function HomeRoute() {
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
