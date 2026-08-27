import { z } from 'zod'

export const harnessAccountSchema = z.object({
  id: z.string().min(1),
  harnessKey: z.string().min(1),
  label: z.string().min(1),
  kind: z.string().min(1),
  homePath: z.string().min(1),
  orderIndex: z.number().int(),
  disabledAt: z.number().int().nullable(),
  createdAt: z.number().int(),
  lastUsedAt: z.number().int().nullable(),
})

export const createHarnessAccountSchema = z.object({
  harnessKey: z.string().trim().min(1),
  label: z.string().trim().min(1),
  kind: z.string().trim().min(1),
  orderIndex: z.number().int().optional(),
})

export const patchHarnessAccountSchema = z
  .object({
    label: z.string().trim().min(1).optional(),
    orderIndex: z.number().int().optional(),
    disabled: z.boolean().optional(),
  })
  .strict()

export type HarnessAccount = z.infer<typeof harnessAccountSchema>
export type CreateHarnessAccount = z.infer<typeof createHarnessAccountSchema>
export type PatchHarnessAccount = z.infer<typeof patchHarnessAccountSchema>
