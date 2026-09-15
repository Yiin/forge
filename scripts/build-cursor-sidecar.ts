import { createHash } from 'node:crypto'
import {
  cp,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = resolve(
  process.argv[2] ?? join(root, 'apps/server/src/cursor-sidecar'),
)
await mkdir(target, { recursive: true })
const packages = new Map<
  string,
  { name: string; version: string; path: string }
>()
const copied = new Map<string, string>()
async function stage(
  name: string,
  from: string,
  destination: string,
): Promise<void> {
  const require = createRequire(join(from, 'package.json'))
  let source: string
  try {
    source = dirname(require.resolve(`${name}/package.json`))
  } catch {
    source = dirname(require.resolve(name))
    while (
      JSON.parse(
        await readFile(join(source, 'package.json'), 'utf8').catch(
          () => '{"name":""}',
        ),
      ).name !== name
    ) {
      const parent = dirname(source)
      if (parent === source)
        throw new Error('Cursor dependency resolution failed')
      source = parent
    }
  }
  source = await realpath(source)
  const metadata = JSON.parse(
    await readFile(join(source, 'package.json'), 'utf8'),
  )
  const key = `${metadata.name}@${metadata.version}`
  const existing = copied.get(key)
  if (existing) return
  const output = join(destination, 'node_modules', name)
  copied.set(key, output)
  await cp(source, output, {
    recursive: true,
    dereference: true,
    filter: (path) =>
      !relative(source, path).split('/').includes('node_modules'),
  })
  packages.set(key, {
    name: metadata.name,
    version: metadata.version,
    path: relative(target, output),
  })
  for (const dependency of Object.keys({
    ...metadata.dependencies,
    ...metadata.peerDependencies,
  })) {
    if (metadata.peerDependenciesMeta?.[dependency]?.optional) continue
    await stage(dependency, source, target)
  }
}
await stage('@cursor/sdk', join(root, 'apps/server'), target)
await stage('@cursor/sdk-linux-x64', join(root, 'apps/server'), target)
for (const entry of ['sidecar', 'probe', 'guardian', 'sidecar-runtime']) {
  const result = await Bun.build({
    entrypoints: [join(root, `apps/server/src/harnesses/cursor/${entry}.ts`)],
    target: 'node',
    format: 'esm',
    external: ['@cursor/sdk', './sidecar-runtime.mjs', './probe.mjs'],
    naming: `${entry}.mjs`,
    outdir: target,
  })
  if (!result.success) throw new Error(result.logs.map(String).join('\n'))
}
for (const name of ['NOTICE.md', 'COMET-LICENSE'])
  await cp(
    join(root, 'apps/server/src/harnesses/cursor', name),
    join(target, name),
  )
const files: Array<{
  path: string
  bytes: number
  mode: number
  sha256: string
}> = []
async function inventory(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink())
      throw new Error('Staging must contain no symlinks')
    if (entry.isDirectory()) await inventory(path)
    else if (entry.isFile() && path !== join(target, 'manifest.json')) {
      const info = await stat(path)
      files.push({
        path: relative(target, path),
        bytes: info.size,
        mode: info.mode & 0o777,
        sha256: createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      })
    }
  }
}
await inventory(target)
await writeFile(
  join(target, 'manifest.json'),
  JSON.stringify(
    {
      version: 1,
      sdkVersion: '1.0.28',
      packages: [...packages.values()],
      files,
    },
    null,
    2,
  ) + '\n',
)
console.log(
  JSON.stringify({
    target,
    packages: [...packages.values()],
    files: files.length,
  }),
)
