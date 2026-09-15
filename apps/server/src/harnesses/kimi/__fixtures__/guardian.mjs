import { pathToFileURL } from 'node:url'

const [artifact, runtime, limits] = process.argv.slice(2)
const { runKimiGuardian } = await import(pathToFileURL(artifact).href)
await runKimiGuardian(runtime, JSON.parse(limits))
