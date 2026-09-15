import {
  createTypedAcpAdapter,
  type AcpRuntimeDependencies,
} from './runtime.js'

export { acpProviderDescriptors } from './profiles.js'
export type DedicatedAcpDependencies = Omit<AcpRuntimeDependencies, 'profile'>

export function createGrokAdapter(
  deps: DedicatedAcpDependencies & { grokRail: 'public' | 'comet' },
) {
  return createTypedAcpAdapter({ ...deps, profile: 'grok' })
}
export function createGeminiAdapter(deps: DedicatedAcpDependencies) {
  return createTypedAcpAdapter({ ...deps, profile: 'gemini' })
}
export function createDevinAdapter(deps: DedicatedAcpDependencies) {
  return createTypedAcpAdapter({ ...deps, profile: 'devin' })
}
export function createHermesAdapter(deps: DedicatedAcpDependencies) {
  return createTypedAcpAdapter({ ...deps, profile: 'hermes' })
}
export function createCustomAcpAdapter(deps: DedicatedAcpDependencies) {
  return createTypedAcpAdapter({ ...deps, profile: 'custom-acp' })
}
