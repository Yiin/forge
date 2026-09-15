import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  defaultConfig,
  convertConfig,
  convertConfigFileSync,
  loadConfigSync,
  reconcileConfig,
  resolveRunConfig,
  saveConfigSync,
} from './config.js'

describe('resolveRunConfig', () => {
  test('uses input over repo over defaults and records provenance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-config-'))
    await mkdir(join(root, '.forge'))
    await writeFile(
      join(root, '.forge', 'epic-run.json'),
      JSON.stringify({ mode: 'serial', workerCount: 2 }),
    )
    await expect(
      resolveRunConfig(
        root,
        { workerCount: 5 },
        { workerCount: 1, mode: 'pool' },
      ),
    ).resolves.toMatchObject({
      workerCount: 5,
      mode: 'serial',
      provenance: { workerCount: 'input', mode: 'repo' },
    })
    await rm(root, { recursive: true, force: true })
  })

  test('rejects unknown repo keys instead of defaulting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-config-'))
    await mkdir(join(root, '.forge'))
    await writeFile(join(root, '.forge', 'epic-run.json'), '{"wat":true}')
    await expect(resolveRunConfig(root, {})).rejects.toThrow()
    await rm(root, { recursive: true, force: true })
  })

  test('keeps an empty tier fail-soft for callers', async () => {
    const result = await resolveRunConfig('/missing', {
      rolePolicy: {
        roles: {
          'iteration-worker': 'empty',
          'triage-control': 'empty',
          'title-generation': 'empty',
        },
        tiers: { empty: [] },
      },
    })
    expect(result.rolePolicy?.tiers.empty).toEqual([])
  })
})

describe('default harness configuration', () => {
  test('classifies legacy entries without changing their commands', () => {
    const config = defaultConfig(false)
    const converted = convertConfig(config)
    expect(converted.harness.kimi).toMatchObject({
      adapterKind: 'native',
      command: 'kimi',
      args: ['acp'],
    })
    expect(converted.harness.grok.adapterKind).toBe('custom')
  })

  test('keeps a recovery copy and leaves the original on parse failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-config-cutover-'))
    const file = join(root, 'forge.toml')
    const config = defaultConfig(false)
    saveConfigSync(file, config)
    const converted = convertConfigFileSync(file)
    expect(converted.harness.opencode.adapterKind).toBe('native')
    expect(await readFile(`${file}.pre-native-cutover`, 'utf8')).toContain(
      'dataDir',
    )
    const bad = join(root, 'bad.toml')
    await writeFile(bad, 'not = [valid')
    await expect(() => convertConfigFileSync(bad)).toThrow()
    expect(await readFile(bad, 'utf8')).toBe('not = [valid')
    await rm(root, { recursive: true, force: true })
  })

  test('preserves the file-relative data directory during conversion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-config-relative-'))
    const file = join(root, 'forge.toml')
    const source = defaultConfig(false)
    delete (source as { dataDir?: string }).dataDir
    saveConfigSync(file, source)
    const before = loadConfigSync(file)

    convertConfigFileSync(file)

    expect(loadConfigSync(file)).toMatchObject({ dataDir: before.dataDir })
    await rm(root, { recursive: true, force: true })
  })

  test('keeps exact source bytes when temporary conversion fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-config-atomic-'))
    const file = join(root, 'forge.toml')
    const source = defaultConfig(false)
    saveConfigSync(file, source)
    const original = await readFile(file)

    const ops = {
      readFileSync: (path: string, encoding: 'utf8') =>
        readFileSync(path, encoding),
      existsSync: () => false,
      copyFileSync: () => {},
      writeFileSync: () => {
        throw new Error('disk full')
      },
      renameSync: () => {},
      unlinkSync: () => {},
    }
    expect(() => convertConfigFileSync(file, ops)).toThrow('disk full')
    expect(await readFile(file)).toEqual(original)

    expect(() =>
      convertConfigFileSync(file, {
        ...ops,
        writeFileSync: () => {},
        renameSync: () => {
          throw new Error('rename failed')
        },
      }),
    ).toThrow('rename failed')
    expect(await readFile(file)).toEqual(original)
    await rm(root, { recursive: true, force: true })
  })

  test('omits shell and mock outside development', () => {
    expect(defaultConfig(false).harness).not.toHaveProperty('shell')
    expect(defaultConfig(false).harness).not.toHaveProperty('mock')
    expect(defaultConfig(true).harness).toHaveProperty('mock')
  })

  test('includes the Pi ACP adapter harness', () => {
    expect(defaultConfig(false).harness.pi).toMatchObject({
      name: 'Pi',
      command: 'npx',
      args: ['-y', 'pi-acp'],
      protocol: 'acp',
    })
  })

  test('includes the native OpenCode ACP harness', () => {
    expect(defaultConfig(false).harness.opencode).toMatchObject({
      name: 'OpenCode',
      command: 'opencode',
      args: ['acp'],
      protocol: 'acp',
    })
  })

  test('merges defaults and preserves user harness fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-config-'))
    const file = join(root, 'forge.toml')
    const defaults = defaultConfig(false)
    const config = {
      ...defaults,
      harness: {
        shell: {
          ...defaults.harness['claude-code-acp'],
          name: 'Shell PTY',
          command: 'bash',
          args: ['-i'],
          protocol: 'pty' as const,
        },
        custom: {
          ...defaults.harness['claude-code-acp'],
          name: 'My agent',
          command: 'my-agent',
          args: ['--keep'],
          env: { KEEP: 'yes' },
          quietPeriodMs: 17,
          maxTurnMs: 19,
        },
      },
    }
    saveConfigSync(file, config)

    const reconciled = reconcileConfig(config, defaults)
    expect(reconciled.harness).not.toHaveProperty('shell')
    expect(reconciled.harness.custom).toMatchObject({
      command: 'my-agent',
      args: ['--keep'],
      env: { KEEP: 'yes' },
      quietPeriodMs: 17,
      maxTurnMs: 19,
    })
    expect(Object.keys(reconciled.harness)).toEqual([
      'custom',
      'claude-code-acp',
      'codex-acp',
      'kimi',
      'gemini',
      'opencode',
      'grok',
      'devin',
      'hermes',
      'pi',
    ])
    expect(
      reconcileConfig(
        {
          ...config,
          harness: {
            ...config.harness,
            shell: { ...config.harness.shell, name: 'My shell' },
          },
        },
        defaults,
      ).harness.shell,
    ).toMatchObject({ name: 'My shell', command: 'bash' })
    await rm(root, { recursive: true, force: true })
  })

  test('prunes an unavailable stock mock but keeps an edited mock', () => {
    const defaults = defaultConfig(false)
    const stockMock = {
      name: 'Mock ACP agent',
      command: 'bun',
      args: ['/missing/acp-mock-agent.ts'],
      env: {},
      protocol: 'acp' as const,
      enabled: false,
    }
    const base = {
      ...defaults,
      harness: { ...defaults.harness, mock: stockMock },
    }
    expect(reconcileConfig(base, defaults).harness).not.toHaveProperty('mock')
    expect(
      reconcileConfig(
        {
          ...base,
          harness: { ...base.harness, mock: { ...stockMock, name: 'My mock' } },
        },
        defaults,
      ).harness.mock,
    ).toMatchObject({ name: 'My mock' })
  })
})
