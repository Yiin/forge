import { z } from 'zod'

const uploadProgressSchema = z.object({
  seq: z.null(),
  type: z.literal('uploadProgress'),
  attachmentId: z.string(),
  sessionId: z.string(),
  bytesReceived: z.number().int().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
})

// Ephemeral events are never replayed. Durable UI state comes from message rows.
export const ephemeralSchema = z.discriminatedUnion('type', [
  uploadProgressSchema,
])
export type Ephemeral = z.infer<typeof ephemeralSchema>
