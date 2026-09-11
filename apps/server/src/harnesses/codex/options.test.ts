import { describe, expect, it } from 'vitest'
import { CodexOptions, parseOptions, sameSandbox } from './wire.js'
import { peer, model, sandbox, turn } from './test-helpers.js'

describe('Codex policy layers and native configuration choices', () => {
  it.each([
    ['model', 'model', 'configured', 'initial', 'desired', 'call'],
    ['reasoning', 'model_reasoning_effort', 'medium', 'high', 'novel', 'low'],
    ['serviceTier', 'service_tier', 'default', 'priority', 'flex', 'default'],
    [
      'approvalPolicy',
      'approval_policy',
      'on-request',
      'untrusted',
      'never',
      'on-request',
    ],
    [
      'sandboxPolicy',
      'sandbox_mode',
      'read-only',
      { type: 'workspaceWrite' },
      { type: 'dangerFullAccess' },
      { type: 'readOnly', networkAccess: false },
    ],
  ])(
    '95, 96, 98: %s resolves configured, initial, setter, call, undefined and null layers',
    (field, nativeField, configured, initial, desired, call) => {
      const baseline = new CodexOptions({
        [nativeField as string]: configured,
      }).resolve()
      const policy = new CodexOptions(
        { [nativeField as string]: configured },
        { permissionMode: 'manual', [field as string]: initial },
      )
      expect(policy.resolve()).toMatchObject({ [field as string]: initial })
      policy.set({ [field as string]: desired })
      expect(policy.resolve({ [field as string]: call })).toMatchObject({
        [field as string]: call,
      })
      expect(policy.resolve({ [field as string]: undefined })).toMatchObject({
        [field as string]: desired,
      })
      expect(policy.resolve({ [field as string]: null })).toEqual(baseline)
      expect(policy.resolve()).toMatchObject({ [field as string]: desired })
    },
  )

  it('35, 95, 97, 99: manual restores configured granular rules and workspace details after yolo', () => {
    const granular = {
      sandbox_approval: false,
      rules: false,
      skill_approval: true,
      request_permissions: false,
      mcp_elicitations: true,
    }
    const policy = new CodexOptions({
      approval_policy: { granular },
      sandbox_workspace_write: {
        writable_roots: ['/b', '/a'],
        network_access: false,
        exclude_slash_tmp: true,
        exclude_tmpdir_env_var: false,
      },
    })
    const manual = policy.resolve()
    expect(manual).toMatchObject({
      approvalPolicy: { granular },
      sandboxPolicy: {
        ...sandbox,
        writableRoots: ['/b', '/a'],
        excludeSlashTmp: true,
      },
    })
    const yolo = policy.resolve({ permissionMode: 'yolo' })
    expect(yolo).toMatchObject({
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    })
    policy.sent(yolo)
    expect(policy.resolve()).toEqual(manual)
    expect(
      policy.resolve(
        {
          sandboxPolicy: {
            ...manual.sandboxPolicy,
            writableRoots: ['/a', '/b'],
          },
        },
        manual,
      ).sandboxPolicy,
    ).toMatchObject({ writableRoots: ['/a', '/b'] })
    expect(
      sameSandbox(
        { ...sandbox, writableRoots: ['/a/../b'] },
        { ...sandbox, writableRoots: ['/b'] },
      ),
    ).toBe(false)
  })

  it.each([
    { approvalPolicy: 'always' },
    { model: '' },
    { serviceTier: '' },
    { sandboxPolicy: { type: 'readOnly', access: 'all' } },
    { permissionMode: null },
  ])(
    '36, 96: rejects unsupported or invalid options %j before startup',
    async (initialOptions) => {
      expect(() => parseOptions(initialOptions)).toThrow()
    },
  )

  it('37, 95, 99: advertises hidden selected model, exact catalog IDs, and only its effort/tier choices', async () => {
    const selected = {
      ...model,
      id: 'hidden-catalog',
      model: 'hidden-wire',
      hidden: true,
    }
    const p = await peer(
      [{ method: 'turn/start', result: { turn: turn('t1', 'completed') } }],
      {
        config: {
          model: 'hidden-wire',
          model_reasoning_effort: 'novel',
          service_tier: 'priority',
        },
        threadResponse: {
          model: 'hidden-wire',
          reasoningEffort: 'novel',
          serviceTier: 'priority',
        },
        modelPages: [
          {
            method: 'model/list',
            result: {
              data: [
                selected,
                {
                  ...model,
                  supportedReasoningEfforts: [
                    { reasoningEffort: 'other-only', description: 'Other' },
                  ],
                },
              ],
              nextCursor: null,
            },
          },
        ],
      },
    )
    const h = await p.start()
    expect(h.availableModels).toContainEqual({
      id: 'hidden-catalog',
      displayName: 'Model',
    })
    expect(
      h.configOptions!().map((entry) => [entry.id, entry.currentValue]),
    ).toEqual([
      ['model', 'hidden-catalog'],
      ['reasoning', 'novel'],
      ['serviceTier', 'priority'],
      ['permissionMode', 'manual'],
    ])
    await expect(h.setConfigOption!('reasoning', 'other-only')).rejects.toThrow(
      'CONFIG_OPTION',
    )
    await h.setConfigOption!('reasoning', 'medium')
    await h.setConfigOption!('serviceTier', 'default')
    await h.prompt('input')
    const body = (await p.trace()).find(
      (frame) => frame.method === 'turn/start',
    )!.params
    expect(body).toMatchObject({
      model: 'hidden-wire',
      effort: 'medium',
      serviceTier: 'default',
    })
  })
})
