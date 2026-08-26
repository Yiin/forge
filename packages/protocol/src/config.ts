import { z } from 'zod'

export const harnessConfigSchema = z
  .object({
    name: z.string().trim().min(1),
    command: z.string().trim().min(1),
    args: z.array(z.string()),
    env: z.record(z.string(), z.string()),
    protocol: z.enum(['acp', 'pty']),
    quietPeriodMs: z.number().int().positive().optional(),
    maxTurnMs: z.number().int().positive().optional(),
    enabled: z.boolean().default(true),
  })
  .strict()

export const forgeConfigSchema = z.object({
  dataDir: z.string().min(1).default('.forge/data'),
  port: z.number().int().positive().max(65535).default(3900),
  harness: z.record(z.string().min(1), harnessConfigSchema),
  settings: z
    .object({
      theme: z.enum(['dark', 'light']).default('dark'),
      defaultProject: z.string().default(''),
      titleGeneration: z.boolean().default(true),
    })
    .default({ theme: 'dark', defaultProject: '', titleGeneration: true }),
})

export type HarnessConfig = z.infer<typeof harnessConfigSchema>
export type ForgeConfig = z.infer<typeof forgeConfigSchema>
