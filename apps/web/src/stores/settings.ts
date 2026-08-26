import { create } from 'zustand'
import {
  settingsSchema,
  type ForgeSettings,
  type ForgeSettingsPatch,
} from '@forge/protocol/config'
import { api } from '../lib/api'

export type SettingsStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'
type Scope = 'general' | 'epics'
type ScopeState = { status: SettingsStatus; error: string | null }

type SettingsState = {
  settings: ForgeSettings
  scopes: Record<Scope, ScopeState>
  load: () => Promise<void>
  patch: (scope: Scope, patch: ForgeSettingsPatch) => void
  save: (scope: Scope, patch: ForgeSettingsPatch) => Promise<void>
  retry: (scope: Scope) => Promise<void>
}

const initial: ForgeSettings = {
  titleGeneration: true,
  keybindings: {},
  epicDefaults: { workerCount: 3, mode: 'pool' },
}
const errorText = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause)
const emptyScope = (): ScopeState => ({ status: 'idle', error: null })

const revisions = new Map<Scope, number>()
const pending = new Map<Scope, Promise<void>>()
const failedPatch = new Map<Scope, ForgeSettingsPatch>()

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: initial,
  scopes: { general: emptyScope(), epics: emptyScope() },
  load: async () => {
    const value = await api.getSettings()
    const parsed = settingsSchema.safeParse({ ...initial, ...value })
    set({ settings: parsed.success ? parsed.data : initial })
  },
  patch: (scope, patch) => {
    failedPatch.delete(scope)
    set((state) => ({
      settings: { ...state.settings, ...patch },
      scopes: {
        ...state.scopes,
        [scope]: { status: 'dirty', error: null },
      },
    }))
  },
  save: async (scope, patch) => {
    const requestRevision = (revisions.get(scope) ?? 0) + 1
    revisions.set(scope, requestRevision)
    set((state) => ({
      settings: { ...state.settings, ...patch },
      scopes: { ...state.scopes, [scope]: { status: 'dirty', error: null } },
    }))
    const request = (pending.get(scope) ?? Promise.resolve()).then(async () => {
      set((state) => ({
        scopes: { ...state.scopes, [scope]: { status: 'saving', error: null } },
      }))
      try {
        const value = await api.saveSettings(patch)
        if (requestRevision === revisions.get(scope)) {
          failedPatch.delete(scope)
          set((state) => ({
            settings: {
              ...state.settings,
              ...(value as Partial<ForgeSettings>),
            },
            scopes: {
              ...state.scopes,
              [scope]: { status: 'saved', error: null },
            },
          }))
        }
      } catch (cause) {
        if (requestRevision === revisions.get(scope)) {
          failedPatch.set(scope, patch)
          set((state) => ({
            scopes: {
              ...state.scopes,
              [scope]: { status: 'error', error: errorText(cause) },
            },
          }))
        }
        if (requestRevision === revisions.get(scope)) throw cause
      }
    })
    pending.set(
      scope,
      request.catch(() => undefined),
    )
    return request
  },
  retry: async (scope) => get().save(scope, failedPatch.get(scope) ?? {}),
}))

export const resetSettingsStore = () => {
  revisions.clear()
  pending.clear()
  failedPatch.clear()
  useSettingsStore.setState({
    settings: initial,
    scopes: { general: emptyScope(), epics: emptyScope() },
  })
}
