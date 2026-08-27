import { describe, expect, it } from 'vitest'
import { resolveWizardNavigation, validateAccountId } from './add-harness-logic'

describe('add harness wizard logic', () => {
  it('clamps requested steps', () => {
    expect(resolveWizardNavigation(0, 99, 3, { idError: null })).toEqual({
      kind: 'navigate',
      step: 2,
    })
    expect(resolveWizardNavigation(2, -1, 3, { idError: null })).toEqual({
      kind: 'navigate',
      step: 0,
    })
  })
  it('blocks forward jumps with an invalid id', () => {
    expect(
      resolveWizardNavigation(0, 2, 3, { idError: 'Harness ID is required.' }),
    ).toEqual({ kind: 'blocked', step: 1, error: 'Harness ID is required.' })
    expect(resolveWizardNavigation(0, 2, 3, { idError: null })).toEqual({
      kind: 'navigate',
      step: 2,
    })
    expect(resolveWizardNavigation(2, 0, 3, { idError: 'bad' })).toEqual({
      kind: 'navigate',
      step: 0,
    })
  })
  it('validates harness ids', () => {
    expect(validateAccountId('')).toBe('Harness ID is required.')
    expect(validateAccountId('1bad')).toContain('must start')
    expect(validateAccountId('work', ['work'])).toContain('already exists')
  })
})
