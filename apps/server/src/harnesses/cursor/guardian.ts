import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { cursorTransport, type CursorFrame } from './wire.js'
import {
  CursorError,
  CursorResources,
  cursorLimits,
  invariant,
  plainCopy,
} from './limits.js'
import { inventoryTransaction, writeInventoryMarker } from './inventory.js'
import { bootstrapEnvironment, managerUnsetKeys } from './launch.js'
import {
  bindContainer,
  managerCall,
  retireContainer,
  processIdentity,
  type ContainerIdentity,
} from './container.js'
import { boundedRead, writeMarker } from './store.js'

const generation = process.argv[2]
const limits = { ...cursorLimits() }
let child: ChildProcessWithoutNullStreams | undefined
let peer: ReturnType<typeof cursorTransport> | undefined
let identity: ContainerIdentity | undefined
let fence: string | undefined
let stateRoot: string | undefined
const resources = new CursorResources()
let starting = false,
  bound = false,
  retiring = false,
  forwarding = 0
let childClosed: Promise<void> | undefined
let bootstrap: (frame: CursorFrame) => void = () => {}
const transport = cursorTransport(
  process.stdout,
  process.stdin,
  generation,
  limits,
  (frame) => {
    if (frame.type === 'initialize') {
      invariant(!starting, 'cursor_guardian_duplicate')
      starting = true
      void initialize(frame).catch(() =>
        fail(frame, 'cursor_container_unavailable'),
      )
      return
    }
    if (frame.type === 'retire') {
      invariant(!retiring, 'cursor_guardian_retiring')
      retiring = true
      void retire(frame).catch((error) =>
        fail(
          frame,
          error instanceof CursorError
            ? error.code
            : typeof error?.code === 'string' && /^E[A-Z]+$/.test(error.code)
              ? `cursor_cleanup_${error.code}`
              : 'cursor_cleanup_failed',
        ),
      )
      return
    }
    if (frame.type === 'container_bound') {
      invariant(
        identity && frame.nonce === identity.nonce && !bound,
        'cursor_guardian_nonce',
      )
      bound = true
    }
    invariant(peer && bound, 'cursor_guardian_not_bound')
    void peer
      .send(frame)
      .catch(() => fail(frame, 'cursor_guardian_pipe_failed'))
  },
)
function fail(frame: CursorFrame, code: string) {
  void transport
    .send({
      v: 1,
      generation,
      type: 'failure',
      requestId: frame.requestId,
      code,
    })
    .catch(() => {})
}
async function initialize(frame: CursorFrame) {
  Object.assign(limits, cursorLimits(frame.limits as Partial<typeof limits>))
  identity = plainCopy(frame.identity, limits.markerBytes) as ContainerIdentity
  invariant(
    identity.generation === generation &&
      identity.boot ===
        (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
    'cursor_guardian_identity',
  )
  fence = String(frame.fence)
  const reserved = JSON.parse(
    (await boundedRead(fence, limits.markerBytes, true)).toString('utf8'),
  )
  invariant(
    JSON.stringify(reserved.identity) === JSON.stringify(identity),
    'cursor_guardian_fence',
  )
  const environmentText = await managerCall(['show-environment'], limits)
  const keys = environmentText
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(0, line.indexOf('=')))
  const unset = managerUnsetKeys(keys, frame.removed as string[], limits)
  const node = String(frame.node),
    entry = String(frame.entry),
    cwd = String(frame.cwd)
  invariant(
    node === process.execPath && entry.endsWith('/cursor-sidecar/sidecar.mjs'),
    'cursor_guardian_entry',
  )
  const args = frame.args as string[]
  invariant(
    Array.isArray(args) &&
      args.length === 1 &&
      /^--max-old-space-size=\d+$/.test(args[0]),
    'cursor_guardian_args',
  )
  const probe = frame.probeData
  invariant(
    probe === undefined ||
      (typeof probe === 'string' &&
        /^\/tmp\/forge-cursor-container-[^/]+$/.test(probe)),
    'cursor_probe_path',
  )
  if (!probe) {
    invariant(
      typeof frame.stateRoot === 'string' &&
        fence.startsWith(`${frame.stateRoot}/`),
      'cursor_guardian_state_root',
    )
    stateRoot = frame.stateRoot
  }
  const serviceArgs = [
    '--user',
    `--unit=${identity.unit}`,
    '--quiet',
    '--collect',
    '--pipe',
    '--wait',
    '--service-type=exec',
    '--property=KillMode=control-group',
    '--property=SendSIGKILL=yes',
    '--property=ExitType=main',
    '--property=Restart=no',
    `--property=TimeoutStopSec=${limits.cancellationMs}ms`,
    `--property=RuntimeMaxSec=${limits.runtimeMs}ms`,
    `--property=TasksMax=${limits.tasks}`,
    `--property=UnsetEnvironment=${unset.join(' ')}`,
    '--',
    node,
    ...args,
    entry,
    probe ? '--managed-probe' : '--managed',
    generation,
    identity.nonce,
    ...(probe ? [String(probe)] : []),
  ]
  let rejectReady!: (error: Error) => void
  const ready = new Promise<CursorFrame>((resolve, reject) => {
    bootstrap = resolve
    rejectReady = reject
  })
  child = spawn('/usr/bin/systemd-run', serviceArgs, {
    cwd,
    env: bootstrapEnvironment(),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  childClosed = new Promise((resolve) => child!.once('close', () => resolve()))
  child.once('error', () =>
    rejectReady(new CursorError('cursor_guardian_spawn_failed')),
  )
  void childClosed.then(() =>
    rejectReady(new CursorError('cursor_guardian_early_close')),
  )
  let stderrBytes = 0
  child.stderr.on('data', (chunk) => {
    stderrBytes += chunk.length
    if (stderrBytes > limits.stderrBytes) void retire(frame).catch(() => {})
  })
  peer = cursorTransport(
    child.stdin,
    child.stdout,
    generation,
    limits,
    (value) => {
      if (value.type === 'bootstrap_wait') bootstrap(value)
      else {
        invariant(bound, 'cursor_guardian_early_frame')
        // Keep the service pipe blocked until the parent write physically ends.
        // Several small frames can share the current chunk, so join them all.
        child!.stdout.pause()
        forwarding++
        void transport
          .send(value)
          .catch(() => {
            if (!retiring) {
              retiring = true
              void retire(value).catch(() => {})
            }
          })
          .finally(() => {
            if (--forwarding === 0 && !retiring) child!.stdout.resume()
          })
      }
    },
  )
  const timer = setTimeout(
    () => rejectReady(new CursorError('cursor_guardian_startup_timeout')),
    limits.startupMs,
  )
  try {
    const waiting = await ready
    invariant(waiting.nonce === identity.nonce, 'cursor_guardian_nonce')
    identity = await bindContainer(identity, node, Number(waiting.pid), limits)
    identity.client = await processIdentity(child!.pid!)
    await persistFence(fence, { ...reserved, identity })
    await transport.send({
      v: 1,
      generation,
      type: 'container_created',
      requestId: frame.requestId,
      identity,
    })
  } finally {
    clearTimeout(timer)
  }
}
async function retire(frame: CursorFrame) {
  invariant(identity && fence && childClosed, 'cursor_cleanup_failed')
  const proof = await retireContainer(identity, limits)
  await childClosed
  invariant(
    child!.stdout.destroyed && child!.stderr.destroyed,
    'cursor_cleanup_pipes',
  )
  await persistFence(`${fence}.retired`, { identity, proof, pipesClosed: true })
  await transport.send({
    v: 1,
    generation,
    type: 'retired',
    requestId: frame.requestId,
    identity,
    proof,
    pipesClosed: true,
  })
}
async function persistFence(path: string, value: unknown) {
  if (!stateRoot) return writeMarker(path, value, limits)
  return inventoryTransaction(resources, stateRoot, limits, (inventory) =>
    writeInventoryMarker(path, value, inventory, limits),
  )
}
// Parent loss leaves the durable fence. It does not imply service death.
void transport.done.then(() => {
  process.exitCode = 1
})
