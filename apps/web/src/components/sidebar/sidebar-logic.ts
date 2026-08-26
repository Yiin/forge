export type SidebarSession = {
  id: string
  title: string
  projectId?: string | null
  kind?: 'chat' | 'subagent' | 'epic_worker' | string
  status?: 'idle' | 'running' | 'errored' | 'archived' | string
  harness?: string
  lastActivityAt?: number | string
  snippet?: string
  unread?: boolean
}

export type SidebarRun = {
  id: string
  status: string
  completed: number
  total: number
}

export const SETTLED_PAGE_SIZE = 25

export function visibleSessions(sessions: SidebarSession[]) {
  return sessions.filter(
    (session) => session.kind !== 'subagent' && session.kind !== 'epic_worker',
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

export function relativeTime(value: number | string | undefined, now = Date.now()) {
  if (value === undefined) return ''
  const seconds = Math.max(0, Math.floor((now - new Date(value).getTime()) / 1000))
  if (seconds < 60) return 'now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}
