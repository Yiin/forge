import { randomUUID } from 'node:crypto'
import { isIP, Socket } from 'node:net'
import {
  previewRegisterSchema,
  type PreviewTarget,
} from '@forge/protocol/preview'
import type { WorkspaceResolution } from '../workspace/target.js'
import { WorkspaceTargets } from '../workspace/target.js'

const MAX_TARGETS = 32
const MAX_CONNECTIONS = 64

export class PreviewError extends Error {
  constructor(
    readonly code:
      | 'preview_unavailable'
      | 'preview_not_found'
      | 'preview_forbidden'
      | 'preview_origin_invalid'
      | 'preview_origin_unreachable'
      | 'preview_limit_exceeded',
    message: string,
    readonly status = code === 'preview_not_found' ? 404 : 400,
  ) {
    super(message)
  }
}

function isLoopback(hostname: string) {
  hostname = hostname.replace(/^\[|\]$/g, '')
  if (hostname === 'localhost' || hostname === '::1') return true
  return isIP(hostname) === 4 && hostname.split('.')[0] === '127'
}

export function normalizePreviewOrigin(value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new PreviewError(
      'preview_origin_invalid',
      'Preview origin is not a URL',
    )
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    !isLoopback(url.hostname)
  )
    throw new PreviewError(
      'preview_origin_invalid',
      'Preview origin must be an HTTP(S) loopback URL without credentials',
    )
  if (url.pathname !== '/' || url.search || url.hash)
    throw new PreviewError(
      'preview_origin_invalid',
      'Preview origin cannot contain a path, query, or fragment',
    )
  url.pathname = ''
  return url.origin
}

export class PreviewManager {
  private closed = false
  private readonly probes = new Map<Socket, Promise<boolean>>()
  private readonly targets = new Map<string, PreviewTarget>()
  private readonly connections = new Map<string, number>()
  constructor(
    readonly workspaces: WorkspaceTargets,
    private readonly publicOrigin?: string,
  ) {}

  async register(input: unknown): Promise<PreviewTarget> {
    if (this.closed || this.targets.size >= MAX_TARGETS)
      throw new PreviewError(
        'preview_limit_exceeded',
        'Preview target limit exceeded',
        429,
      )
    const value = previewRegisterSchema.parse(input)
    const origin = normalizePreviewOrigin(value.origin)
    let workspace: WorkspaceResolution
    try {
      workspace = await this.workspaces.resolve({
        kind: 'session',
        sessionId: value.sessionId,
      })
    } catch {
      throw new PreviewError(
        'preview_forbidden',
        'Session workspace is unavailable',
        403,
      )
    }
    if (this.closed)
      throw new PreviewError('preview_unavailable', 'Preview manager is closed')
    const id = randomUUID()
    const target: PreviewTarget = {
      id,
      sessionId: value.sessionId,
      workspaceId: workspace.workspaceId,
      workspaceRevision: workspace.workspaceRevision,
      origin,
      publicUrl: this.publicOrigin
        ? `${this.publicOrigin.replace(/\/$/, '')}/preview/${id}/`
        : null,
      status: this.publicOrigin ? 'ready' : 'unavailable',
      reason: this.publicOrigin
        ? null
        : 'Public preview origin is not configured',
    }
    this.targets.set(id, target)
    this.connections.set(id, 0)
    return target
  }
  get(id: string) {
    return this.targets.get(id)
  }
  list(sessionId: string) {
    return [...this.targets.values()].filter((t) => t.sessionId === sessionId)
  }
  assertSession(id: string, sessionId: string) {
    const target = this.targets.get(id)
    if (!target)
      throw new PreviewError(
        'preview_not_found',
        'Preview target not found',
        404,
      )
    if (target.sessionId !== sessionId)
      throw new PreviewError(
        'preview_forbidden',
        'Preview target is not part of this session',
        403,
      )
    return target
  }
  remove(id: string) {
    this.targets.delete(id)
    this.connections.delete(id)
  }
  acquire(id: string) {
    const target = this.targets.get(id)
    if (this.closed || !target || target.status !== 'ready')
      throw new PreviewError(
        'preview_not_found',
        'Preview target not found',
        404,
      )
    const count = this.connections.get(id) ?? 0
    if (count >= MAX_CONNECTIONS)
      throw new PreviewError(
        'preview_limit_exceeded',
        'Preview connection limit exceeded',
        429,
      )
    this.connections.set(id, count + 1)
    return {
      target,
      release: () =>
        this.connections.set(
          id,
          Math.max(0, (this.connections.get(id) ?? 1) - 1),
        ),
    }
  }
  async reachable(id: string) {
    const lease = this.acquire(id)
    const url = new URL(lease.target.origin)
    const socket = new Socket()
    let connected = false
    let settle!: (result: boolean) => void
    const result = new Promise<boolean>((resolve) => {
      settle = resolve
    })
    this.probes.set(socket, result)
    const timer = setTimeout(() => socket.destroy(), 3000)
    socket.once('connect', () => {
      connected = true
      socket.destroy()
    })
    socket.once('error', () => socket.destroy())
    socket.once('close', () => {
      clearTimeout(timer)
      this.probes.delete(socket)
      lease.release()
      settle(connected)
    })
    try {
      socket.connect({
        host:
          url.hostname === 'localhost'
            ? '127.0.0.1'
            : url.hostname.replace(/^\[|\]$/g, ''),
        port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
      })
    } catch {
      socket.destroy()
    }
    return result
  }
  async close() {
    this.closed = true
    const pending = [...this.probes.values()]
    for (const socket of this.probes.keys()) socket.destroy()
    await Promise.all(pending)
    this.targets.clear()
    this.connections.clear()
  }
}
