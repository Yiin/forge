import type { DatabaseSync } from 'node:sqlite'
import { getProject } from './queries.js'

const activity = new WeakMap<DatabaseSync, Map<string, number>>()

export function acquireProjectActivity(db: DatabaseSync, projectId: string) {
  if (!getProject(db, projectId)) throw new Error('Project not found')
  let projects = activity.get(db)
  if (!projects) activity.set(db, (projects = new Map()))
  projects.set(projectId, (projects.get(projectId) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const remaining = projects.get(projectId)! - 1
    if (remaining) projects.set(projectId, remaining)
    else projects.delete(projectId)
  }
}

export async function withProjectActivity<T>(
  db: DatabaseSync,
  projectId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const release = acquireProjectActivity(db, projectId)
  try {
    return await operation()
  } finally {
    release()
  }
}

export function assertProjectIdle(db: DatabaseSync, projectId: string) {
  if (activity.get(db)?.has(projectId))
    throw new Error('Project has active operations')
}
