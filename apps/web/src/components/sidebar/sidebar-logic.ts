export type SidebarSession = {
  id: string
  title: string
  projectId?: string | null
  kind?: 'chat' | 'subagent' | 'epic_worker' | string
  status?: 'idle' | 'running' | 'errored' | 'archived' | string
  harness?: string
  branch?: string | null
  createdAt?: number | string
  lastActivityAt?: number | string
  snippet?: string
  unread?: boolean
  retention?: 'permanent' | 'discardable'
}

export type SidebarRun = {
  id: string
  status: string
  completed: number
  total: number
}

export const SETTLED_PAGE_SIZE = 25

function timestamp(value: number | string | undefined) {
  if (typeof value === 'number') return value
  return value ? Date.parse(value) || 0 : 0
}

export function visibleSessions(sessions: SidebarSession[]) {
  return sessions.filter(
    (session) =>
      session.kind !== 'subagent' &&
      session.kind !== 'epic_worker' &&
      session.retention !== 'discardable',
  )
}

export function filterScope(
  sessions: SidebarSession[],
  projectId: string | 'all',
) {
  return visibleSessions(sessions).filter(
    (session) => projectId === 'all' || session.projectId === projectId,
  )
}

export function searchSessions(sessions: SidebarSession[], query: string) {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return sessions
  return sessions.filter((session) =>
    [session.title, session.snippet, session.harness, session.branch]
      .filter(Boolean)
      .some((value) => value!.toLocaleLowerCase().includes(needle)),
  )
}

export function sortSessions(
  sessions: SidebarSession[],
  sort: 'updated' | 'created' = 'updated',
) {
  return [...sessions].sort((a, b) => {
    const left = timestamp(sort === 'created' ? a.createdAt : a.lastActivityAt)
    const right = timestamp(sort === 'created' ? b.createdAt : b.lastActivityAt)
    return right - left || a.id.localeCompare(b.id)
  })
}

export function navigationSessions(
  sessions: SidebarSession[],
  view: { scope: string; query: string; sort: 'updated' | 'created' },
) {
  const scoped = sortSessions(
    searchSessions(filterScope(sessions, view.scope), view.query),
    view.sort,
  )
  return partitionSessions(scoped).active
}

export function partitionSessions(sessions: SidebarSession[]) {
  const active = sessions.filter((session) =>
    ['running', 'idle', 'errored'].includes(session.status ?? 'idle'),
  )
  const settled = sessions.filter((session) => session.status === 'archived')
  return { active, settled }
}

export function settledPage(sessions: SidebarSession[], page: number) {
  const count = Math.max(1, Math.ceil(sessions.length / SETTLED_PAGE_SIZE))
  const current = Math.min(Math.max(1, page), count)
  return {
    items: sessions.slice(0, current * SETTLED_PAGE_SIZE),
    page: current,
    hasMore: current < count,
    remaining: Math.max(0, sessions.length - current * SETTLED_PAGE_SIZE),
  }
}

export function jumpTarget(sessions: SidebarSession[], number: number) {
  return number >= 1 && number <= 9 ? sessions[number - 1]?.id : undefined
}

export function relativeTime(
  value: number | string | undefined,
  now = Date.now(),
) {
  if (value === undefined) return ''
  const seconds = Math.max(
    0,
    Math.floor((now - new Date(value).getTime()) / 1000),
  )
  if (seconds < 60) return 'now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}
