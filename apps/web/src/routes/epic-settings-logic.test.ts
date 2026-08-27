import { describe, expect, it } from 'vitest'
import {
  addTierHop,
  assignRoleTier,
  createTier,
  deleteTier,
  moveTierHop,
  renameTier,
  setTierHopSkipAboveUtilization,
  validateEpicDefaults,
  type EpicDefaults,
} from './epic-settings-logic'

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

describe('role policy operations', () => {
  const policy = {
    roles: {
      'iteration-worker': 'fast',
      'triage-control': 'fast',
      'title-generation': 'slow',
    },
    tiers: {
      fast: [{ harness: 'a' }, { harness: 'b' }],
      slow: [{ harness: 'c' }],
    },
  }
  it('copies policies and repoints all roles when renaming', () => {
    const next = renameTier(policy, 'fast', 'faster')
    expect('policy' in next && next.policy.roles).toEqual({
      'iteration-worker': 'faster',
      'triage-control': 'faster',
      'title-generation': 'slow',
    })
    expect(policy.tiers.fast).toHaveLength(2)
  })
  it('unassigns roles when deleting a tier', () => {
    expect(deleteTier(policy, 'fast').roles).toEqual({
      'title-generation': 'slow',
    })
  })
  it('keeps hop order at both ends and rejects invalid thresholds', () => {
    expect(moveTierHop(policy, 'fast', 0, 'up').tiers.fast).toEqual(
      policy.tiers.fast,
    )
    expect(moveTierHop(policy, 'fast', 1, 'down').tiers.fast).toEqual(
      policy.tiers.fast,
    )
    expect(
      setTierHopSkipAboveUtilization(policy, 'fast', 0, 101).tiers.fast[0],
    ).toEqual(policy.tiers.fast[0])
    expect(
      setTierHopSkipAboveUtilization(policy, 'fast', 0, 50).tiers.fast[0]
        ?.skipAboveUtilization,
    ).toBe(50)
  })
  it('creates and assigns a tier without mutating the input', () => {
    const created = createTier(policy, 'backup')
    expect('policy' in created && created.policy.tiers.backup).toEqual([])
    const assigned = assignRoleTier(policy, 'iteration-worker', 'slow')
    expect(assigned.roles['iteration-worker']).toBe('slow')
    expect(policy.roles['iteration-worker']).toBe('fast')
    expect(
      addTierHop(policy, 'slow', { harness: 'd' }).tiers.slow,
    ).toHaveLength(2)
  })
})
