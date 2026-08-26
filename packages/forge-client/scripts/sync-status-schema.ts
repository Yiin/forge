import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const root = resolve(import.meta.dir, '../../..')
const source = resolve(root, 'packages/protocol/src/status.ts')
const target = resolve(import.meta.dir, '../src/generated/status.ts')
await mkdir(dirname(target), { recursive: true })
const sourceText = await readFile(source, 'utf8')
const header =
  '// DO-NOT-EDIT: forge-client vendors this file with a schema-drift check.\n'
if (!sourceText.startsWith(header)) {
  throw new Error(`${source} must start with the generated-schema header`)
}
await copyFile(source, target)
