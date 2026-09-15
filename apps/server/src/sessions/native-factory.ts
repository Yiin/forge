import {
  createClaudeAdapter,
  type ClaudeAdapterOptions,
} from '../harnesses/claude/index.js'
import type { HarnessConfig } from '@forge/protocol/config'
import type { HarnessAdapter } from '../harnesses/types.js'

const productionNativeAdapters: Record<
  string,
  (options: ClaudeAdapterOptions) => HarnessAdapter
> = {
  claude: createClaudeAdapter,
  'claude-code': createClaudeAdapter,
}

export function hasProductionNativeAdapter(key: string): boolean {
  return Object.hasOwn(productionNativeAdapters, key)
}

export function createProductionNativeAdapter(
  key: string,
  options: ClaudeAdapterOptions,
): HarnessAdapter | undefined {
  return productionNativeAdapters[key]?.(options)
}

export type HarnessTransport = 'native' | 'pty' | 'acp' | 'unconfigured'

export function harnessTransport(
  key: string,
  entry: HarnessConfig | undefined,
): HarnessTransport {
  if (!entry) return 'unconfigured'
  if (entry.adapterKind === 'native' && hasProductionNativeAdapter(key))
    return 'native'
  if (entry.protocol === 'pty') return 'pty'
  if (entry.protocol === 'acp') return 'acp'
  return 'unconfigured'
}
