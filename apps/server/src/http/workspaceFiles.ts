import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import {
  workspaceFileQuerySchema,
  workspaceFilesQuerySchema,
  workspaceResolveQuerySchema,
  workspaceSaveSchema,
  workspaceSearchQuerySchema,
  workspaceTargetSchema,
  type WorkspaceTarget,
} from '@forge/protocol/workspace'
import { WORKSPACE_LIMITS, WorkspaceFiles } from '../workspace/files.js'
import { filesystemError, WorkspaceError } from '../workspace/paths.js'

function selector(value: {
  kind: string
  sessionId?: string
  projectId?: string
}): WorkspaceTarget {
  return workspaceTargetSchema.parse({
    kind: value.kind,
    ...(value.sessionId !== undefined ? { sessionId: value.sessionId } : {}),
    ...(value.projectId !== undefined ? { projectId: value.projectId } : {}),
  })
}
function query<T extends z.ZodType>(request: Request, schema: T): z.infer<T> {
  const params = new URL(request.url).searchParams
  for (const key of params.keys())
    if (params.getAll(key).length !== 1)
      throw new WorkspaceError(
        'invalid_target',
        400,
        'Duplicate query fields are not allowed',
      )
  return schema.parse(Object.fromEntries(params))
}
async function jsonBody(request: Request, signal: AbortSignal) {
  if (
    Number(request.headers.get('content-length')) >
    WORKSPACE_LIMITS.requestBytes
  )
    throw new WorkspaceError(
      'limit_exceeded',
      413,
      'Request body limit exceeded',
    )
  const reader = request.body?.getReader()
  if (!reader)
    throw new WorkspaceError('invalid_target', 400, 'JSON body is required')
  const abort = () => {
    void reader.cancel(signal.reason).catch(() => {})
  }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      size += value.length
      if (size > WORKSPACE_LIMITS.requestBytes)
        throw new WorkspaceError(
          'limit_exceeded',
          413,
          'Request body limit exceeded',
        )
      chunks.push(value)
    }
    try {
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
      ) as unknown
    } catch {
      throw new WorkspaceError('invalid_target', 400, 'Malformed JSON request')
    }
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
export function workspaceFileRoutes(service: WorkspaceFiles) {
  const app = new Hono()
  app.onError((error, c) => {
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return c.json(
        { error: 'invalid_target', message: 'Malformed workspace request' },
        400,
      )
    const failure = filesystemError(error)
    return c.json(
      {
        error: failure.code,
        message: failure.message,
        ...(failure.workspace ? { workspace: failure.workspace } : {}),
        ...(failure.reason ? { reason: failure.reason } : {}),
        ...(failure.current ? { current: failure.current } : {}),
        ...(failure.publicationMayHaveHappened
          ? { publicationMayHaveHappened: true }
          : {}),
      },
      failure.status,
    )
  })
  app.get('/api/workspace/target', async (c) => {
    const value = query(c.req.raw, workspaceResolveQuerySchema)
    return c.json({
      workspace: await service.resolve(
        selector(value),
        value,
        c.req.raw.signal,
      ),
    })
  })
  app.get('/api/workspace/files', async (c) => {
    const value = query(c.req.raw, workspaceFilesQuerySchema)
    return c.json(await service.list(selector(value), value, c.req.raw.signal))
  })
  app.get('/api/workspace/search', async (c) => {
    const value = query(c.req.raw, workspaceSearchQuerySchema)
    return c.json(
      await service.search(selector(value), value, c.req.raw.signal),
    )
  })
  app.get('/api/workspace/file', async (c) => {
    const value = query(c.req.raw, workspaceFileQuerySchema)
    return c.json(
      await service.read(selector(value), value.path, value, c.req.raw.signal),
    )
  })
  app.on(['GET', 'HEAD'], '/api/workspace/media', async (c) => {
    const value = query(c.req.raw, workspaceFileQuerySchema)
    return service.media(selector(value), value.path, c.req.raw, value)
  })
  app.put('/api/workspace/file', async (c) => {
    const value = workspaceSaveSchema.parse(
      await service.operation(c.req.raw.signal, (signal) =>
        jsonBody(c.req.raw, signal),
      ),
    )
    return c.json(await service.save(value, c.req.raw.signal))
  })
  app.get('/api/workspace/changes', async (c) => {
    const value = query(c.req.raw, workspaceResolveQuerySchema)
    const subscription = await service.watches.subscribe(
      selector(value),
      c.req.raw.signal,
    )
    try {
      service.targets.checkExpected(subscription.workspace, value)
    } catch (error) {
      subscription.close()
      throw error
    }
    return streamSSE(
      c,
      async (stream) => {
        subscription.onStop = () => {
          if (!stream.aborted) stream.abort()
        }
        stream.onAbort(() => subscription.close())
        try {
          while (!stream.aborted) {
            const event = await subscription.next()
            if (!event) break
            let timer: ReturnType<typeof setTimeout> | undefined
            try {
              await Promise.race([
                stream.writeSSE({
                  event: 'workspace_change',
                  id: `${event.watchId}:${event.sequence}`,
                  data: JSON.stringify(event),
                }),
                new Promise<never>((_, reject) => {
                  timer = setTimeout(() => {
                    stream.abort()
                    reject(new Error('Workspace stream stalled'))
                  }, WORKSPACE_LIMITS.timeoutMs)
                }),
              ])
            } finally {
              clearTimeout(timer)
            }
          }
        } finally {
          subscription.close()
        }
      },
      async (_error, stream) => {
        subscription.close()
        stream.abort()
      },
    )
  })
  return app
}
