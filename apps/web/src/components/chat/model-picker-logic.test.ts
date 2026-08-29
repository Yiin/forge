import { describe, expect, it } from 'vitest'
import {
  buildModelOptions,
  modelResponse,
  resolveModelTriggerLabel,
} from './model-picker-logic'

describe('model picker logic', () => {
  it('maps model ids and names for display', () => {
    expect(
      buildModelOptions([{ id: 'fast', displayName: 'Fast model' }]),
    ).toEqual([{ id: 'fast', label: 'Fast model' }])
  })

  it('rejects malformed model responses', () => {
    expect(modelResponse({ models: [{ id: 'fast' }, null] })).toEqual([])
    expect(
      modelResponse({ models: [{ id: 'fast', displayName: '' }] }),
    ).toEqual([{ id: 'fast', label: 'fast' }])
  })

  it('resolves a selected model to its display label', () => {
    expect(
      resolveModelTriggerLabel('fast', [{ id: 'fast', label: 'Fast model' }]),
    ).toEqual({ value: 'fast', label: 'Fast model' })
  })

  it('falls back to the selected model id when it is not in the catalog', () => {
    expect(resolveModelTriggerLabel('unknown', [])).toEqual({
      value: 'unknown',
      label: 'unknown',
    })
  })

  it('returns null when no model is selected', () => {
    expect(resolveModelTriggerLabel(undefined, [])).toBeNull()
  })
})
