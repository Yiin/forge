import { describe, expect, it } from 'vitest'
import {
  buildModelOptions,
  filterModels,
  modelChipName,
  modelResponse,
  resolveModelTriggerLabel,
} from './model-picker-logic'

describe('model picker logic', () => {
  it('maps model ids and names for display', () => {
    expect(
      buildModelOptions([{ id: 'fast', displayName: 'Fast model' }]),
    ).toEqual([{ id: 'fast', label: 'Fast model' }])
  })

  it('keeps catalog descriptions, traits, and default favorites', () => {
    expect(
      modelResponse({
        models: [
          {
            id: 'smart',
            displayName: 'Smart',
            description: 'Deep reasoning',
            isDefault: true,
            options: { traits: ['vision', 'tools'] },
          },
        ],
      }),
    ).toEqual([
      {
        id: 'smart',
        label: 'Smart',
        description: 'Deep reasoning',
        favorite: true,
        traits: ['vision', 'tools'],
      },
    ])
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

describe('model search and chip name', () => {
  const models = [
    { id: 'haiku', label: 'Haiku', description: 'Fast and light' },
    { id: 'opus', label: 'Opus', favorite: true },
    { id: 'sonnet-fast', label: 'Sonnet fast' },
    { id: 'fastlane', label: 'Fastlane' },
  ]
  it('ranks label prefix, then label substring, then description', () => {
    expect(filterModels(models, 'fast').map((model) => model.id)).toEqual([
      'fastlane',
      'sonnet-fast',
      'haiku',
    ])
    expect(filterModels(models, '  ')).toBe(models)
  })
  it('names the chip from the pick, then the default model, then the harness', () => {
    expect(modelChipName('haiku', models, 'Claude')).toEqual({
      label: 'Haiku',
      set: true,
    })
    expect(modelChipName(undefined, models, 'Claude')).toEqual({
      label: 'Opus',
      set: false,
    })
    expect(modelChipName(undefined, [], 'Claude')).toEqual({
      label: 'Claude',
      set: false,
    })
  })
})
