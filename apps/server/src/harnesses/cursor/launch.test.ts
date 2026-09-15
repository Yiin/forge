import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
it('rejects missing SDK files, wrong versions and altered platform bytes before launch', async () => {
  const root = await mkdtemp('/tmp/forge-cursor-launch-'),
    artifact = join(root, 'cursor-sidecar'),
    exec = promisify(execFile)
  try {
    await mkdir(join(root, 'accounts/test'), { recursive: true })
    await mkdir(join(root, 'state'))
    await mkdir(artifact)
    await exec(
      'bun',
      [
        'build',
        '--target=node',
        resolve('apps/server/test/fixtures/cursor-launch-check.ts'),
        '--outfile',
        join(root, 'check.mjs'),
      ],
      { timeout: 30000, maxBuffer: 4096 },
    )
    const files = []
    for (const path of [
      'sidecar.mjs',
      'guardian.mjs',
      'node_modules/@cursor/sdk/package.json',
      'node_modules/@cursor/sdk-linux-x64/bin/cursorsandbox',
    ]) {
      const contents = Buffer.from(`source-shaped fixture: ${path}`),
        target = join(artifact, path)
      await mkdir(join(target, '..'), { recursive: true })
      await writeFile(target, contents)
      files.push({
        path,
        bytes: contents.length,
        mode: (await stat(target)).mode & 511,
        sha256: createHash('sha256').update(contents).digest('hex'),
      })
    }
    const manifest = {
      version: 1,
      sdkVersion: '1.0.28',
      packages: ['@cursor/sdk', '@cursor/sdk-linux-x64'].map((name) => ({
        name,
        version: '1.0.28',
      })),
      files,
    }
    const writeManifest = () =>
      writeFile(join(artifact, 'manifest.json'), JSON.stringify(manifest))
    const run = async () =>
      JSON.parse(
        (
          await exec(process.execPath, [join(root, 'check.mjs'), root], {
            env: { ...process.env, FORGE_ACCOUNTS_DIR: join(root, 'accounts') },
            timeout: 5000,
            maxBuffer: 4096,
          })
        ).stdout,
      )
    await writeManifest()
    expect(await run()).toEqual({ captured: true, removedKey: true })
    manifest.sdkVersion = '1.0.27'
    await writeManifest()
    expect(await run()).toMatchObject({
      captured: false,
      code: 'cursor_artifact_manifest',
    })
    manifest.sdkVersion = '1.0.28'
    await writeManifest()
    const helper = join(artifact, files.at(-1)!.path)
    await writeFile(helper, Buffer.alloc(files.at(-1)!.bytes, 0))
    expect(await run()).toMatchObject({
      captured: false,
      code: 'cursor_artifact_hash',
    })
    await rm(join(artifact, 'node_modules/@cursor/sdk/package.json'))
    expect(await run()).toMatchObject({ captured: false, code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
