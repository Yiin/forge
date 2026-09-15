import { useEffect, useState } from 'react'
import {
  resolvedWorkspaceSchema,
  type ResolvedWorkspace,
} from '@forge/protocol/workspace'

export function useWorkspaceTarget(sessionId: string, workspaceKey = '') {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<{
    sessionId: string
    workspaceKey: string
    attempt: number
    target?: ResolvedWorkspace
    error?: string
  }>()
  useEffect(() => {
    const controller = new AbortController()
    let active = true
    void (async () => {
      try {
        const query = new URLSearchParams({ kind: 'session', sessionId })
        const response = await fetch(`/api/workspace/target?${query}`, {
          signal: controller.signal,
        })
        if (!response.ok)
          throw Error(
            `Workspace target could not be loaded (${response.status})`,
          )
        const body = await response.json()
        const target = resolvedWorkspaceSchema.parse(body.workspace)
        if (
          target.target.kind !== 'session' ||
          target.target.sessionId !== sessionId
        )
          throw Error('Workspace target belongs to another session')
        if (active) setState({ sessionId, workspaceKey, attempt, target })
      } catch (error) {
        if (active)
          setState({
            sessionId,
            workspaceKey,
            attempt,
            error:
              error instanceof Error
                ? error.message
                : 'Workspace target could not be loaded',
          })
      }
    })()
    return () => {
      active = false
      controller.abort()
    }
  }, [sessionId, workspaceKey, attempt])
  const current =
    state?.sessionId === sessionId &&
    state.workspaceKey === workspaceKey &&
    state.attempt === attempt
      ? state
      : undefined
  return {
    target: current?.target ?? { cwd: null },
    error: current?.error,
    retry: () => setAttempt((value) => value + 1),
  }
}
