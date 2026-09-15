import { Hono, type Context } from 'hono'
import type { IncomingMessage } from 'node:http'
import { terminalInputSchema } from '@forge/protocol/terminal'
import type { TerminalManager } from '../terminals/manager.js'
import type { TerminalAuthority } from '../terminals/origin.js'
import { TerminalError } from '../terminals/error.js'
import type { WebSocketUpgrades } from '../ws-upgrade.js'

export class TerminalRequests {
  private active = 0
  private stopping = false
  private readonly pending = new Set<Promise<unknown>>()
  constructor(
    private readonly max: number,
    private readonly deadlineMs: number,
  ) {}
  stopAccepting() {
    this.stopping = true
  }
  get count() {
    return this.active
  }
  async settled() {
    await Promise.allSettled(this.pending)
  }
  run(
    c: Context,
    operation: (
      signal: AbortSignal,
      settleOnAbort: () => void,
    ) => Promise<Response> | Response,
  ) {
    if (this.stopping)
      return c.json(
        new TerminalError(
          'unavailable',
          503,
          'Terminal shutdown is in progress',
        ).body(),
        503,
      )
    if (this.active >= this.max)
      return c.json(
        new TerminalError(
          'capacity',
          429,
          'Terminal request capacity reached',
        ).body(),
        429,
      )
    this.active++
    const controller = new AbortController()
    const cancel = () => controller.abort()
    c.req.raw.signal.addEventListener('abort', cancel, { once: true })
    const incoming = (c.env as { incoming?: IncomingMessage }).incoming
    incoming?.once('aborted', cancel)
    if (c.req.raw.signal.aborted || incoming?.aborted) cancel()
    let timer: ReturnType<typeof setTimeout> | undefined
    let settlesOnAbort = false
    const timeout = new Promise<Response>((resolve) => {
      timer = setTimeout(() => {
        controller.abort()
        // Admitted input settles synchronously on abort. Preserve its exact outcome,
        // even when an event-loop stall delays both input and request deadlines.
        resolve(
          settlesOnAbort
            ? result
            : c.json(
                new TerminalError(
                  'request_timeout',
                  503,
                  'Terminal request deadline reached',
                ).body(),
                503,
              ),
        )
      }, this.deadlineMs)
    })
    const result: Promise<Response> = Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted()
        return operation(controller.signal, () => {
          settlesOnAbort = true
        })
      })
      .catch((error) => {
        const failure =
          error instanceof TerminalError
            ? error
            : new TerminalError('unavailable', 503, 'Terminal operation failed')
        return c.json(failure.body(), failure.status)
      })
    this.pending.add(result)
    void result.finally(() => {
      if (timer) clearTimeout(timer)
      this.active--
      this.pending.delete(result)
      c.req.raw.signal.removeEventListener('abort', cancel)
      incoming?.removeListener('aborted', cancel)
    })
    return Promise.race([result, timeout])
  }
}
async function body(c: Context, limit: number, signal: AbortSignal) {
  const type = c.req.header('content-type')
  if (
    !type ||
    !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(
      type,
    )
  )
    throw new TerminalError(
      'unsupported_media_type',
      415,
      'Terminal requests require application/json',
    )
  const reader = c.req.raw.body?.getReader()
  if (!reader)
    throw new TerminalError('invalid_request', 400, 'A JSON body is required')
  const chunks: Uint8Array[] = []
  let size = 0
  let cancelling: Promise<void> | undefined
  const cancel = () => {
    cancelling ??= reader.cancel().catch(() => {})
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > limit) {
        cancel()
        throw new TerminalError(
          'invalid_request',
          400,
          'Terminal request body exceeds its byte limit',
        )
      }
      chunks.push(next.value)
    }
    signal.throwIfAborted()
    try {
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          Buffer.concat(chunks, size),
        ),
      ) as unknown
    } catch {
      throw new TerminalError('invalid_request', 400, 'Invalid JSON body')
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    if (cancelling) await cancelling
    reader.releaseLock()
  }
}
export function terminalRoutes(
  manager: TerminalManager,
  authority: TerminalAuthority,
  upgrades: WebSocketUpgrades,
  requests: TerminalRequests,
) {
  const app = new Hono()
  const prefix = '/api/sessions/:sessionId/terminals'
  const route =
    (
      operation: (
        c: Context,
        signal: AbortSignal,
        settleOnAbort: () => void,
      ) => Promise<Response> | Response,
    ) =>
    (c: Context) =>
      requests.run(c, (signal, settleOnAbort) => {
        const incoming = (c.env as { incoming?: IncomingMessage }).incoming
        if (!incoming)
          throw new TerminalError(
            'unavailable',
            503,
            'Terminal routes require the Node listener',
          )
        authority.check(
          incoming,
          c.req.method !== 'GET' || c.req.path.endsWith('/events'),
        )
        return operation(c, signal, settleOnAbort)
      })
  const ids = (c: Context) =>
    [c.req.param('sessionId') ?? '', c.req.param('terminalId') ?? ''] as const
  app.get(
    prefix,
    route((c) => c.json(manager.list(ids(c)[0]))),
  )
  app.post(
    prefix,
    route(async (c, signal) =>
      c.json(
        await manager.create(
          ids(c)[0],
          await body(c, manager.limits.bodyBytes, signal),
          signal,
        ),
        201,
      ),
    ),
  )
  app.get(
    `${prefix}/:terminalId`,
    route((c) => c.json(manager.get(...ids(c)))),
  )
  app.patch(
    `${prefix}/:terminalId`,
    route(async (c, signal) =>
      c.json(
        manager.rename(
          ...ids(c),
          await body(c, manager.limits.bodyBytes, signal),
        ),
      ),
    ),
  )
  app.post(
    `${prefix}/:terminalId/input`,
    route(async (c, signal, settleOnAbort) => {
      const parsed = terminalInputSchema.safeParse(
        await body(c, manager.limits.inputBodyBytes, signal),
      )
      if (!parsed.success)
        throw new TerminalError(
          'invalid_request',
          400,
          'Invalid terminal input request',
        )
      const input = manager.input(...ids(c), parsed.data.data, signal)
      settleOnAbort()
      return c.json(await input)
    }),
  )
  app.post(
    `${prefix}/:terminalId/resize`,
    route(async (c, signal) =>
      c.json(
        manager.resize(
          ...ids(c),
          await body(c, manager.limits.bodyBytes, signal),
        ),
      ),
    ),
  )
  app.delete(
    `${prefix}/:terminalId`,
    route(async (c) => c.json(await manager.close(...ids(c)))),
  )
  app.get(
    `${prefix}/:terminalId/events`,
    route(async (c) => {
      const query = new URL(c.req.url).searchParams
      if (
        [...query.keys()].some((key) => key !== 'afterSeq') ||
        query.getAll('afterSeq').length > 1
      )
        throw new TerminalError(
          'invalid_request',
          400,
          'Invalid terminal cursor',
        )
      const text = query.get('afterSeq') ?? '0'
      if (!/^(0|[1-9][0-9]*)$/.test(text))
        throw new TerminalError(
          'invalid_request',
          400,
          'Invalid terminal cursor',
        )
      const subscription = manager.reserveSubscription(...ids(c), Number(text))
      const incoming = (c.env as { incoming: IncomingMessage }).incoming
      let registered = false
      try {
        upgrades.opening(incoming, subscription.releaseOpening)
        registered = true
        return await upgrades.upgradeWebSocket(c, {
          onOpen: (_event, ws) => subscription.open(ws.raw!),
          onClose: subscription.releaseOpening,
        })
      } catch (error) {
        if (!registered) subscription.releaseOpening()
        throw error
      }
    }),
  )
  return app
}
