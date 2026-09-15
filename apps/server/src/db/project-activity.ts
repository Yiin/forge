import type { DatabaseSync } from 'node:sqlite'
import { getProject } from './queries.js'

const activity = new WeakMap<DatabaseSync, Map<string, number>>()

export async function withProjectActivity<T>(
  db: DatabaseSync,
  projectId: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (!getProject(db, projectId)) throw new Error('Project not found')
  let projects = activity.get(db)
  if (!projects) activity.set(db, (projects = new Map()))
  projects.set(projectId, (projects.get(projectId) ?? 0) + 1)
  try {
    return await operation()
  } finally {
    const remaining = projects.get(projectId)! - 1
    if (remaining) projects.set(projectId, remaining)
    else projects.delete(projectId)
  }
}

export function assertProjectIdle(db: DatabaseSync, projectId: string) {
  if (activity.get(db)?.has(projectId))
    throw new Error('Project has active operations')
}
