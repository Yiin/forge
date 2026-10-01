import {
  epicRunConfig,
  type EpicRunConfig,
  type RolePolicy,
} from '@forge/protocol/rolePolicy'
import { hopErrors, type HopAccount } from './epic-settings-logic'

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
  accounts: readonly HopAccount[] = [],
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
  const errors: LaunchErrors = checked.data.rolePolicy
    ? hopErrors(checked.data.rolePolicy, knownHarnesses, accounts)
    : {}
  return Object.keys(errors).length
    ? { errors }
    : { value: checked.data, errors }
}
