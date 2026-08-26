import { z } from 'zod'

export const roleNames = [
  'iteration-worker',
  'triage-control',
  'title-generation',
] as const
export const roleName = z.enum(roleNames)
export const hop = z.object({
  harness: z.string().trim().min(1),
  model: z.string().trim().min(1).optional(),
})
export const rolePolicy = z
  .object({
    roles: z.partialRecord(roleName, z.string().trim().min(1)),
    tiers: z.record(z.string().trim().min(1), z.array(hop)),
  })
  .strict()
export const epicRunConfig = z
  .object({
    workerCount: z
      .number()
      .int('Worker count must be a whole number.')
      .positive('Worker count must be a positive number.')
      .max(32, 'Worker count must be 32 or fewer.')
      .optional(),
    mode: z.enum(['pool', 'serial', 'auto']).optional(),
    gateCommand: z.union([z.string(), z.array(z.string())]).optional(),
    installCommand: z.union([z.string(), z.array(z.string())]).optional(),
    rolePolicy: rolePolicy.optional(),
  })
  .strict()

export type RoleName = z.infer<typeof roleName>
export type Hop = z.infer<typeof hop>
export type RolePolicy = z.infer<typeof rolePolicy>
export type EpicRunConfig = z.infer<typeof epicRunConfig>
