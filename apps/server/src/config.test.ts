import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { resolveRunConfig } from './config.js'

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
