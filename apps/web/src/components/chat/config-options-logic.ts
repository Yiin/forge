export type ConfigSelectEntry = {
  value: string
  name: string
  description?: string
  group?: string
}

export type ConfigOption =
  | {
      id: string
      name: string
      type: 'select'
      currentValue: string
      options: Array<
        | { value: string; name: string; description?: string }
        | {
            group: string
            name: string
            options: Array<{
              value: string
              name: string
              description?: string
            }>
          }
      >
      description?: string
      category?: string
    }
  | {
      id: string
      name: string
      type: 'boolean'
      currentValue: boolean
      description?: string
      category?: string
    }

export type ConfigSelections = Record<string, string | boolean>

export function parseConfigOptionsResponse(value: unknown): ConfigOption[] {
  if (!value || typeof value !== 'object' || !('configOptions' in value))
    return []
  const options = value.configOptions
  if (!Array.isArray(options)) return []
  return options.filter((option): option is ConfigOption => {
    if (!isRecord(option)) return false
    if (
      typeof option.id !== 'string' ||
      !option.id ||
      typeof option.name !== 'string' ||
      !option.name
    )
      return false
    if (option.type === 'boolean')
      return typeof option.currentValue === 'boolean'
    if (
      option.type !== 'select' ||
      typeof option.currentValue !== 'string' ||
      !Array.isArray(option.options)
    )
      return false
    return option.options.every((entry: unknown) => {
      if (!isRecord(entry)) return false
      if ('group' in entry) {
        return (
          typeof entry.group === 'string' &&
          typeof entry.name === 'string' &&
          Array.isArray(entry.options) &&
          entry.options.every(isEntry)
        )
      }
      return isEntry(entry)
    })
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

function isEntry(
  value: unknown,
): value is { value: string; name: string; description?: string } {
  return (
    isRecord(value) &&
    typeof value.value === 'string' &&
    typeof value.name === 'string'
  )
}

export function pickableOptions(options: ReadonlyArray<ConfigOption>) {
  return options.filter(
    (option) => option.category !== 'model' && option.category !== 'mode',
  )
}

export function flattenSelectOptions(
  option: Extract<ConfigOption, { type: 'select' }>,
): ConfigSelectEntry[] {
  return option.options.flatMap((entry) =>
    'group' in entry
      ? entry.options.map((value) => ({
          ...value,
          group: entry.group,
        }))
      : [entry],
  )
}

export function currentLabel(
  option: ConfigOption,
  selections: ConfigSelections = {},
) {
  const selection = selections[option.id] ?? option.currentValue
  if (option.type === 'boolean') return selection === true ? 'On' : 'Off'
  return (
    flattenSelectOptions(option).find((entry) => entry.value === selection)
      ?.name ?? String(selection)
  )
}

export function triggerLabel(
  options: ReadonlyArray<ConfigOption>,
  selections: ConfigSelections = {},
) {
  return pickableOptions(options)
    .map((option) => currentLabel(option, selections))
    .join(' · ')
}

export function pendingChanges(
  options: ReadonlyArray<ConfigOption>,
  selections: ConfigSelections = {},
): ConfigSelections {
  return Object.fromEntries(
    pickableOptions(options)
      .filter(
        (option) =>
          selections[option.id] !== undefined &&
          selections[option.id] !== option.currentValue,
      )
      .map((option) => [option.id, selections[option.id]]),
  )
}
