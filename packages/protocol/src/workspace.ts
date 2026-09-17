import { z } from 'zod'

const id = z.string().min(1).max(256)
export const workspaceTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('session'), sessionId: id }),
  z.strictObject({ kind: z.literal('project'), projectId: id }),
  z.strictObject({ kind: z.literal('none') }),
])
export type WorkspaceTarget = z.infer<typeof workspaceTargetSchema>
export const resolvedWorkspaceSchema = z.object({
  target: z.discriminatedUnion('kind', [
    workspaceTargetSchema.options[0],
    workspaceTargetSchema.options[1],
  ]),
  projectId: id.nullable(),
  cwd: z.string(),
  worktreePath: z.string().nullable(),
  workspaceId: z.string(),
  workspaceRevision: z.number().int().positive(),
})
export type ResolvedWorkspace = z.infer<typeof resolvedWorkspaceSchema>
const expected = {
  expectedWorkspaceId: z.string().min(1).max(128).optional(),
  expectedWorkspaceRevision: z.coerce.number().int().positive().optional(),
}
const selector = {
  kind: z.enum(['session', 'project', 'none']),
  sessionId: id.optional(),
  projectId: id.optional(),
  ...expected,
}
const flags = {
  includeHidden: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  includeIgnored: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
}
const path = z.string().max(4096)
export const workspaceResolveQuerySchema = z.strictObject(selector)
export const workspaceFilesQuerySchema = z.strictObject({
  ...selector,
  ...flags,
  path: path.default(''),
  cursor: z.string().max(8192).optional(),
})
export const workspaceSearchQuerySchema = z.strictObject({
  ...selector,
  ...flags,
  query: z.string().trim().min(1).max(256),
  limit: z.coerce.number().int().min(1).max(200).default(200),
})
export const workspaceFileQuerySchema = z.strictObject({ ...selector, path })
export const workspaceSaveSchema = z.strictObject({
  target: z.strictObject({ kind: z.literal('session'), sessionId: id }),
  path,
  expectedWorkspaceId: z.string().min(1).max(128),
  expectedWorkspaceRevision: z.number().int().positive(),
  expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/),
  expectedFileRevision: z.string().min(1).max(256),
  text: z.string().max(1_048_576),
})
export type WorkspaceSave = z.infer<typeof workspaceSaveSchema>
export const workspaceTextSchema = z.object({
  path: z.string(),
  text: z.string().nullable(),
  contentHash: z.string().nullable(),
  fileRevision: z.string(),
  sizeBytes: z.number(),
  modifiedAt: z.string(),
  encoding: z.enum(['utf8', 'utf8Bom', 'binary', 'unsupported']),
  lineEnding: z.enum(['lf', 'crlf', 'mixed', 'none']).nullable(),
  readOnlyReason: z
    .enum([
      'binary',
      'unsupportedEncoding',
      'mixedLineEndings',
      'symlink',
      'tooLarge',
      'permissionDenied',
      'notRegularFile',
    ])
    .nullable(),
  truncated: z.boolean(),
})
export type WorkspaceText = z.infer<typeof workspaceTextSchema>
export const workspaceEntrySchema = z.object({
  path: z.string(),
  name: z.string(),
  type: z.enum(['directory', 'file', 'symlink', 'other']),
  sizeBytes: z.number().nullable(),
  modifiedAt: z.string().nullable(),
  ignored: z.boolean(),
})
export type WorkspaceEntry = z.infer<typeof workspaceEntrySchema>
export const workspacePartialReasonSchema = z.enum([
  'scan_limit',
  'metadata_limit',
  'timeout',
  'unreadable',
  'race',
])
export type WorkspacePartialReason = z.infer<
  typeof workspacePartialReasonSchema
>
export const workspaceListingSchema = z.object({
  workspace: resolvedWorkspaceSchema,
  entries: z.array(workspaceEntrySchema),
  nextCursor: z.string().nullable(),
  truncated: z.boolean(),
  partialReasons: z.array(workspacePartialReasonSchema),
})
export type WorkspaceListing = z.infer<typeof workspaceListingSchema>
export const workspaceSearchSchema = z.object({
  workspace: resolvedWorkspaceSchema,
  matches: z.array(workspaceEntrySchema.extend({ score: z.number() })),
  truncated: z.boolean(),
  partialReasons: z.array(workspacePartialReasonSchema),
})
export type WorkspaceSearch = z.infer<typeof workspaceSearchSchema>
export const workspaceSnapshotSchema = z.object({
  workspace: resolvedWorkspaceSchema,
  file: workspaceTextSchema,
})
export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>
export const workspaceErrorSchema = z.object({
  error: z.enum([
    'no_workspace',
    'target_not_found',
    'root_unavailable',
    'invalid_target',
    'invalid_path',
    'file_not_found',
    'prohibited_path',
    'read_only',
    'limit_exceeded',
    'busy',
    'unavailable',
    'interrupted',
    'stale_read',
    'conflict',
    'publication_uncertain',
  ]),
  message: z.string(),
  workspace: resolvedWorkspaceSchema.optional(),
  reason: z
    .enum([
      'workspace_changed',
      'changed',
      'deleted',
      'replaced',
      'not_regular_file',
      'listing_changed',
    ])
    .optional(),
  current: workspaceTextSchema.optional(),
  publicationMayHaveHappened: z.boolean().optional(),
})
export type WorkspaceErrorCode = z.infer<typeof workspaceErrorSchema>['error']
export type WorkspaceConflictReason = z.infer<
  typeof workspaceErrorSchema
>['reason']
export const workspaceChangeSchema = z.object({
  watchId: z.string(),
  sequence: z.number().int(),
  workspace: resolvedWorkspaceSchema,
  paths: z.array(z.string()),
  resyncRequired: z.boolean(),
  mode: z.enum(['native', 'repair_only', 'unavailable']),
  targetChanged: z.boolean().optional(),
})
export type WorkspaceChange = z.infer<typeof workspaceChangeSchema>
