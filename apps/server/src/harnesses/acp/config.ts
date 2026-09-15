import { z } from 'zod'
import {
  zSessionConfigOption,
  zSessionModeState,
  zSessionModelState,
} from '@agentclientprotocol/sdk/dist/schema/zod.gen.js'
import type { DispatchOptions, SessionConfigOption } from '../types.js'
import { immutableData } from './data.js'
import type { AcpProfile } from './profiles.js'
export const nativeModeSelectorId = 'forge.acp.native-mode'

type Change = Readonly<{
  method: 'session/set_config_option' | 'session/set_mode' | 'session/set_model'
  params: Readonly<Record<string, string>>
}>
const choices = (option: SessionConfigOption) =>
  (option.options ?? []).flatMap((value) =>
    'group' in value ? value.options : [value],
  )
export class AcpCatalog {
  private options: readonly SessionConfigOption[] = []
  private modes: Array<{ id: string; name: string; description?: string }> = []
  private currentMode = ''
  constructor(private readonly profile: AcpProfile) {}
  private models: Array<{ id: string; displayName: string }> = []
  update(input: {
    configOptions?: unknown
    modes?: unknown
    models?: unknown
  }) {
    const captured = immutableData(input, 2 * 1024 * 1024)
    const options =
      captured.configOptions === undefined
        ? undefined
        : z.array(zSessionConfigOption).max(2048).parse(captured.configOptions)
    const modes =
      captured.modes === undefined
        ? undefined
        : zSessionModeState.parse(captured.modes)
    const models =
      captured.models === undefined
        ? undefined
        : zSessionModelState.parse(captured.models)
    if (
      (modes?.availableModes.length ?? 0) > 2048 ||
      (models?.availableModels.length ?? 0) > 2048
    )
      throw Error('ACP catalog limit')
    if (
      modes &&
      (!modes.availableModes.some((mode) => mode.id === modes.currentModeId) ||
        new Set(modes.availableModes.map((mode) => mode.id)).size !==
          modes.availableModes.length)
    )
      throw Error('ACP mode identities are invalid')
    const projected: SessionConfigOption[] | undefined = options?.map(
      (option) => {
        const choice = (value: {
          value: string
          name: string
          description?: string | null
        }) => ({
          value: value.value,
          name: value.name,
          ...(value.description == null
            ? {}
            : { description: value.description }),
        })
        return {
          id: option.id,
          name: option.name,
          type: 'select',
          currentValue: option.currentValue,
          ...(option.description == null
            ? {}
            : { description: option.description }),
          ...(option.category == null ? {} : { category: option.category }),
          options:
            option.options.length && 'group' in option.options[0]!
              ? (
                  option.options as Array<{
                    group: string
                    name: string
                    options: Array<{
                      value: string
                      name: string
                      description?: string | null
                    }>
                  }>
                ).map((group) => ({
                  group: group.group,
                  name: group.name,
                  options: group.options.map(choice),
                }))
              : (
                  option.options as Array<{
                    value: string
                    name: string
                    description?: string | null
                  }>
                ).map(choice),
        }
      },
    )
    if (projected) {
      let count = projected.length
      const ids = new Set<string>()
      for (const option of projected) {
        if (ids.has(option.id) || option.id === nativeModeSelectorId)
          throw Error('ACP duplicate configuration ID')
        ids.add(option.id)
        const values = choices(option)
        if (!values.some((value) => value.value === option.currentValue))
          throw Error('ACP current value was not advertised')
        count += values.length
        if (
          count > 2048 ||
          new Set(values.map((value) => value.value)).size !== values.length
        )
          throw Error('ACP configuration choice limit or duplicate')
      }
    }
    if (projected) this.options = immutableData(projected)
    if (modes) {
      this.modes = modes.availableModes.map((mode) => ({
        id: mode.id,
        name: mode.name,
        ...(mode.description == null ? {} : { description: mode.description }),
      }))
      this.currentMode = modes.currentModeId
    }
    if (models)
      this.models = models.availableModels.map((model) => ({
        id: model.modelId,
        displayName: model.name,
      }))
  }
  snapshot(): SessionConfigOption[] {
    return immutableData([
      ...this.options,
      ...(this.modes.length
        ? [
            {
              id: nativeModeSelectorId,
              name: 'Native mode',
              category: 'mode',
              type: 'select' as const,
              currentValue: this.currentMode,
              options: this.modes.map((mode) => ({
                value: mode.id,
                name: mode.name,
                ...(mode.description === undefined
                  ? {}
                  : { description: mode.description }),
              })),
            },
          ]
        : []),
    ])
  }
  availableModels() {
    return immutableData(this.models)
  }
  config(id: string, value: string | boolean): Change {
    if (typeof value !== 'string')
      throw Error('ACP configuration requires a native select value')
    if (id === nativeModeSelectorId) return this.nativeMode(value)
    const option = this.options.find((option) => option.id === id)
    if (!option || !choices(option).some((choice) => choice.value === value))
      throw Error('ACP configuration value was not advertised')
    return Object.freeze({
      method: 'session/set_config_option',
      params: Object.freeze({ configId: id, value }),
    })
  }
  model(modelId: string): Change {
    const config = this.options.find((option) => option.category === 'model')
    if (config) return this.config(config.id, modelId)
    if (!this.models.some((model) => model.id === modelId))
      throw Error('ACP model was not advertised')
    return Object.freeze({
      method: 'session/set_model',
      params: Object.freeze({ modelId }),
    })
  }
  nativeMode(modeId: string): Change {
    if (!this.modes.some((mode) => mode.id === modeId))
      throw Error('ACP native mode was not advertised')
    return Object.freeze({
      method: 'session/set_mode',
      params: Object.freeze({ modeId }),
    })
  }
  dispatch(
    options: Partial<DispatchOptions>,
    nativeMode?: string,
  ): readonly Change[] {
    const captured = immutableData(options)
    if (
      captured.approvalPolicy != null ||
      captured.sandboxPolicy != null ||
      captured.serviceTier != null
    )
      throw Error('ACP dispatch policy is unsupported')
    const changes: Change[] = []
    if (captured.model != null) changes.push(this.model(captured.model))
    if (captured.reasoning != null) {
      const config = this.options.find(
        (option) => option.category === 'thought_level',
      )
      if (!config) throw Error('ACP reasoning selection is unsupported')
      changes.push(this.config(config.id, captured.reasoning))
    }
    if (captured.permissionMode === 'auto')
      throw Error('ACP auto permission mode is unsupported')
    if (captured.permissionMode === 'yolo' && this.profile !== 'gemini')
      throw Error('ACP yolo policy is unsupported for this profile')
    const mode = captured.permissionMode === 'yolo' ? 'yolo' : 'default'
    if (nativeMode !== undefined) {
      if (captured.permissionMode !== undefined && nativeMode !== mode)
        throw Error('ACP native mode conflicts with shared policy')
      changes.push(this.nativeMode(nativeMode))
    } else if (this.profile === 'gemini' || this.profile === 'hermes') {
      if (this.modes.length || captured.permissionMode === 'yolo')
        changes.push(this.nativeMode(mode))
    }
    return Object.freeze(changes)
  }
}
