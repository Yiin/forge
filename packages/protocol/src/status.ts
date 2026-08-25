import { z } from 'zod'

export const healthResponseSchema = z.object({
  ok: z.boolean(),
  version: z.string(),
  db: z.enum(['ok', 'error']),
})
export type HealthResponse = z.infer<typeof healthResponseSchema>

export const statusResponseSchema = z.object({
  version: z.string(),
  bootId: z.string(),
  uptimeSec: z.number().int().nonnegative(),
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
export type StatusResponse = z.infer<typeof statusResponseSchema>

export const statusEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), status: statusResponseSchema }),
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
  z.object({
    type: z.literal('heartbeat'),
    ts: z.number().int().nonnegative(),
  }),
])
export type StatusEvent = z.infer<typeof statusEventSchema>
