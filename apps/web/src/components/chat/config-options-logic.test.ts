import { describe, expect, it } from 'vitest'
import {
  currentLabel,
  flattenSelectOptions,
  parseConfigOptionsResponse,
  pendingChanges,
  pickableOptions,
  triggerLabel,
  type ConfigOption,
} from './config-options-logic'

const thought: ConfigOption = {
  id: 'thought_level',
  name: 'Reasoning',
  type: 'select',
  currentValue: 'high',
  category: 'thought_level',
  options: [
    { value: 'high', name: 'High' },
    { value: 'low', name: 'Low' },
  ],
}
const windowSize: ConfigOption = {
  id: 'context_window',
  name: 'Context',
  type: 'select',
  currentValue: '1m',
  options: [
    { group: 'Size', name: 'Size', options: [{ value: '1m', name: '1M' }] },
  ],
}

describe('config option logic', () => {
  it('joins visible labels and hides model and mode options', () => {
    const model: ConfigOption = { ...thought, id: 'model', category: 'model' }
    expect(pickableOptions([model, thought, windowSize])).toEqual([
      thought,
      windowSize,
    ])
    expect(triggerLabel([model, thought, windowSize])).toBe('High · 1M')
  })

  it('flattens grouped options and finds pending labels', () => {
    expect(flattenSelectOptions(windowSize)).toEqual([
      { value: '1m', name: '1M', group: 'Size' },
    ])
    expect(currentLabel(thought, { thought_level: 'low' })).toBe('Low')
    expect(pendingChanges([thought], { thought_level: 'low' })).toEqual({
      thought_level: 'low',
    })
    expect(pendingChanges([thought], { thought_level: 'high' })).toEqual({})
  })

  it('uses On and Off for boolean options', () => {
    const option: ConfigOption = {
      id: 'enabled',
      name: 'Enabled',
      type: 'boolean',
      currentValue: false,
    }
    expect(currentLabel(option)).toBe('Off')
    expect(currentLabel(option, { enabled: true })).toBe('On')
  })

  it('rejects malformed response entries', () => {
    expect(
      parseConfigOptionsResponse({
        configOptions: [thought, null, { id: 'bad', type: 'select' }],
      }),
    ).toEqual([thought])
    expect(parseConfigOptionsResponse({ configOptions: 'bad' })).toEqual([])
  })
})
