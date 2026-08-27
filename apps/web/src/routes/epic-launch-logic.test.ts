import { describe, expect, it } from 'vitest'
import { buildEpicLaunchConfig } from './epic-launch-logic'

describe('epic launch overrides', () => {
  it('returns an empty config for an empty advanced section', () => {
    expect(buildEpicLaunchConfig({}, ['mock'])).toEqual({
      value: {},
      errors: {},
    })
  })

  it('reports the file and field for invalid values', () => {
    const result = buildEpicLaunchConfig({ workerCount: 0 }, ['mock'])
    expect(result.errors.workerCount).toContain('positive')
  })

  it('rejects harnesses that are not configured', () => {
    const result = buildEpicLaunchConfig(
      {
        rolePolicy: { roles: {}, tiers: { fast: [{ harness: 'missing' }] } },
        rolePolicyChanged: true,
      },
      ['mock'],
    )
    expect(result.errors['rolePolicy.tiers.fast.0.harness']).toContain(
      'Unknown harness',
    )
  })

  it('accepts known harness overrides', () => {
    expect(buildEpicLaunchConfig({ workerCount: 2 }, ['mock'])).toEqual({
      value: { workerCount: 2 },
      errors: {},
    })
  })

  it('omits an unchanged role policy', () => {
    const rolePolicy = {
      roles: { 'iteration-worker': 'default' },
      tiers: { default: [{ harness: 'mock' }] },
    }
    expect(
      buildEpicLaunchConfig({ rolePolicy, rolePolicyChanged: false }, ['mock']),
    ).toEqual({ value: {}, errors: {} })
  })
})
