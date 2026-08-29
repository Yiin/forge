import { describe, expect, it } from 'vitest'
import { buildModelOptions, modelResponse } from './model-picker-logic'

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
})
