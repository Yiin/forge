import {
  epicRunConfig,
  type EpicRunConfig,
  type Hop,
  type RolePolicy,
} from '@forge/protocol/rolePolicy'

export const defaultRolePolicy: RolePolicy = {
  roles: {
    'iteration-worker': 'default',
    'triage-control': 'default',
    'title-generation': 'default',
  },
  tiers: { default: [{ harness: 'claude-code-acp' }] },
}

/** The account fields hop validation needs. */
export type HopAccount = { id: string; harnessKey: string }

export type EpicDefaults = EpicRunConfig & {
  workerCount: number
  mode: 'pool' | 'serial' | 'auto'
  rolePolicy: NonNullable<EpicRunConfig['rolePolicy']>
}

export const EPIC_ROLE_DETAILS = {
  'iteration-worker': {
    label: 'Iteration worker',
    description: 'Builds one ready child during each epic iteration.',
  },
  'triage-control': {
    label: 'Triage control',
    description: 'Reviews failures and chooses the next recovery action.',
  },
  'title-generation': {
    label: 'Title generation',
    description:
      'Renames epic worker sessions after each turn. Uses the first Claude Code or Codex hop in its tier.',
  },
} as const

export type EpicRoleId = keyof typeof EPIC_ROLE_DETAILS
export type RoleRow = {
  roleId: EpicRoleId
  label: string
  description: string
  tierId: string | null
  hopCount: number
  missingHarnesses: number
}

const copyPolicy = (policy: RolePolicy): RolePolicy => ({
  tiers: Object.fromEntries(
    Object.entries(policy.tiers).map(([id, hops]) => [
      id,
      hops.map((hop) => ({ ...hop })),
    ]),
  ),
  roles: { ...policy.roles },
})
const updateTier = (
  policy: RolePolicy,
  tierId: string,
  update: (hops: Hop[]) => Hop[],
): RolePolicy => {
  const next = copyPolicy(policy)
  if (next.tiers[tierId])
    next.tiers[tierId] = update(next.tiers[tierId]!.map((hop) => ({ ...hop })))
  return next
}

export function createTier(
  policy: RolePolicy,
  input: string,
): { policy: RolePolicy } | { error: string } {
  const id = input.trim()
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id))
    return {
      error:
        'Use 1 to 64 letters, numbers, underscores, or hyphens. Start with a letter.',
    }
  if (policy.tiers[id]) return { error: 'A tier with this ID already exists.' }
  return {
    policy: {
      ...copyPolicy(policy),
      tiers: { ...copyPolicy(policy).tiers, [id]: [] },
    },
  }
}

export function renameTier(
  policy: RolePolicy,
  oldId: string,
  input: string,
): { policy: RolePolicy } | { error: string } {
  const id = input.trim()
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id))
    return {
      error:
        'Use 1 to 64 letters, numbers, underscores, or hyphens. Start with a letter.',
    }
  if (!policy.tiers[oldId]) return { error: 'This tier no longer exists.' }
  if (id !== oldId && policy.tiers[id])
    return { error: 'A tier with this ID already exists.' }
  if (id === oldId) return { policy: copyPolicy(policy) }
  const next = copyPolicy(policy)
  delete next.tiers[oldId]
  next.tiers[id] = policy.tiers[oldId]!.map((hop) => ({ ...hop }))
  for (const [role, tier] of Object.entries(next.roles))
    if (tier === oldId) next.roles[role as EpicRoleId] = id
  return { policy: next }
}

export function deleteTier(policy: RolePolicy, tierId: string): RolePolicy {
  const next = copyPolicy(policy)
  delete next.tiers[tierId]
  for (const role of Object.keys(next.roles) as EpicRoleId[])
    if (next.roles[role] === tierId) delete next.roles[role]
  return next
}
export function assignRoleTier(
  policy: RolePolicy,
  roleId: EpicRoleId,
  tierId: string | null,
): RolePolicy {
  const next = copyPolicy(policy)
  if (tierId) next.roles[roleId] = tierId
  else delete next.roles[roleId]
  return next
}
export function addTierHop(
  policy: RolePolicy,
  tierId: string,
  hop: Hop,
): RolePolicy {
  return updateTier(policy, tierId, (hops) => [...hops, { ...hop }])
}
export function removeTierHop(
  policy: RolePolicy,
  tierId: string,
  index: number,
): RolePolicy {
  return updateTier(policy, tierId, (hops) =>
    hops.filter((_, i) => i !== index),
  )
}
export function moveTierHop(
  policy: RolePolicy,
  tierId: string,
  index: number,
  direction: 'up' | 'down',
): RolePolicy {
  return updateTier(policy, tierId, (hops) => {
    const target = index + (direction === 'up' ? -1 : 1)
    if (index < 0 || target < 0 || target >= hops.length) return hops
    const next = [...hops]
    ;[next[index], next[target]] = [next[target]!, next[index]!]
    return next
  })
}
export function setTierHopHarness(
  policy: RolePolicy,
  tierId: string,
  index: number,
  harness: string,
): RolePolicy {
  // Account and model belong to the old harness, so a new harness drops them.
  return updateTier(policy, tierId, (hops) =>
    hops.map((hop, i) => {
      if (i !== index) return hop
      return hop.configOptions
        ? { harness, configOptions: hop.configOptions }
        : { harness }
    }),
  )
}
export function setTierHopAccount(
  policy: RolePolicy,
  tierId: string,
  index: number,
  accountId: string | undefined,
): RolePolicy {
  return updateTier(policy, tierId, (hops) =>
    hops.map((hop, i) => {
      if (i !== index) return hop
      const { accountId: _, ...rest } = hop
      return accountId ? { ...rest, accountId } : rest
    }),
  )
}
export function setTierHopModel(
  policy: RolePolicy,
  tierId: string,
  index: number,
  model: string,
): RolePolicy {
  return updateTier(policy, tierId, (hops) =>
    hops.map((hop, i) =>
      i === index ? { ...hop, model: model.trim() || undefined } : hop,
    ),
  )
}
export function buildEpicRoleRows(
  policy: RolePolicy,
  harnessKeys: Iterable<string>,
): RoleRow[] {
  const available = new Set(harnessKeys)
  return (Object.keys(EPIC_ROLE_DETAILS) as EpicRoleId[]).map((roleId) => {
    const tierId = policy.roles[roleId] ?? null
    const hops = tierId ? (policy.tiers[tierId] ?? []) : []
    return {
      roleId,
      ...EPIC_ROLE_DETAILS[roleId],
      tierId,
      hopCount: hops.length,
      missingHarnesses: hops.filter((hop) => !available.has(hop.harness))
        .length,
    }
  })
}
export function isRolePolicyDirty(policy: RolePolicy): boolean {
  return JSON.stringify(policy) !== JSON.stringify(defaultRolePolicy)
}

/** Checks that every hop names a configured harness and, if pinned, a matching account. */
export function hopErrors(
  policy: RolePolicy,
  harnessKeys: Iterable<string>,
  accounts: readonly HopAccount[] = [],
): Record<string, string> {
  const errors: Record<string, string> = {}
  const harnesses = new Set(harnessKeys)
  for (const [tier, hops] of Object.entries(policy.tiers)) {
    hops.forEach((hop, index) => {
      if (!harnesses.has(hop.harness))
        errors[`rolePolicy.tiers.${tier}.${index}.harness`] =
          `Harness “${hop.harness}” does not exist. Choose one from Providers.`
      else if (
        hop.accountId &&
        !accounts.some(
          (account) =>
            account.id === hop.accountId && account.harnessKey === hop.harness,
        )
      )
        errors[`rolePolicy.tiers.${tier}.${index}.accountId`] =
          `Account “${hop.accountId}” does not exist for this harness.`
    })
  }
  return errors
}

export function validateEpicDefaults(
  value: EpicDefaults,
  harnessNames: Iterable<string>,
  accounts: readonly HopAccount[] = [],
): Record<string, string> {
  const errors: Record<string, string> = {}
  const parsed = epicRunConfig.safeParse(value)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors[issue.path.join('.') || 'epicDefaults'] = issue.message
    }
    return errors
  }

  const policy = value.rolePolicy
  for (const [role, tier] of Object.entries(policy.roles)) {
    if (!(tier in policy.tiers)) {
      errors[`rolePolicy.roles.${role}`] = `Tier “${tier}” does not exist.`
    }
  }
  for (const [tier, hops] of Object.entries(policy.tiers)) {
    if (hops.length === 0) {
      errors[`rolePolicy.tiers.${tier}`] = 'Add at least one fallback hop.'
    }
  }
  return { ...errors, ...hopErrors(policy, harnessNames, accounts) }
}
