import type { HarnessConfig } from '@forge/protocol/config'
import type { HarnessProcess } from '../../sessions/harness.js'
import type { AcpHarnessDeps } from '../../acp/harness.js'
import { acpHarness } from '../../acp/harness.js'

/** Provider-specific ACP metadata. This is private to the ACP adapters. */
export type AcpProviderDescriptor = {
  key: 'grok' | 'gemini' | 'devin' | 'hermes' | 'custom-acp'
  name: string
  command: string
  args: string[]
  install: string
  models: readonly string[]
  modes: readonly string[]
}

export const acpProviderDescriptors = {
  grok: {
    key: 'grok',
    name: 'Grok',
    command: 'grok',
    args: ['agent', 'stdio'],
    install: 'Install xAI Grok and sign in before use.',
    models: ['grok-4.6', 'grok-4.5'],
    modes: [],
  },
  gemini: {
    key: 'gemini',
    name: 'Gemini CLI',
    command: 'gemini',
    args: ['--experimental-acp'],
    install: 'Install Gemini CLI and sign in before use.',
    models: [],
    modes: ['default', 'autoEdit', 'yolo', 'plan'],
  },
  devin: {
    key: 'devin',
    name: 'Devin',
    command: 'devin',
    args: ['acp'],
    install: 'Install the Devin ACP client and sign in before use.',
    models: [],
    modes: [],
  },
  hermes: {
    key: 'hermes',
    name: 'Hermes',
    command: 'hermes',
    args: ['acp'],
    install: 'Install Hermes with its ACP extra and sign in before use.',
    models: [],
    modes: [],
  },
  'custom-acp': {
    key: 'custom-acp',
    name: 'Custom ACP',
    command: '',
    args: [],
    install: 'Configure an ACP executable in Forge settings.',
    models: [],
    modes: [],
  },
} as const satisfies Record<string, AcpProviderDescriptor>

export type DedicatedAcpKey = Exclude<
  keyof typeof acpProviderDescriptors,
  'custom-acp'
>

function create(entry: HarnessConfig, deps: AcpHarnessDeps): HarnessProcess {
  // ACP remains an implementation detail of this isolated adapter boundary.
  return acpHarness({ ...entry, adapterKind: 'acp' }, deps)
}

export function createGrokAdapter(entry: HarnessConfig, deps: AcpHarnessDeps) {
  return create(entry, deps)
}

export function createGeminiAdapter(
  entry: HarnessConfig,
  deps: AcpHarnessDeps,
) {
  return create(entry, deps)
}

export function createDevinAdapter(entry: HarnessConfig, deps: AcpHarnessDeps) {
  return create(entry, deps)
}

export function createHermesAdapter(
  entry: HarnessConfig,
  deps: AcpHarnessDeps,
) {
  return create(entry, deps)
}

export function createCustomAcpAdapter(
  entry: HarnessConfig,
  deps: AcpHarnessDeps,
) {
  return acpHarness(entry, deps)
}
