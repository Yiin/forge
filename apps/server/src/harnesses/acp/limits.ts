import type { JsonlOptions } from '../jsonl.js'

export const acpLimits = Object.freeze({
  processes: [8, 32],
  discovery: [4, 8],
  commits: [8, 32],
  writes: [8, 64],
  handlers: [32, 128],
  attachments: [8, 32],
  filesystem: [8, 32],
  filesystemBytes: [8 * 1024 * 1024, 32 * 1024 * 1024],
  descriptors: [256, 1024],
  terminals: [8, 16],
  artifacts: [8, 32],
  catalogs: [8, 32],
  calls: [64, 256],
  requests: [128, 512],
  turns: [32, 128],
  retained: [128 * 1024 * 1024, 256 * 1024 * 1024],
} as const)
type Resource = keyof typeof acpLimits
export type AcpLimits = Readonly<Record<Resource, readonly [number, number]>>
type Counts = Record<Resource, number>
const counts = (): Counts =>
  Object.fromEntries(Object.keys(acpLimits).map((key) => [key, 0])) as Counts

/** One server owns this host across accounts, sessions, and replacement runtimes. */
export class AcpResourceHost {
  private readonly limits: AcpLimits
  private readonly total = counts()
  private readonly instances = new Map<string, Counts>()
  constructor(overrides: Partial<AcpLimits> = {}) {
    const limits = { ...acpLimits, ...overrides }
    for (const key of Object.keys(acpLimits) as Resource[]) {
      const values = limits[key]
      for (let index = 0; index < 2; index++)
        if (
          !Number.isSafeInteger(values[index]) ||
          values[index]! <= 0 ||
          values[index]! > acpLimits[key][index]!
        )
          throw Error('Invalid ACP resource limit')
    }
    this.limits = Object.freeze(
      Object.fromEntries(
        Object.entries(limits).map(([key, value]) => [
          key,
          Object.freeze([...value]),
        ]),
      ),
    ) as AcpLimits
  }
  reserve(instanceId: string, resource: Resource, amount = 1): () => void {
    if (!instanceId || !Number.isSafeInteger(amount) || amount < 0)
      throw Error('Invalid ACP resource charge')
    const instance = this.instances.get(instanceId) ?? counts()
    const [local, global] = this.limits[resource]
    if (
      instance[resource] + amount > local ||
      this.total[resource] + amount > global
    )
      throw Error('ACP resource limit')
    this.instances.set(instanceId, instance)
    instance[resource] += amount
    this.total[resource] += amount
    let held = true
    return () => {
      if (!held) return
      held = false
      instance[resource] -= amount
      this.total[resource] -= amount
      if (Object.values(instance).every((value) => value === 0))
        this.instances.delete(instanceId)
    }
  }
  transport(instanceId: string): NonNullable<JsonlOptions['resources']> {
    return {
      measureOutgoing: (value) => Buffer.byteLength(JSON.stringify(value)),
      reserve: (kind, bytes) => {
        const releaseBytes = this.reserve(instanceId, 'retained', bytes)
        let releaseWrite: (() => void) | undefined
        try {
          if (kind === 'write')
            releaseWrite = this.reserve(instanceId, 'writes')
        } catch (error) {
          releaseBytes()
          throw error
        }
        return () => {
          releaseWrite?.()
          releaseBytes()
        }
      },
    }
  }
}
