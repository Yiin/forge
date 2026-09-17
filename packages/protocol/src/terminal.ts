import { z } from 'zod'
import { resolvedWorkspaceSchema } from './workspace.js'

const bytes = (limit: number) =>
  z
    .string()
    .refine(
      (value) => new TextEncoder().encode(value).length <= limit,
      `Exceeds ${limit} UTF-8 bytes`,
    )
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const terminalReasonSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9_]*$/)
const uuid =
  '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
export const terminalEpochSchema = z.string().regex(new RegExp(`^${uuid}$`))
export const terminalIdSchema = z
  .string()
  .regex(new RegExp(`^${uuid}\\.${uuid}$`))
export const terminalTitleSchema = bytes(256)
  .trim()
  .min(1)
  .refine(
    (value) => !/[\u0000-\u001f\u007f-\u009f]/.test(value),
    'Title contains a control character',
  )
export const terminalDimensionsSchema = z
  .object({
    cols: z
      .number()
      .int()
      .safe()
      .transform((value) => Math.min(500, Math.max(2, value))),
    rows: z
      .number()
      .int()
      .safe()
      .transform((value) => Math.min(300, Math.max(1, value))),
  })
  .strict()
export const terminalCreateSchema = terminalDimensionsSchema
  .partial()
  .extend({
    expectedWorkspaceId: bytes(128).min(1),
    expectedWorkspaceRevision: count.positive(),
    title: terminalTitleSchema.optional(),
  })
  .strict()
export const terminalRenameSchema = z
  .object({ title: terminalTitleSchema })
  .strict()
export const terminalInputSchema = z
  .object({ data: z.string().max(87384) })
  .strict()
const time = z.string().datetime({ precision: 3 })
export const terminalDescriptorSchema = z
  .object({
    id: terminalIdSchema,
    serverEpoch: terminalEpochSchema,
    sessionId: bytes(256).min(1),
    projectId: bytes(256).min(1).nullable(),
    workspace: resolvedWorkspaceSchema,
    title: terminalTitleSchema,
    shell: bytes(256).min(1),
    cols: z.number().int().min(2).max(500),
    rows: z.number().int().min(1).max(300),
    state: z.enum(['starting', 'running', 'closing', 'exited', 'unavailable']),
    createdAt: time,
    lastActivityAt: time,
    exitedAt: time.nullable(),
    expiresAt: time.nullable(),
    firstRetainedSeq: count,
    lastSeq: count,
    exitCode: count.nullable(),
    signal: count.nullable(),
    outputComplete: z.boolean().nullable(),
    cleanup: z.enum(['pending', 'complete', 'unknown']),
  })
  .strict()
  .refine(
    (value) =>
      value.id.startsWith(`${value.serverEpoch}.`) &&
      value.workspace.target.kind === 'session' &&
      value.workspace.target.sessionId === value.sessionId &&
      value.workspace.projectId === value.projectId &&
      new TextEncoder().encode(value.workspace.cwd).length <= 4096 &&
      (value.workspace.worktreePath === null ||
        new TextEncoder().encode(value.workspace.worktreePath).length <=
          4096) &&
      new TextEncoder().encode(value.workspace.workspaceId).length <= 128 &&
      Number.isSafeInteger(value.workspace.workspaceRevision) &&
      value.workspace.workspaceRevision > 0,
    'Invalid terminal workspace or epoch ownership',
  )
export type TerminalDescriptor = z.infer<typeof terminalDescriptorSchema>
export type TerminalCreate = z.infer<typeof terminalCreateSchema>
export const terminalInputOutcomeSchema = z
  .object({
    requestedBytes: count.max(65536),
    writtenBytes: count.max(65536),
    status: z.enum([
      'written',
      'timed_out',
      'cancelled',
      'closed',
      'write_failed',
    ]),
  })
  .strict()
  .refine(
    (value) =>
      value.writtenBytes <= value.requestedBytes &&
      (value.status !== 'written' ||
        value.writtenBytes === value.requestedBytes),
    'Invalid input outcome',
  )
export type TerminalInputOutcome = z.infer<typeof terminalInputOutcomeSchema>
export const terminalErrorCodeSchema = z.enum([
  'invalid_request',
  'not_found',
  'previous_server',
  'workspace_changed',
  'no_workspace',
  'unavailable',
  'cleanup_unknown',
  'rollback_cleanup_unknown',
  'capacity',
  'forbidden',
  'unsupported_media_type',
  'input_incomplete',
  'shutdown_busy',
  'shutdown_cleanup_unknown',
  'future_cursor',
  'request_timeout',
])
export type TerminalErrorCode = z.infer<typeof terminalErrorCodeSchema>
export const terminalErrorSchema = z
  .object({
    error: z
      .object({
        code: terminalErrorCodeSchema,
        message: bytes(4096),
        details: z
          .object({
            input: terminalInputOutcomeSchema.optional(),
            sessionId: bytes(256).optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict()
  .refine((value) => {
    const { code, details } = value.error
    if (code === 'input_incomplete')
      return (
        details?.input !== undefined &&
        details.input.status !== 'written' &&
        details.sessionId === undefined
      )
    if (code === 'rollback_cleanup_unknown')
      return details?.sessionId !== undefined && details.input === undefined
    return details === undefined
  }, 'Invalid error details')
export type TerminalErrorBody = z.infer<typeof terminalErrorSchema>
export const terminalReplayGapSchema = z
  .object({ fromSeq: count, toSeq: count, reason: z.literal('evicted') })
  .strict()
export const terminalDataEventSchema = z
  .object({
    type: z.literal('data'),
    terminalId: terminalIdSchema,
    seq: count.positive(),
    data: z.string(),
  })
  .strict()
export const terminalExitEventSchema = z
  .object({
    type: z.literal('exit'),
    terminalId: terminalIdSchema,
    seq: count.positive(),
    exitCode: count.nullable(),
    signal: count.nullable(),
    outputComplete: z.boolean(),
    cleanup: z.enum(['complete', 'unknown']),
    reason: terminalReasonSchema,
  })
  .strict()
export const terminalSnapshotSchema = z
  .object({
    type: z.literal('snapshot'),
    descriptor: terminalDescriptorSchema,
    requestedAfterSeq: count,
    firstRetainedSeq: count,
    lastSeq: count,
    replayGap: terminalReplayGapSchema.nullable(),
  })
  .strict()
export const terminalEventSchema = z.discriminatedUnion('type', [
  terminalSnapshotSchema,
  terminalDataEventSchema,
  terminalExitEventSchema,
])
export type TerminalEvent = z.infer<typeof terminalEventSchema>
export const terminalCollectionSchema = z
  .object({
    serverEpoch: terminalEpochSchema,
    terminals: z.array(terminalDescriptorSchema).max(32),
  })
  .strict()

export const terminalAccessSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('loopback') }).strict(),
  z
    .object({
      mode: z.literal('explicit'),
      allowedOrigins: z.array(bytes(256).min(1)).min(1).max(32),
      allowedHostAuthorities: z.array(bytes(256).min(1)).min(1).max(32),
    })
    .strict(),
])
export type TerminalAccess = z.infer<typeof terminalAccessSchema>
