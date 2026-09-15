import { randomUUID } from 'node:crypto'
import dns from 'node:dns/promises'
import { isIP } from 'node:net'
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
  private readonly targets = new Map<string, PreviewTarget>()
  private readonly connections = new Map<string, number>()
  constructor(
    readonly workspaces: WorkspaceTargets,
    private readonly publicOrigin?: string,
  ) {}

  async register(input: unknown): Promise<PreviewTarget> {
    if (this.targets.size >= MAX_TARGETS)
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
  list(sessionId?: string) {
    return [...this.targets.values()].filter(
      (t) => !sessionId || t.sessionId === sessionId,
    )
  }
  remove(id: string) {
    this.targets.delete(id)
    this.connections.delete(id)
  }
  acquire(id: string) {
    const target = this.targets.get(id)
    if (!target || target.status !== 'ready')
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
    const target = this.targets.get(id)
    if (!target)
      throw new PreviewError(
        'preview_not_found',
        'Preview target not found',
        404,
      )
    try {
      const host = new URL(target.origin).hostname
      await dns.lookup(host)
      return true
    } catch {
      return false
    }
  }
  close() {
    this.targets.clear()
    this.connections.clear()
  }
}
