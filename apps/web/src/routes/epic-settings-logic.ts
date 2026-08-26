import { epicRunConfig, type EpicRunConfig } from '@forge/protocol/rolePolicy'

export type EpicDefaults = EpicRunConfig & {
  workerCount: number
  mode: 'pool' | 'serial' | 'auto'
  rolePolicy: NonNullable<EpicRunConfig['rolePolicy']>
}

export function validateEpicDefaults(
  value: EpicDefaults,
  harnessNames: Iterable<string>,
): Record<string, string> {
  const errors: Record<string, string> = {}
  const parsed = epicRunConfig.safeParse(value)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors[issue.path.join('.') || 'epicDefaults'] = issue.message
    }
    return errors
  }

  const harnesses = new Set(harnessNames)
  const policy = value.rolePolicy
  for (const [role, tier] of Object.entries(policy.roles)) {
    if (!(tier in policy.tiers)) {
      errors[`rolePolicy.roles.${role}`] = `Tier “${tier}” does not exist.`
    }
  }
  for (const [tier, hops] of Object.entries(policy.tiers)) {
    if (hops.length === 0) {
      errors[`rolePolicy.tiers.${tier}`] = 'Add at least one fallback hop.'
    }
    hops.forEach((hop, index) => {
      if (!harnesses.has(hop.harness)) {
        errors[`rolePolicy.tiers.${tier}.${index}.harness`] =
          `Harness “${hop.harness}” does not exist.`
      }
    })
  }
  return errors
}
