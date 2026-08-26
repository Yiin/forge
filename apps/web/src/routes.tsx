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
import { DraftRoute } from './routes/draft'
const root = createRootRoute({ component: AppShell })
const index = createRoute({
  getParentRoute: () => root,
  path: '/',
  validateSearch: (value: { new?: string }) => ({ new: value.new }),
  beforeLoad: ({ search }) => {
    if (search.new) return
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
const draft = createRoute({
  getParentRoute: () => root,
  path: '/draft/$draftId',
  component: DraftRoute,
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
  component: FileBrowser,
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
  draft,
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
