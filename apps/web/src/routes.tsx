import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router'
import { AppShell } from './components/AppShell'
import { FileBrowser } from './components/files/FileBrowser'
import { readLastSession } from './lib/shell-storage'
import { SessionRoute } from './routes/session'
import { HomeRoute } from './routes/home'
import { SearchRoute } from './routes/search'
import { RunsRoute } from './routes/runs'
import { RunRoute } from './routes/run'
import { SettingsLayout } from './routes/settings'
import {
  GeneralSettings,
  HarnessSettings,
  ProjectSettings,
  EpicSettings,
  AboutSettings,
} from './routes/settings-pages'
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
  component: HomeRoute,
})
const session = createRoute({
  getParentRoute: () => root,
  path: '/s/$sessionId',
  component: SessionRoute,
})
const runs = createRoute({
  getParentRoute: () => root,
  path: '/runs',
  component: RunsRoute,
})
const run = createRoute({
  getParentRoute: () => root,
  path: '/runs/$runId',
  component: RunRoute,
})
const files = createRoute({
  getParentRoute: () => root,
  path: '/files/$projectId/$',
  component: FileBrowser,
})
const filesIndex = createRoute({
  getParentRoute: () => root,
  path: '/files',
  component: empty('Files'),
})
const search = createRoute({
  getParentRoute: () => root,
  path: '/search',
  validateSearch: (value: { q?: string; scope?: string }) => ({
    q: value.q ?? '',
    scope: (['all', 'sessions', 'messages', 'runs'] as const).includes(
      value.scope as never,
    )
      ? (value.scope as 'all' | 'sessions' | 'messages' | 'runs')
      : 'all',
  }),
  component: SearchRoute,
})
const settings = createRoute({
  getParentRoute: () => root,
  path: '/settings',
  component: SettingsLayout,
})
const settingsGeneral = createRoute({
  getParentRoute: () => settings,
  path: '/',
  component: GeneralSettings,
})
const settingsHarnesses = createRoute({
  getParentRoute: () => settings,
  path: '/harnesses',
  component: HarnessSettings,
})
const settingsProjects = createRoute({
  getParentRoute: () => settings,
  path: '/projects',
  component: ProjectSettings,
})
const settingsEpics = createRoute({
  getParentRoute: () => settings,
  path: '/epics',
  component: EpicSettings,
})
const settingsAbout = createRoute({
  getParentRoute: () => settings,
  path: '/about',
  component: AboutSettings,
})
const tree = root.addChildren([
  index,
  session,
  runs,
  run,
  files,
  filesIndex,
  search,
  settings.addChildren([
    settingsGeneral,
    settingsHarnesses,
    settingsProjects,
    settingsEpics,
    settingsAbout,
  ]),
])
export const router = createRouter({ routeTree: tree })
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
