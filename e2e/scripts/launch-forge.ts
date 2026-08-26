import { launchForge } from '../helpers/forgeServer.js'

const forge = await launchForge()
console.log(`FORGE_URL=${forge.baseUrl}`)
console.log(`FORGE_DATA_DIR=${forge.dataDir}`)

let stopping = false
const stop = async () => {
  if (stopping) return
  stopping = true
  await forge.stop()
}
process.once('SIGINT', () => void stop().finally(() => process.exit(0)))
process.once('SIGTERM', () => void stop().finally(() => process.exit(0)))
await new Promise<void>(() => undefined)
