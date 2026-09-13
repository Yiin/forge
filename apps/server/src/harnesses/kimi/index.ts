import { captureAuthority, effectiveAuthority } from './authority.js'
import { hostOwner } from './host.js'
import { KimiError } from './limits.js'
import { KimiRuntime } from './runtime.js'
import type { KimiAdapter, KimiAdapterOptions } from './types.js'

export { createKimiHost } from './host.js'
export { discoverKimi, readKimiHistory } from './discovery.js'
export { KimiError, kimiLimitCeilings } from './limits.js'
export type { KimiLimits } from './limits.js'
export type * from './types.js'

/** Unselected provider. .12/.13 must supply authorized transactional stores before production selection. */
export function createKimiAdapter(options: KimiAdapterOptions): KimiAdapter {
  const host = hostOwner(options.host)
  const authority = captureAuthority(options.authority, host.budget.limits)
  if (
    typeof options.readState !== 'function' ||
    typeof options.commitRecords !== 'function' ||
    typeof options.storeAttachment !== 'function'
  )
    throw new KimiError('kimi_storage_required')
  const captured = { ...options, authority }
  return {
    kind: 'native',
    capabilities: {
      loadSession: true,
      steer: true,
      queue: true,
      cancel: true,
      permissions: true,
      questions: true,
      models: true,
    },
    spawn: async (session, emit) =>
      KimiRuntime.create(
        structuredClone(session),
        await effectiveAuthority(authority),
        host,
        captured,
        emit,
        false,
      ),
    load: async (session, emit) =>
      KimiRuntime.create(
        structuredClone(session),
        await effectiveAuthority(authority),
        host,
        captured,
        emit,
        true,
      ),
  }
}
