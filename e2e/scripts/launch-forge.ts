import { fileURLToPath } from 'node:url'
import { launchForge } from '../helpers/forgeServer.js'

const forge = await launchForge({
  frontendOrigin: null,
  env: {
    FORGE_WEB_DIR: fileURLToPath(
      new URL('../../apps/web/dist', import.meta.url),
    ),
  },
})
console.log(`FORGE_URL=${forge.baseUrl} FORGE_DATA_DIR=${forge.dataDir}`)

let stopping = false
const stop = async () => {
  if (stopping) return
  stopping = true
  await forge.stop()
}
process.once('SIGINT', () => void stop().finally(() => process.exit(0)))
process.once('SIGTERM', () => void stop().finally(() => process.exit(0)))
await new Promise<void>(() => undefined)
