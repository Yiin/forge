import { resolve } from 'node:path'
const output = process.argv[2],
  shim = resolve('apps/server/test/fixtures/cursor-manager-process.ts')
if (!/^\/tmp\/forge-cursor-manager-[^/]+$/.test(output))
  throw new Error('Unowned output')
const guardian = await Bun.build({
  entrypoints: [resolve('apps/server/src/harnesses/cursor/guardian.ts')],
  outdir: output,
  naming: 'guardian.mjs',
  target: 'node',
  format: 'esm',
  plugins: [
    {
      name: 'isolated-manager',
      setup(builder) {
        builder.onResolve({ filter: /^node:child_process$/ }, (args) =>
          args.importer === shim
            ? { path: args.path, external: true }
            : { path: shim },
        )
      },
    },
  ],
})
const helper = await Bun.build({
  entrypoints: [resolve('apps/server/test/fixtures/cursor-manager-helper.ts')],
  outdir: output,
  naming: 'manager-helper.mjs',
  target: 'node',
  format: 'esm',
})
if (!guardian.success || !helper.success)
  throw new Error([...guardian.logs, ...helper.logs].map(String).join('\n'))
