import { describe, expect, it } from 'vitest'
import { convertConfig, defaultConfig } from '../config.js'
import {
  createProductionNativeAdapter,
  harnessTransport,
  hasProductionNativeAdapter,
} from './native-factory.js'

describe('production native harness routing', () => {
  it('selects Claude only when its native adapter is implemented', () => {
    for (const key of ['claude', 'claude-code']) {
      expect(hasProductionNativeAdapter(key)).toBe(true)
      expect(
        createProductionNativeAdapter(key, { command: 'claude', args: [] })
          ?.kind,
      ).toBe('native')
    }
  })

  it('keeps planned native providers on their configured ACP transport', () => {
    const config = convertConfig(defaultConfig(false))
    for (const [key, entry] of Object.entries(config.harness))
      expect(harnessTransport(key, entry)).not.toBe('unconfigured')
    for (const key of ['codex-acp', 'kimi', 'opencode', 'pi'])
      expect(
        harnessTransport(key, {
          adapterKind: 'native',
          protocol: 'acp',
        } as never),
      ).toBe('acp')
  })
})
