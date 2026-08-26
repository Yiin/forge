import { describe, expect, it } from 'vitest'
import { parseEpicOverrides } from './epic-launch-logic'

describe('epic launch overrides', () => {
  it('reports the file and field for invalid values', () => {
    const result = parseEpicOverrides('{"workerCount":0}', ['mock'])
    expect(result.errors['$.forge/epic-run.json.workerCount']).toContain(
      'positive',
    )
  })

  it('rejects harnesses that are not configured', () => {
    const result = parseEpicOverrides(
      JSON.stringify({
        rolePolicy: { roles: {}, tiers: { fast: [{ harness: 'missing' }] } },
      }),
      ['mock'],
    )
    expect(
      result.errors['$.forge/epic-run.json.rolePolicy.tiers.fast.0.harness'],
    ).toContain('Unknown harness')
  })

  it('accepts known harness overrides', () => {
    expect(parseEpicOverrides('{"workerCount":2}', ['mock'])).toEqual({
      value: { workerCount: 2 },
      errors: {},
    })
  })
})
