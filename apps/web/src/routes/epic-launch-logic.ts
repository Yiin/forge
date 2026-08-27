import {
  epicRunConfig,
  type EpicRunConfig,
  type RolePolicy,
} from '@forge/protocol/rolePolicy'

export type LaunchErrors = Record<string, string>

export type EpicLaunchForm = {
  advancedOpen?: boolean
  gateCommand?: string
  installCommand?: string
  rolePolicy?: RolePolicy
  rolePolicyChanged?: boolean
  workerCount?: number | string
}

export function buildEpicLaunchConfig(
  form: EpicLaunchForm,
  knownHarnesses: string[],
): { value?: EpicRunConfig; errors: LaunchErrors } {
  const input: Record<string, unknown> = {}
  if (form.workerCount !== undefined)
    input.workerCount =
      typeof form.workerCount === 'number'
        ? form.workerCount
        : Number(form.workerCount)
  if (form.advancedOpen !== false && form.gateCommand?.trim())
    input.gateCommand = form.gateCommand.trim()
  if (form.advancedOpen !== false && form.installCommand?.trim())
    input.installCommand = form.installCommand.trim()
  if (form.advancedOpen !== false && form.rolePolicyChanged && form.rolePolicy)
    input.rolePolicy = form.rolePolicy
  const checked = epicRunConfig.safeParse(input)
  if (!checked.success) {
    const errors: LaunchErrors = {}
    for (const issue of checked.error.issues) {
      const field = issue.path.length ? issue.path.join('.') : 'root'
      errors[field] = issue.message
    }
    return { errors }
  }
  const errors: LaunchErrors = {}
  for (const [tier, hops] of Object.entries(
    checked.data.rolePolicy?.tiers ?? {},
  )) {
    hops.forEach((hop, index) => {
      if (!knownHarnesses.includes(hop.harness))
        errors[
          `rolePolicy.tiers.${tier}.${index}.harness`
        ] = `Unknown harness “${hop.harness}”. Choose a configured harness.`
    })
  }
  return Object.keys(errors).length
    ? { errors }
    : { value: checked.data, errors }
}
