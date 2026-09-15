import { Hono } from 'hono'
import { PreviewError, PreviewManager } from './manager.js'

const MAX_BODY = 8 * 1024 * 1024
const HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'cookie',
  'authorization',
])

function headers(request: Request) {
  const result = new Headers()
  request.headers.forEach((value, key) => {
    if (!HOP_HEADERS.has(key.toLowerCase())) result.set(key, value)
  })
  return result
}

export async function proxyPreview(
  request: Request,
  manager: PreviewManager,
  id: string,
  suffix: string,
) {
  const lease = manager.acquire(id)
  try {
    const source = new URL(lease.target.origin)
    const path = suffix.startsWith('/') ? suffix : `/${suffix}`
    let url = new URL(path + new URL(request.url).search, source)
    if (url.origin !== source.origin)
      throw new PreviewError(
        'preview_forbidden',
        'Preview path escaped the registered origin',
        400,
      )
    let response: Response
    for (let redirects = 0; redirects < 5; redirects++) {
      const length = Number(request.headers.get('content-length') ?? 0)
      if (length > MAX_BODY)
        throw new PreviewError(
          'preview_limit_exceeded',
          'Preview request body is too large',
          413,
        )
      response = await fetch(url, {
        method: request.method,
        headers: headers(request),
        body:
          request.method === 'GET' || request.method === 'HEAD'
            ? undefined
            : request.body,
        redirect: 'manual',
        signal: request.signal,
        // Node fetch requires this for streamed request bodies.
        duplex: 'half',
      } as RequestInit & { duplex: 'half' })
      if (![301, 302, 303, 307, 308].includes(response.status)) return response
      const location = response.headers.get('location')
      if (!location) return response
      const next = new URL(location, url)
      if (next.origin !== source.origin)
        throw new PreviewError(
          'preview_forbidden',
          'Preview redirect escaped the registered origin',
          502,
        )
      url = next
    }
    throw new PreviewError(
      'preview_forbidden',
      'Preview redirect limit exceeded',
      502,
    )
  } finally {
    lease.release()
  }
}

export function previewRoutes(manager: PreviewManager) {
  const app = new Hono()
  app.onError((error, c) => {
    if (error instanceof PreviewError)
      return c.json(
        { error: error.code, message: error.message },
        error.status as 400,
      )
    return c.json(
      {
        error: 'preview_origin_unreachable',
        message: 'Preview service is unavailable',
      },
      502,
    )
  })
  app.post('/api/previews', async (c) =>
    c.json(await manager.register(await c.req.json()), 201),
  )
  app.all('/preview/:id/*', async (c) => {
    const id = c.req.param('id')
    const target = manager.get(id)
    if (!target)
      throw new PreviewError(
        'preview_not_found',
        'Preview target not found',
        404,
      )
    const suffix = c.req.path.slice(`/preview/${id}`.length) || '/'
    return proxyPreview(c.req.raw, manager, id, suffix)
  })
  app.get('/api/previews', (c) => {
    const sessionId = c.req.query('sessionId')
    if (!sessionId)
      throw new PreviewError(
        'preview_forbidden',
        'Session scope is required',
        403,
      )
    return c.json({ targets: manager.list(sessionId) })
  })
  app.get('/api/previews/:id/reachability', async (c) => {
    const target = manager.assertSession(
      c.req.param('id'),
      c.req.query('sessionId') ?? '',
    )
    return c.json({
      reachable: await manager.reachable(target.id),
      status: target.status,
      reason: target.reason,
    })
  })
  app.delete('/api/previews/:id', (c) => {
    manager.assertSession(c.req.param('id'), c.req.query('sessionId') ?? '')
    manager.remove(c.req.param('id'))
    return c.body(null, 204)
  })
  return app
}

/** Routes for the separate listener. It intentionally has no Forge API routes. */
export function previewPublicRoutes(manager: PreviewManager) {
  const app = new Hono()
  app.onError((error, c) => {
    if (error instanceof PreviewError)
      return c.json(
        { error: error.code, message: error.message },
        error.status as 400,
      )
    return c.json(
      {
        error: 'preview_origin_unreachable',
        message: 'Preview service is unavailable',
      },
      502,
    )
  })
  app.all('/preview/:id/*', (c) =>
    proxyPreview(
      c.req.raw,
      manager,
      c.req.param('id'),
      c.req.path.slice(`/preview/${c.req.param('id')}`.length) || '/',
    ),
  )
  return app
}
