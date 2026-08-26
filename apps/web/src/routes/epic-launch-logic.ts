import { epicRunConfig, type EpicRunConfig } from '@forge/protocol/rolePolicy'

export type LaunchErrors = Record<string, string>

export function parseEpicOverrides(
  text: string,
  knownHarnesses: string[],
): { value?: EpicRunConfig; errors: LaunchErrors } {
  if (!text.trim()) return { value: {}, errors: {} }
  let input: unknown
  try {
    input = JSON.parse(text)
  } catch {
    return {
      errors: {
        '$.forge/epic-run.json': 'Enter valid JSON.',
      },
    }
  }
  const checked = epicRunConfig.safeParse(input)
  if (!checked.success) {
    const errors: LaunchErrors = {}
    for (const issue of checked.error.issues) {
      const field = issue.path.length ? issue.path.join('.') : 'root'
      errors[`$.forge/epic-run.json.${field}`] = issue.message
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
          `$.forge/epic-run.json.rolePolicy.tiers.${tier}.${index}.harness`
        ] = `Unknown harness “${hop.harness}”. Choose a configured harness.`
    })
  }
  return Object.keys(errors).length
    ? { errors }
    : { value: checked.data, errors }
}
