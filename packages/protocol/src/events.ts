import { z } from 'zod'

const uploadProgressSchema = z.object({
  seq: z.null(),
  type: z.literal('uploadProgress'),
  attachmentId: z.string(),
  sessionId: z.string(),
  bytesReceived: z.number().int().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
})

const sessionStatusSchema = z.object({
  seq: z.null(),
  type: z.literal('sessionStatus'),
  sessionId: z.string(),
  status: z.string(),
})

const epicRunStatusSchema = z.object({
  seq: z.null(),
  type: z.literal('epicRunStatus'),
  runId: z.string(),
  status: z.string(),
})

// Ephemeral events are never replayed. Durable UI state comes from message rows.
export const ephemeralSchema = z.discriminatedUnion('type', [
  uploadProgressSchema,
  sessionStatusSchema,
  epicRunStatusSchema,
])
export type Ephemeral = z.infer<typeof ephemeralSchema>
