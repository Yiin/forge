import { z } from 'zod'

export const BeadDependency = z.object({
  id: z.string().min(1),
  dependsOnId: z.string().min(1),
  type: z.string().min(1),
})
export type BeadDependency = z.infer<typeof BeadDependency>

export const Bead = z.object({
  id: z.string().min(1),
  title: z.string(),
  description: z.string(),
  status: z.string(),
  priority: z.number().int().min(0),
  labels: z.array(z.string()),
  dependencies: z.array(BeadDependency),
})
export type Bead = z.infer<typeof Bead>
