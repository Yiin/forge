export type ModelOption = {
  id: string
  label: string
  description?: string
  favorite?: boolean
  traits?: string[]
}

export function resolveModelTriggerLabel(
  selectedId: string | undefined,
  options: ModelOption[],
): { value: string; label: string } | null {
  if (!selectedId) return null
  const option = options.find((item) => item.id === selectedId)
  return { value: selectedId, label: option?.label ?? selectedId }
}

export function buildModelOptions(
  models: ReadonlyArray<{
    id: string
    displayName: string
    description?: string
    isDefault?: boolean
    options?: Record<string, unknown>
  }>,
): ModelOption[] {
  const seen = new Set<string>()
  return [...models]
    .filter((model) => model.id.length > 0 && !seen.has(model.id))
    .filter((model) => {
      seen.add(model.id)
      return true
    })
    .sort((a, b) => Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)))
    .map((model) => {
      const options = model.options
      const traits = Array.isArray(options?.traits)
        ? options.traits.filter(
            (trait): trait is string => typeof trait === 'string',
          )
        : undefined
      return {
        id: model.id,
        label: model.displayName || model.id,
        ...(model.description ? { description: model.description } : {}),
        ...(model.isDefault ? { favorite: true } : {}),
        ...(traits?.length ? { traits } : {}),
      }
    })
}

export function modelResponse(value: unknown): ModelOption[] {
  if (!value || typeof value !== 'object' || !('models' in value)) return []
  const models = value.models
  if (!Array.isArray(models)) return []
  return buildModelOptions(
    models.filter(
      (
        model,
      ): model is {
        id: string
        displayName: string
        description?: string
        isDefault?: boolean
        options?: Record<string, unknown>
      } =>
        !!model &&
        typeof model === 'object' &&
        typeof model.id === 'string' &&
        typeof model.displayName === 'string' &&
        (model.description === undefined ||
          typeof model.description === 'string') &&
        (model.isDefault === undefined ||
          typeof model.isDefault === 'boolean') &&
        (model.options === undefined ||
          (!!model.options &&
            typeof model.options === 'object' &&
            !Array.isArray(model.options))),
    ),
  )
}
