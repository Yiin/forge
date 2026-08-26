import { describe, expect, it } from 'vitest'
import { validateEpicDefaults, type EpicDefaults } from './epic-settings-logic'

const defaults: EpicDefaults = {
  workerCount: 3,
  mode: 'pool',
  gateCommand: 'bun run test',
  installCommand: ['bun', 'install'],
  rolePolicy: {
    roles: { 'iteration-worker': 'default' },
    tiers: { default: [{ harness: 'mock' }] },
  },
}

describe('epic defaults validation', () => {
  it('accepts every supported mode and existing references', () => {
    for (const mode of ['pool', 'serial', 'auto'] as const) {
      expect(validateEpicDefaults({ ...defaults, mode }, ['mock'])).toEqual({})
    }
  })

  it('uses the protocol validator for invalid command and worker values', () => {
    expect(
      validateEpicDefaults(
        { ...defaults, workerCount: 0, gateCommand: 42 as never },
        ['mock'],
      ),
    ).toMatchObject({
      workerCount: expect.any(String),
      gateCommand: expect.any(String),
    })
  })

  it('rejects missing role tiers and harnesses', () => {
    const errors = validateEpicDefaults(
      {
        ...defaults,
        rolePolicy: {
          roles: { 'iteration-worker': 'missing' },
          tiers: { default: [{ harness: 'gone' }] },
        },
      },
      ['mock'],
    )
    expect(errors['rolePolicy.roles.iteration-worker']).toBeDefined()
    expect(errors['rolePolicy.tiers.default.0.harness']).toBeDefined()
  })

  it('rejects an empty tier after its last hop is removed', () => {
    expect(
      validateEpicDefaults(
        {
          ...defaults,
          rolePolicy: { ...defaults.rolePolicy, tiers: { default: [] } },
        },
        ['mock'],
      )['rolePolicy.tiers.default'],
    ).toContain('at least one')
  })
})
