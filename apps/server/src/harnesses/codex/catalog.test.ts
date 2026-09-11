import { describe, expect, it } from 'vitest'
import { mkdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { expectStopped } from '../transport-test-helpers.js'
import { discoverCodex } from './catalog.js'
import { readCodexHistoryPage, forkCodexThread } from './history.js'
import {
  admitCodexConfiguration,
  prepareCodexEnvironment,
  selectedRemovalKeys,
} from './environment.js'
import { createCodexAdapter, type CodexAdapterOptions } from './index.js'
import { peer, model, methods } from './test-helpers.js'

describe('Codex catalog and native account provenance', () => {
  it.each(['command', 'aws'])(
    '51, 105: an authorized eager %s fixture preserves native source configuration and unverified identity',
    async (source) => {
      const config = {
        model_provider: 'custom',
        model_providers: {
          custom: {
            name: 'Fixture',
            ...(source === 'command'
              ? {
                  auth: {
                    command: 'fixture-no-execution',
                    cwd: '/fixture',
                    refresh_interval_ms: 0,
                  },
                }
              : {
                  aws: { profile: 'fixture-profile', region: 'fixture-region' },
                }),
          },
        },
      }
      const p = await peer([], { selected: true, eager: source, config })
      await p.save(p.startup.slice(0, -1))
      const found = await discoverCodex(p.options, { cwd: p.root })
      expect(found.provenance.sourceClasses).toContain(source)
      expect(found.provenance.effectiveCredentialIdentity).toBe('unverified')
      const trace = await p.trace()
      expect(trace[1]).toEqual({ event: 'authorized-eager-source', source })
      expect(trace[2]!.method).toBe('initialize')
      expect(await methods(p)).not.toContain('thread/start')
    },
  )
  it('37, 39, 113: keeps hidden models, wire IDs, arbitrary effort, skills, and account provenance separate', async () => {
    const p = await peer([], {
      selected: true,
      config: {
        model_provider: 'custom',
        model_providers: { custom: { env_key: 'FIXTURE_CUSTOM' } },
        model: 'hidden-wire',
      },
      modelPages: [
        {
          method: 'model/list',
          result: { data: [model], nextCursor: 'opaque/α' },
        },
        {
          method: 'model/list',
          expected: { includeHidden: true, limit: 100, cursor: 'opaque/α' },
          result: {
            data: [
              { ...model, id: 'hidden-id', model: 'hidden-wire', hidden: true },
            ],
            nextCursor: null,
          },
        },
      ],
    })
    p.startup[3]!.result = {
      account: {
        type: 'chatgpt',
        email: 'fixture@example.test',
        planType: 'pro',
      },
      requiresOpenaiAuth: false,
    }
    p.startup.at(-2)!.result = {
      data: [
        {
          cwd: p.root,
          skills: [
            {
              name: 'duplicate',
              description: 'First',
              path: join(p.root, 'first'),
              scope: 'user',
              enabled: true,
            },
            {
              name: 'duplicate',
              description: 'Second',
              path: join(p.root, 'second'),
              scope: 'repo',
              enabled: false,
              pluginId: 'fixture',
            },
          ],
          errors: [
            { path: join(p.root, 'broken'), message: 'Fixture skill error' },
          ],
        },
      ],
    }
    await p.save(p.startup.slice(0, -1))
    const found = await discoverCodex(p.options, { cwd: p.root })
    expect(
      found.models.map((entry) => [entry.id, entry.model, entry.hidden]),
    ).toEqual([
      ['catalog-m', 'm', false],
      ['hidden-id', 'hidden-wire', true],
    ])
    expect(found.visibleModels).toHaveLength(1)
    expect(found.models[0]!.supportedReasoningEfforts[1]!.reasoningEffort).toBe(
      'novel',
    )
    expect(found.skills[0]!.skills.map((skill) => skill.enabled)).toEqual([
      true,
      false,
    ])
    expect(found.complete).toEqual({
      account: true,
      models: true,
      skills: false,
    })
    expect(found.provenance).toMatchObject({
      accountId: 'account',
      verifiedHomeScope: p.root,
      selectedProviderId: 'custom',
      sourceClasses: ['environment-key'],
      effectiveCredentialIdentity: 'unverified',
      accountObservation: 'account/read',
    })
    expect(found.account).toMatchObject({
      account: { email: 'fixture@example.test' },
      requiresOpenaiAuth: false,
    })
    expect(await methods(p)).not.toContain('thread/start')
    const pid = (await p.trace()).find((frame) => frame.event === 'spawned')!
      .pid as number
    await expectStopped(pid)
  })

  it.each(['cursor', 'duplicate', 'error'])(
    '38: %s catalog failure remains separate from account state',
    async (kind) => {
      const p = await peer([], {
        modelPages: [
          {
            method: 'model/list',
            result: { data: [model], nextCursor: 'next' },
          },
          kind === 'error'
            ? {
                method: 'model/list',
                error: { code: -32000, message: 'Catalog unavailable' },
              }
            : {
                method: 'model/list',
                result: {
                  data: [
                    {
                      ...model,
                      ...(kind === 'duplicate' ? { model: 'conflict' } : {}),
                    },
                  ],
                  nextCursor: kind === 'cursor' ? 'next' : null,
                },
              },
        ],
      })
      await p.save(p.startup.slice(0, -1))
      const found = await discoverCodex(p.options, { cwd: p.root })
      expect(found.complete.models).toBe(false)
      expect(found.errors.models).toBeTruthy()
      expect(found.account).toEqual({ account: null, requiresOpenaiAuth: true })
      expect(found.models).toEqual([])
    },
  )

  it('38, 39: abort closes discovery without login or model dispatch', async () => {
    const p = await peer()
    p.startup[4] = {
      method: 'model/list',
      delay: 100,
      result: { data: [model] },
    }
    await p.save(p.startup.slice(0, -1))
    const signal = AbortSignal.timeout(30)
    await expect(
      discoverCodex(p.options, { cwd: p.root, signal }),
    ).rejects.toThrow()
    expect(await methods(p)).not.toContain('thread/start')
  })

  it.each(['runtime', 'discovery', 'history', 'fork'])(
    '101, 106: %s rejects missing authority before any launch',
    async (surface) => {
      const p = await peer([], { selected: true, eager: 'model-refresh' })
      const options = {
        ...p.options,
        nativeLaunch: undefined,
      } as unknown as CodexAdapterOptions
      const binding = {
        provider: 'codex-test',
        accountId: 'account',
        cwd: p.root,
        providerSessionId: 'root',
      }
      const call = () =>
        surface === 'runtime'
          ? createCodexAdapter(options).spawn(
              {
                id: 'session',
                provider: 'codex-test',
                accountId: 'account',
                cwd: p.root,
              },
              () => {},
            )
          : surface === 'discovery'
            ? discoverCodex(options, { cwd: p.root })
            : surface === 'history'
              ? readCodexHistoryPage(options, binding, { type: 'turns' })
              : forkCodexThread(options, binding, { cwd: p.root })
      await expect(Promise.resolve().then<unknown>(call)).rejects.toThrow(
        'AUTHORITY_REQUIRED',
      )
      expect(await p.trace()).toEqual([])
    },
  )

  it.each([
    'id',
    'provider',
    'home',
    'cwd',
    'command',
    'args',
    'disabled-account',
    'disabled-harness',
    'adapter',
  ])('102: mismatched %s authority starts no child', async (field) => {
    const p = await peer([], { selected: true })
    if (p.options.accountId === null)
      throw new Error('Expected selected context')
    const authority = structuredClone(p.options.nativeLaunch)
    if (field === 'id') authority.account.id = 'other'
    if (field === 'provider') authority.provider = 'other'
    if (field === 'home') authority.account.homePath = '/missing-account-home'
    if (field === 'cwd') authority.canonicalCwd = '/other-workspace'
    if (field === 'command') p.options.command = '/other-command'
    if (field === 'args') p.options.args = ['--profile', 'different']
    if (field === 'disabled-account') authority.account.disabledAt = 123
    if (field === 'disabled-harness') authority.harness.enabled = false
    if (field === 'adapter') authority.harness.adapterKind = 'acp'
    p.options.nativeLaunch = authority
    await expect(p.start()).rejects.toThrow()
    expect(await p.trace()).toEqual([])
  })

  it('45, 48, 49: canonical homes, explicit workload pairs, and state relocation retain exact scope', async () => {
    const p = await peer([], { selected: true })
    if (p.options.accountId === null)
      throw new Error('Expected selected context')
    const alias = join(p.root, 'alias')
    await symlink(p.root, alias)
    await expect(
      prepareCodexEnvironment(
        { ...p.options, expectedCodexHome: alias },
        p.root,
      ),
    ).rejects.toThrow('HOME')
    await expect(
      prepareCodexEnvironment(
        { ...p.options, env: { ...p.options.env, CODEX_HOME: '' } },
        p.root,
      ),
    ).rejects.toThrow('HOME')
    const state = join(p.root, 'state')
    await mkdir(state)
    const env = {
      ...p.options.env,
      OPENAI_FEDERATION_RULE_ID: 'fixture-rule',
      OPENAI_IDENTITY_TOKEN_FILE: '/fixture/token-path',
      OPENAI_WORKLOAD_IDENTITY_CONTEXT: 'fixture-context',
      CODEX_SQLITE_HOME: state,
    }
    const admitted = await prepareCodexEnvironment(
      { ...p.options, env },
      p.root,
    )
    expect(admitted.env.CODEX_SQLITE_HOME).toBe(state)
    for (const overrides of [
      { OPENAI_IDENTITY_TOKEN_FILE: undefined },
      { OPENAI_FEDERATION_RULE_ID: '' },
      { CODEX_ACCESS_TOKEN: 'fixture-access' },
    ]) {
      await expect(
        prepareCodexEnvironment(
          { ...p.options, env: { ...env, ...overrides } },
          p.root,
        ),
      ).rejects.toThrow('SELECTOR')
    }
  })

  it.each(['model-refresh', 'turn-cost'])(
    '46, 47, 103, 104: eager %s sees exact explicit values without credential output',
    async (eager) => {
      const p = await peer([], {
        selected: true,
        eager,
        environment: {
          FIXTURE_CUSTOM: 'sentinel-custom',
          OPENAI_API_KEY: 'sentinel-explicit',
        },
        absent: selectedRemovalKeys.filter(
          (key) => !['CODEX_HOME', 'OPENAI_API_KEY'].includes(key),
        ),
      })
      p.options.env = {
        ...p.options.env,
        FIXTURE_CUSTOM: 'sentinel-custom',
        OPENAI_API_KEY: 'sentinel-explicit',
        CODEX_ACCESS_TOKEN: undefined,
      } as NodeJS.ProcessEnv & { CODEX_HOME: string }
      await p.start()
      const trace = await p.trace()
      expect(trace[1]).toEqual({
        event: 'authorized-eager-source',
        source: eager,
      })
      expect(JSON.stringify(trace)).not.toContain('sentinel-')
    },
  )

  it('52, 107, 112: config shape failure closes authorized eager work before later RPCs', async () => {
    const p = await peer([], {
      selected: true,
      eager: 'turn-cost',
      config: {
        model_provider: 'custom',
        model_providers: {
          custom: { unsupported_auth: 'secret-bearer-value' },
        },
      },
    })
    await expect(p.start()).rejects.toThrow('CONFIG_PROVIDER_SHAPE')
    expect(await methods(p)).toEqual([
      'initialize',
      'initialized',
      'config/read',
    ])
    expect(JSON.stringify(p.events)).not.toContain('secret-bearer-value')
    const pid = (await p.trace()).find((frame) => frame.event === 'spawned')!
      .pid as number
    await expectStopped(pid)
  })
})

describe('Pinned native active-provider extraction', () => {
  const admit = (config: Record<string, unknown>) =>
    admitCodexConfiguration(
      { config, origins: {} },
      { accountId: 'account', expectedHome: '/fixture/home' },
    )
  it.each(['openai', 'ollama', 'lmstudio'])(
    '108: ignores discarded configured %s credentials',
    (selected) => {
      const result = admit({
        model_provider: selected,
        model_providers: {
          [selected]: {
            env_key: 'UNUSED',
            auth: { command: 'unused-command' },
            unsupported_field: 'unused',
          },
        },
      })
      expect(result.provenance.sourceClasses).toEqual(
        selected === 'openai'
          ? ['native-account', 'built-in-environment-headers']
          : ['local-provider'],
      )
    },
  )
  it('109, 110: only the active custom record supplies provenance', () => {
    expect(
      admit({ model_providers: { unused: { env_key: 'UNOWNED' } } }).provenance
        .selectedProviderId,
    ).toBe('openai')
    expect(
      admit({
        model_provider: 'custom',
        model_providers: {
          custom: {
            env_key: 'CUSTOM',
            env_http_headers: { 'X-User': 'CUSTOM_USER' },
            experimental_bearer_token: 'fixture-bearer',
          },
        },
      }).provenance.sourceClasses,
    ).toEqual(['environment-key', 'configured-bearer', 'environment-headers'])
  })
  it.each(['amazon-bedrock', 'amazon-bedrock-runtime'])(
    '105, 111: %s retains native AWS defaults and optional overrides',
    (selected) => {
      for (const provider of [
        undefined,
        {},
        {
          base_url: 'https://fixture.test',
          http_headers: { 'X-Test': 'fixture' },
        },
        {
          aws: {
            profile: 'fixture',
            region: 'fixture-region',
            auth_refresh: { command: 'aws', args: ['sso', 'login'] },
          },
        },
        { name: '', wire_api: 'responses', requires_openai_auth: false },
      ]) {
        expect(
          admit({
            model_provider: selected,
            model_providers: { [selected]: provider },
          }).provenance.sourceClasses,
        ).toContain('aws')
      }
    },
  )
  it.each(['amazon-bedrock', 'amazon-bedrock-runtime'])(
    '112: %s rejects nondefault residual fields',
    (selected) => {
      for (const provider of [
        { env_key: 'CUSTOM' },
        { name: 'custom' },
        { supports_websockets: true },
        { env_http_headers: {} },
      ])
        expect(() =>
          admit({
            model_provider: selected,
            model_providers: { [selected]: provider },
          }),
        ).toThrow()
    },
  )
  it('51, 105, 112: command sources stay unverified and malformed command conflicts fail', () => {
    expect(
      admit({
        model_provider: 'custom',
        model_providers: {
          custom: {
            auth: {
              command: 'fixture-command',
              args: ['opaque'],
              cwd: '/fixture/auth',
              refresh_interval_ms: 0,
              timeout_ms: 5000,
            },
          },
        },
      }).provenance,
    ).toMatchObject({
      sourceClasses: ['command'],
      effectiveCredentialIdentity: 'unverified',
    })
    for (const provider of [
      { auth: { command: 'fixture' }, env_key: 'CONFLICT' },
      { auth: { command: ' ' } },
      { aws: {}, auth: { command: 'fixture' } },
      { aws: { auth_refresh: { command: 'not-aws' } } },
    ])
      expect(() =>
        admit({
          model_provider: 'custom',
          model_providers: { custom: provider },
        }),
      ).toThrow()
  })
})
