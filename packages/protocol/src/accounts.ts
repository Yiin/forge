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

export const harnessAccountSnapshotSchema = z.object({
  accountId: z.string(),
  harnessKind: z.string(),
  harnessKey: z.string(),
  displayName: z.string().optional(),
  enabled: z.boolean(),
  installed: z.boolean(),
  version: z.string(),
  status: z.enum(['ready', 'warning', 'error', 'disabled']),
  auth: z.object({
    status: z.enum(['authenticated', 'unauthenticated', 'unknown']),
    email: z.string().optional(),
    label: z.string().optional(),
    type: z.string().optional(),
  }),
  checkedAt: z.string(),
  message: z.string().optional(),
  availability: z.enum(['available', 'unavailable']).optional(),
  unavailableReason: z.string().optional(),
  usage: z
    .array(
      z.object({
        window: z.string(),
        utilization: z.number(),
        resetsAt: z.string().nullable(),
        source: z.string(),
        observedAt: z.string(),
      }),
    )
    .optional(),
  limit: z
    .object({
      kind: z.enum([
        'usage-limit',
        'spend-limit',
        'credits-depleted',
        'auth',
        'rate-limit',
        'unavailable',
      ]),
      detectedAt: z.string(),
      resetsAt: z.string().nullable(),
      resetsAtEstimated: z.boolean(),
      source: z.string(),
      detail: z.string().nullable(),
    })
    .nullable()
    .optional(),
})

export type HarnessAccountSnapshot = z.infer<
  typeof harnessAccountSnapshotSchema
>

export const configResponseSchema = z.object({
  accountsDir: z.string(),
})
export type ConfigResponse = z.infer<typeof configResponseSchema>
