import { z } from 'zod'

export const uploadInitSchema = z.object({
  filename: z.string().min(1).max(1024),
  mime: z.string().min(1).max(255),
  sizeBytes: z.number().int().nonnegative(),
})

export const uploadInitResponseSchema = z.object({
  attachmentId: z.string(),
  putUrl: z.string(),
})

export type UploadInit = z.infer<typeof uploadInitSchema>
export type UploadInitResponse = z.infer<typeof uploadInitResponseSchema>
