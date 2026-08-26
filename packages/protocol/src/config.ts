import { z } from 'zod'
import { rolePolicy, type RolePolicy } from './rolePolicy.js'

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

export const settingsSchema = z.object({
  defaultProject: z.string().default(''),
  titleGeneration: z.boolean().default(true),
  keybindings: z.record(z.string().min(1), z.string().min(1)).default({}),
  epicDefaults: z
    .object({
      workerCount: z.number().int().positive().max(32).default(3),
      mode: z.enum(['pool', 'serial', 'auto']).default('pool'),
      gateCommand: z.union([z.string(), z.array(z.string())]).optional(),
      installCommand: z.union([z.string(), z.array(z.string())]).optional(),
      rolePolicy: rolePolicy.optional(),
    })
    .default({ workerCount: 3, mode: 'pool' }),
})

/** A strict, server-backed settings update. Theme is deliberately client-only. */
export const settingsPatchSchema = settingsSchema.partial().strict()

export const forgeConfigSchema = z.object({
  dataDir: z.string().min(1).default('.forge/data'),
  port: z.number().int().positive().max(65535).default(3900),
  harness: z.record(z.string().min(1), harnessConfigSchema),
  settings: settingsSchema.default({
    defaultProject: '',
    titleGeneration: true,
    keybindings: {},
    epicDefaults: { workerCount: 3, mode: 'pool' },
  }),
})

export type HarnessConfig = z.infer<typeof harnessConfigSchema>
export type ForgeSettings = z.infer<typeof settingsSchema>
export type ForgeSettingsPatch = z.infer<typeof settingsPatchSchema>
export type ForgeConfig = z.infer<typeof forgeConfigSchema>
export type { RolePolicy }
