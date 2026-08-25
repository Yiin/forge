import { z } from 'zod'
export const SubscribeFrame = z.object({
  type: z.literal('subscribe'),
  sessions: z.union([z.array(z.string()), z.literal('all')]),
  cursor: z.number().int().nonnegative(),
})
export type SubscribeFrame = z.infer<typeof SubscribeFrame>
