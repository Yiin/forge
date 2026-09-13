// Owned test descendant. It stays in its parent's process group and ignores graceful shutdown.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
let count = 0
const write = async () =>
  writeFile(join(process.env.KIMI_CODE_HOME, 'fixture-writer'), String(++count))
await write()
process.on('SIGTERM', () => {})
process.on('disconnect', () => {})
setInterval(() => {
  void write()
}, 10)
process.send?.({ ready: true })
