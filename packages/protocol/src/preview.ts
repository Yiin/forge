import { z } from 'zod'

export const previewTargetSchema = z.strictObject({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  workspaceId: z.string().min(1),
  workspaceRevision: z.number().int().positive(),
  origin: z.string().url(),
  publicUrl: z.string().url().nullable(),
  status: z.enum(['ready', 'unavailable', 'removed']),
  reason: z.string().nullable(),
})
export type PreviewTarget = z.infer<typeof previewTargetSchema>

export const previewRegisterSchema = z.strictObject({
  sessionId: z.string().min(1).max(256),
  origin: z.string().url().max(2048),
})
export type PreviewRegister = z.infer<typeof previewRegisterSchema>

export const previewErrorSchema = z.strictObject({
  error: z.enum([
    'preview_unavailable',
    'preview_not_found',
    'preview_forbidden',
    'preview_origin_invalid',
    'preview_origin_unreachable',
    'preview_limit_exceeded',
  ]),
  message: z.string(),
})
