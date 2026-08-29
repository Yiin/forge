import { z } from 'zod'

export const modelSourceSchema = z.enum(['acp', 'static', 'custom', 'none'])
export type ModelSource = z.infer<typeof modelSourceSchema>

export const modelEntrySchema = z.object({
  id: z.string(),
  displayName: z.string(),
  description: z.string().optional(),
  isDefault: z.boolean().optional(),
})
export type ModelEntry = z.infer<typeof modelEntrySchema>

export const modelCatalogSchema = z.object({
  accountId: z.string(),
  harnessKey: z.string(),
  models: z.array(modelEntrySchema),
  source: modelSourceSchema,
  updatedAt: z.number().int(),
  warning: z.string().optional(),
})
export type ModelCatalog = z.infer<typeof modelCatalogSchema>
