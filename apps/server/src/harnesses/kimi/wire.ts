// Wire definitions follow Moonshot AI Kimi Code 0.34.0. See NOTICE.md.
import {
  boundedString,
  sequence,
  KimiError,
  type KimiLimits,
} from './limits.js'
import { object } from './transport.js'
import type { KimiSessionCursor } from './types.js'

export type KimiFrame = Record<string, unknown> & {
  type: string
  payload: Record<string, unknown>
  seq: number
  epoch: string
  session_id: string
  volatile?: boolean
}
export function sessionFrame(
  value: unknown,
  sessionId: string,
  limits: Readonly<KimiLimits>,
): KimiFrame | undefined {
  const frame = object(value)
  const type = boundedString(frame.type, limits.nativeIdBytes)
  if (type === 'resync_required') {
    const payload = object(frame.payload)
    if (
      payload.session_id !== sessionId ||
      !['buffer_overflow', 'session_recreated', 'epoch_changed'].includes(
        String(payload.reason),
      )
    )
      throw new KimiError('kimi_invalid_resync')
    return {
      ...frame,
      type,
      payload,
      session_id: sessionId,
      seq: sequence(payload.current_seq),
      epoch: boundedString(payload.epoch ?? '', limits.cursorBytes, true),
    }
  }
  if (frame.session_id === undefined) return
  if (boundedString(frame.session_id, limits.nativeIdBytes) !== sessionId)
    throw new KimiError('kimi_foreign_session')
  const payload = object(frame.payload)
  if (
    (payload.sessionId !== undefined && payload.sessionId !== sessionId) ||
    (payload.session_id !== undefined && payload.session_id !== sessionId)
  )
    throw new KimiError('kimi_foreign_session')
  return {
    ...frame,
    type,
    session_id: sessionId,
    seq: sequence(frame.seq),
    epoch: boundedString(frame.epoch, limits.cursorBytes, true),
    payload,
  }
}

export function subscriptionAck(
  value: unknown,
  sessionId: string,
  limits: Readonly<KimiLimits>,
): KimiSessionCursor {
  const ack = object(value)
  for (const key of ['accepted', 'not_found', 'resync_required'])
    if (!Array.isArray(ack[key])) throw new KimiError('kimi_invalid_ack')
  if (
    !(ack.accepted as unknown[]).includes(sessionId) ||
    (ack.not_found as unknown[]).includes(sessionId)
  )
    throw new KimiError('kimi_subscription_rejected')
  if ((ack.resync_required as unknown[]).includes(sessionId))
    throw new KimiError('kimi_resync_required')
  const cursor = object(object(ack.cursors)[sessionId])
  return {
    seq: sequence(cursor.seq),
    epoch: boundedString(cursor.epoch, limits.cursorBytes, true),
  }
}

export const requiredRoutes = Object.freeze([
  '/api/v1/meta',
  '/api/v1/models',
  '/api/v1/config',
  '/api/v1/sessions',
  '/api/v1/sessions/{session_id}',
  '/api/v1/sessions/{session_id}/snapshot',
  '/api/v1/sessions/{session_id}/prompts',
  '/api/v1/sessions/{session_id}/prompts:steer',
  '/api/v1/sessions/{session_id}/transcript',
  '/api/v1/sessions/{session_id}/transcript/ops',
  '/api/v1/sessions/{session_id}/transcript/plan',
  '/api/v1/sessions/{session_id}/messages',
  '/api/v1/sessions/{session_id}/questions',
  '/api/v1/sessions/{session_id}/approvals',
  '/api/v1/files',
])

export function validateStartup(
  metaValue: unknown,
  openapiValue: unknown,
  asyncapiValue: unknown,
) {
  const meta = object(metaValue),
    openapi = object(openapiValue),
    asyncapi = object(asyncapiValue)
  if (meta.server_version !== '0.34.0')
    throw new KimiError(
      'kimi_version_unsupported',
      'Kimi requires version 0.34.0',
    )
  if (
    meta.backend !== 'v2' ||
    meta.dangerous_bypass_auth !== false ||
    object(meta.capabilities).websocket !== true
  )
    throw new KimiError('kimi_server_incompatible')
  if (
    object(openapi.info).version !== '0.34.0' ||
    object(asyncapi.info).version !== '0.34.0'
  )
    throw new KimiError('kimi_schema_version')
  const paths = object(openapi.paths)
  // Match parameter names structurally, because names do not change route semantics.
  const normalized = new Set(
    Object.keys(paths).map((path) => path.replace(/\{[^}]+\}/g, '{}')),
  )
  for (const path of requiredRoutes)
    if (!normalized.has(path.replace(/\{[^}]+\}/g, '{}')))
      throw new KimiError('kimi_missing_route')
  const schemas = object(object(asyncapi.components).messages)
  const controls = {
    server_hello: ['protocol_version'],
    client_hello: ['client_id'],
    subscribe: ['session_ids', 'cursors'],
    subscribe_v2: ['session_id', 'transcript', 'transcript_since'],
    subscribe_ack: ['accepted', 'not_found', 'resync_required', 'cursors'],
  }
  for (const [name, fields] of Object.entries(controls)) {
    const envelope = object(object(schemas[name]).payload)
    const properties = object(envelope.properties)
    const payload = object(object(properties.payload).properties)
    for (const field of fields)
      if (!Object.hasOwn(payload, field))
        throw new KimiError('kimi_missing_control')
  }
  // The captured AsyncAPI omits transcript.ops and some lifecycle events. Their pinned source defines them.
}
