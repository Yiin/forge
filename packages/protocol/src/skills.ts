import { z } from 'zod'

export const skillSchema = z.object({
  name: z.string(),
  description: z.string(),
})

export const skillsResponseSchema = z.object({ skills: z.array(skillSchema) })
export type Skill = z.infer<typeof skillSchema>
export type SkillsResponse = z.infer<typeof skillsResponseSchema>
