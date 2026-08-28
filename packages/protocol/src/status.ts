// DO-NOT-EDIT: forge-client vendors this file with a schema-drift check.
import { z } from 'zod'
export const HealthResponse = z.object({
  ok: z.boolean(),
  version: z.string(),
  db: z.enum(['ok', 'error']),
})
export const harnessCooldownSchema = z.object({
  kind: z.string(),
  detectedAt: z.number().int(),
  resetsAt: z.number().int().nullable(),
  resetsAtEstimated: z.boolean(),
  detail: z.string().nullable(),
})
export const accountUsageWindow = z.object({
  windowId: z.string(),
  label: z.string(),
  utilization: z.number().min(0).max(1),
  resetsAt: z.number().int().nullable(),
  source: z.string(),
  observedAt: z.number().int(),
})
export const harnessAccountHealthSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.string(),
  homePath: z.string(),
  order: z.number().int(),
  disabled: z.boolean(),
  authenticated: z.boolean(),
  identity: z
    .object({
      status: z.enum(['authenticated', 'unauthenticated', 'unknown']),
      email: z.string().optional(),
      displayName: z.string().optional(),
      plan: z.string().optional(),
      accountUuid: z.string().optional(),
      userId: z.string().optional(),
      providers: z.array(z.string()).optional(),
      label: z.string().optional(),
      type: z.string().optional(),
      expiresAt: z.number().optional(),
    })
    .nullable()
    .optional(),
  cooldown: harnessCooldownSchema.nullable(),
  usage: z.array(accountUsageWindow).optional(),
  tierLabel: z.string().optional(),
  usageStatus: z.enum(['ok', 'auth', 'unavailable', 'unsupported']).optional(),
})
export const harnessStatusSchema = z.object({
  key: z.string(),
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  protocol: z.enum(['acp', 'pty']),
  enabled: z.boolean(),
  accounts: z.array(harnessAccountHealthSchema),
  liveProcesses: z.number().int().nonnegative(),
})
export const harnessHealthResponseSchema = z.array(harnessStatusSchema)
export const StatusResponse = z.object({
  version: z.string(),
  bootId: z.string(),
  uptimeSec: z.number().nonnegative(),
  projects: z.number().int().nonnegative(),
  sessions: z.object({
    idle: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    errored: z.number().int().nonnegative(),
  }),
  epicRuns: z.object({
    running: z.number().int().nonnegative(),
    paused: z.number().int().nonnegative(),
  }),
  harnesses: z.array(
    z.object({
      key: z.string(),
      protocol: z.enum(['acp', 'pty']),
      liveProcesses: z.number().int().nonnegative(),
    }),
  ),
  dataDirBytes: z.number().int().nonnegative(),
})
export const StatusEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), status: StatusResponse }),
  z.object({
    type: z.literal('session'),
    sessionId: z.string(),
    status: z.string(),
  }),
  z.object({
    type: z.literal('epicRun'),
    runId: z.string(),
    status: z.string(),
  }),
  z.object({ type: z.literal('heartbeat'), ts: z.string() }),
])
export type HealthResponse = z.infer<typeof HealthResponse>
export type StatusHarness = z.infer<typeof StatusResponse>['harnesses'][number]
export type HarnessStatus = z.infer<typeof harnessStatusSchema>
export type HarnessHealthResponse = z.infer<typeof harnessHealthResponseSchema>
export type StatusResponse = z.infer<typeof StatusResponse>
export type StatusEvent = z.infer<typeof StatusEvent>
