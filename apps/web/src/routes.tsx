import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router'
import { AppShell } from './components/AppShell'
import { readLastSession } from './lib/shell-storage'
const root = createRootRoute({ component: AppShell })
const empty =
  (title: string, text = 'This area is ready for the next feature.') =>
  () => (
    <section className="empty-panel">
      <h1>{title}</h1>
      <p>{text}</p>
    </section>
  )
const index = createRoute({
  getParentRoute: () => root,
  path: '/',
  beforeLoad: () => {
    const id = readLastSession()
    if (id) throw redirect({ to: '/s/$sessionId', params: { sessionId: id } })
  },
  component: empty(
    'Welcome to Forge',
    'Add a project to start your first session.',
  ),
})
const session = createRoute({
  getParentRoute: () => root,
  path: '/s/$sessionId',
  component: empty('Session'),
})
const runs = createRoute({
  getParentRoute: () => root,
  path: '/runs',
  component: empty('Epic runs'),
})
const run = createRoute({
  getParentRoute: () => root,
  path: '/runs/$runId',
  component: empty('Epic run'),
})
const files = createRoute({
  getParentRoute: () => root,
  path: '/files/$projectId/$',
  component: empty('Project files'),
})
const search = createRoute({
  getParentRoute: () => root,
  path: '/search',
  component: empty('Search'),
})
const settings = createRoute({
  getParentRoute: () => root,
  path: '/settings',
  component: empty('Settings'),
})
const settingsHarnesses = createRoute({
  getParentRoute: () => settings,
  path: '/harnesses',
  component: empty('Settings · harnesses'),
})
const settingsProjects = createRoute({
  getParentRoute: () => settings,
  path: '/projects',
  component: empty('Settings · projects'),
})
const settingsAbout = createRoute({
  getParentRoute: () => settings,
  path: '/about',
  component: empty('Settings · about'),
})
const tree = root.addChildren([
  index,
  session,
  runs,
  run,
  files,
  search,
  settings.addChildren([settingsHarnesses, settingsProjects, settingsAbout]),
])
export const router = createRouter({ routeTree: tree })
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
