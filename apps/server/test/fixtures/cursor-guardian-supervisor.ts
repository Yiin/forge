import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { NativeProcess } from '../../src/harnesses/process.js'
import { CursorWire } from '../../src/harnesses/cursor/wire.js'
import {
  cursorLimits,
  serviceGrant,
} from '../../src/harnesses/cursor/limits.js'
import { nativeBootstrapOverrides } from '../../src/harnesses/cursor/launch.js'
import {
  processIdentity,
  type ContainerIdentity,
} from '../../src/harnesses/cursor/container.js'
import { boundedRead, writeMarker } from '../../src/harnesses/cursor/store.js'
const [directory, artifact] = process.argv.slice(2),
  limits = cursorLimits()
const specification = JSON.parse(
  (
    await boundedRead(
      join(directory, 'supervisor-launch.json'),
      limits.markerBytes,
      true,
    )
  ).toString('utf8'),
)
const identity: ContainerIdentity = {
  unit: `forge-cursor-${randomUUID()}.service`,
  nonce: randomUUID(),
  generation: specification.owner.generation,
  leaseId: randomUUID(),
  grant: serviceGrant(limits),
  boot: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
  host: (await readFile('/etc/machine-id', 'utf8')).trim(),
  supervisor: await processIdentity(process.pid),
}
await writeMarker(
  specification.fence,
  { state: 'dirty', identity, owner: specification.owner },
  limits,
  true,
)
let wire!: CursorWire
const started = await NativeProcess.start(
  {
    command: process.execPath,
    args: [join(artifact, 'guardian.mjs'), identity.generation],
    cwd: directory,
    env: nativeBootstrapOverrides(process.env),
  },
  async (child) => {
    wire = new CursorWire(
      child.child.stdin,
      child.child.stdout,
      identity.generation,
      limits,
      () => {},
    )
    child.ownTransport(wire.transport)
    return wire.request('initialize', {
      identity,
      node: process.execPath,
      args: ['--max-old-space-size=512'],
      entry: join(artifact, 'sidecar.mjs'),
      cwd: directory,
      fence: specification.fence,
      removed: [],
      probeData: directory,
    })
  },
)
const bound = started.value.identity as ContainerIdentity
const ready = await wire.request('container_bound', {
  identity: bound,
  nonce: bound.nonce,
})
await writeMarker(
  join(directory, 'supervisor-ready.json'),
  { identity: bound, writer: await processIdentity(Number(ready.writerPid)) },
  limits,
  true,
)
setInterval(() => {}, 1000)
