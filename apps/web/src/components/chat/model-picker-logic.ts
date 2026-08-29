export type ModelOption = { id: string; label: string }

export function resolveModelTriggerLabel(
  selectedId: string | undefined,
  options: ModelOption[],
): { value: string; label: string } | null {
  if (!selectedId) return null
  const option = options.find((item) => item.id === selectedId)
  return { value: selectedId, label: option?.label ?? selectedId }
}

export function buildModelOptions(
  models: ReadonlyArray<{ id: string; displayName: string }>,
): ModelOption[] {
  return models
    .filter((model) => model.id.length > 0)
    .map((model) => ({ id: model.id, label: model.displayName || model.id }))
}

export function modelResponse(value: unknown): ModelOption[] {
  if (!value || typeof value !== 'object' || !('models' in value)) return []
  const models = value.models
  if (!Array.isArray(models)) return []
  return buildModelOptions(
    models.filter(
      (model): model is { id: string; displayName: string } =>
        !!model &&
        typeof model === 'object' &&
        typeof model.id === 'string' &&
        typeof model.displayName === 'string',
    ),
  )
}
