export const ADD_HARNESS_STEPS = ['Kind', 'Identity', 'Config'] as const
export const HARNESS_KINDS = ['claude', 'codex', 'kimi', 'opencode'] as const
export type HarnessKind = (typeof HARNESS_KINDS)[number]

export type WizardNavigation =
  | { kind: 'navigate'; step: number }
  | { kind: 'blocked'; step: number; error: string }

export function validateAccountId(
  id: string,
  existingIds: Iterable<string> = [],
) {
  const value = id.trim()
  if (!value) return 'Harness ID is required.'
  if (value.length > 64) return 'Harness ID must be 64 characters or fewer.'
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(value))
    return "Harness ID must start with a letter and use only letters, digits, '-', or '_'."
  if (new Set(existingIds).has(value))
    return `A harness named '${value}' already exists.`
  return null
}

export function deriveHarnessId(kind: HarnessKind, label: string) {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return `${kind}_${slug || 'work'}`
}

export function resolveWizardNavigation(
  currentStep: number,
  requestedStep: number,
  stepCount: number,
  validation: { idError: string | null },
): WizardNavigation {
  const last = Math.max(0, stepCount - 1)
  const target = Math.max(0, Math.min(last, requestedStep))
  if (currentStep <= 1 && target > 1 && validation.idError)
    return {
      kind: 'blocked',
      step: Math.min(1, last),
      error: validation.idError,
    }
  return { kind: 'navigate', step: target }
}
