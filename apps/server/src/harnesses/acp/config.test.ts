import { describe, expect, it } from 'vitest'
import { AcpCatalog, nativeModeSelectorId } from './config.js'
const model = {
  id: 'model',
  name: 'Model',
  type: 'select',
  category: 'model',
  currentValue: 'exact-high-fast',
  options: [
    {
      group: 'native-family',
      name: 'Family',
      options: [
        {
          value: 'exact-high-fast',
          name: 'High fast',
          description: 'Native variant',
        },
      ],
    },
  ],
}
describe('ACP native configuration', () => {
  it('preserves grouped values and sends exact advertised model IDs', () => {
    const catalog = new AcpCatalog('gemini')
    catalog.update({ configOptions: [model] })
    expect(catalog.snapshot()).toEqual([model])
    expect(catalog.model('exact-high-fast')).toEqual({
      method: 'session/set_config_option',
      params: { configId: 'model', value: 'exact-high-fast' },
    })
    expect(() => catalog.model('native-family')).toThrow('advertised')
    expect(() => catalog.config('model', true)).toThrow('select')
  })
  it('refuses shared auto instead of converting it to Gemini autoEdit', () => {
    const catalog = new AcpCatalog('gemini')
    catalog.update({
      modes: {
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'autoEdit', name: 'Auto edit' },
        ],
      },
    })
    expect(() => catalog.dispatch({ permissionMode: 'auto' })).toThrow(
      'unsupported',
    )
    expect(catalog.dispatch({ permissionMode: 'manual' })).toEqual([
      { method: 'session/set_mode', params: { modeId: 'default' } },
    ])
    expect(() => catalog.dispatch({ permissionMode: 'yolo' })).toThrow(
      'advertised',
    )
  })
  it('rejects unsupported reasoning and policies before native calls', () => {
    const catalog = new AcpCatalog('gemini')
    expect(() =>
      catalog.dispatch({ permissionMode: 'manual', reasoning: 'high' }),
    ).toThrow('reasoning')
    expect(() =>
      catalog.dispatch({
        permissionMode: 'manual',
        sandboxPolicy: { type: 'readOnly' },
      }),
    ).toThrow('policy')
    expect(() =>
      catalog.dispatch({ permissionMode: 'manual', serviceTier: 'fast' }),
    ).toThrow('policy')
  })
  it('rejects boolean and duplicate config snapshots without replacing the previous catalog', () => {
    const catalog = new AcpCatalog('gemini')
    catalog.update({ configOptions: [model] })
    expect(() =>
      catalog.update({
        configOptions: [
          { id: 'flag', name: 'Flag', type: 'boolean', currentValue: true },
        ],
      }),
    ).toThrow()
    expect(() => catalog.update({ configOptions: [model, model] })).toThrow(
      'duplicate',
    )
    expect(catalog.snapshot()).toEqual([model])
  })
  it('rejects invalid current values atomically and keeps native modes explicit', () => {
    const catalog = new AcpCatalog('gemini')
    catalog.update({ configOptions: [model] })
    expect(() =>
      catalog.update({
        configOptions: [{ ...model, currentValue: 'missing' }],
      }),
    ).toThrow('current value')
    expect(catalog.snapshot()).toEqual([model])
    catalog.update({
      modes: {
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'autoEdit', name: 'Auto edit', description: 'Edit tools only' },
          { id: 'plan', name: 'Plan' },
        ],
      },
    })
    expect(
      catalog.snapshot().find((option) => option.id === nativeModeSelectorId)
        ?.options,
    ).toContainEqual({
      value: 'autoEdit',
      name: 'Auto edit',
      description: 'Edit tools only',
    })
    const previous = catalog.snapshot()
    for (const modes of [
      {
        currentModeId: 'missing',
        availableModes: [{ id: 'default', name: 'Default' }],
      },
      {
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'default', name: 'Duplicate' },
        ],
      },
    ]) {
      expect(() => catalog.update({ modes })).toThrow('identities')
      expect(catalog.snapshot()).toEqual(previous)
    }
    expect(catalog.config(nativeModeSelectorId, 'autoEdit')).toEqual({
      method: 'session/set_mode',
      params: { modeId: 'autoEdit' },
    })
    expect(catalog.dispatch({}, 'plan')).toEqual([
      { method: 'session/set_mode', params: { modeId: 'plan' } },
    ])
    expect(() =>
      catalog.dispatch({ permissionMode: 'manual' }, 'autoEdit'),
    ).toThrow('conflicts')
  })
  it.each(['hermes', 'devin', 'custom-acp'] as const)(
    'does not infer shared yolo from %s native advertisement',
    (profile) => {
      const catalog = new AcpCatalog(profile)
      catalog.update({
        modes: {
          currentModeId: 'default',
          availableModes: [
            { id: 'default', name: 'Default' },
            { id: 'yolo', name: 'Native yolo' },
          ],
        },
      })
      expect(() => catalog.dispatch({ permissionMode: 'yolo' })).toThrow(
        'unsupported',
      )
    },
  )
})
