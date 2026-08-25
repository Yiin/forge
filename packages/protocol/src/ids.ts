import { ulid } from 'ulid'
import { z } from 'zod'

export const idKinds = ['prj', 'ses', 'att', 'run', 'itr'] as const
export type IdKind = (typeof idKinds)[number]
const schema = (kind: IdKind) =>
  z.string().regex(new RegExp(`^${kind}_[0-9A-HJKMNP-TV-Z]{26}$`))
export const projectId = schema('prj')
export const sessionId = schema('ses')
export const attachmentId = schema('att')
export const runId = schema('run')
export const iterationId = schema('itr')
export const idSchemas = {
  prj: projectId,
  ses: sessionId,
  att: attachmentId,
  run: runId,
  itr: iterationId,
} as const
export function makeId(kind: IdKind): `${IdKind}_${string}` {
  return `${kind}_${ulid()}`
}
