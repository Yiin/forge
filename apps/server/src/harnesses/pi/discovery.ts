import { closeNativeDiscovery } from '../native-cleanup.js'
import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { JsonlTransport } from '../jsonl.js'
import { startNativeProcess } from '../process.js'
import {
  bytes,
  check,
  fail,
  freeze,
  limits,
  MiB,
  PiError,
  PiRouter,
  type PiResponse,
} from './wire.js'
import {
  captureLaunch,
  environmentAtLaunch,
  modelKey,
  verifyVersion,
  type PiCatalogSnapshot,
  type PiLaunchOptions,
  type PiStateSnapshot,
} from './session.js'
export type { PiLaunchOptions } from './session.js'
type Catalog = Pick<PiCatalogSnapshot, 'models' | 'thinkingLevels' | 'commands'>
export async function readPiCatalog(
  request: (
    command:
      'get_available_models' | 'get_available_thinking_levels' | 'get_commands',
  ) => Promise<PiResponse>,
): Promise<Catalog> {
  const models = (await request('get_available_models')).data as {
    models: NonNullable<PiStateSnapshot['model']>[]
  }
  const thinking = (await request('get_available_thinking_levels')).data as {
    levels: string[]
  }
  const commands = (await request('get_commands')).data as {
    commands: PiCatalogSnapshot['commands']
  }
  const catalog = freeze({
    models: models.models.map((model) => ({
      ...model,
      catalogId: modelKey(model.provider, model.id),
    })),
    thinkingLevels: thinking.levels,
    commands: commands.commands,
  })
  if (bytes(catalog.models) > 4 * MiB || bytes(catalog.commands) > 2 * MiB)
    fail('PI_CATALOG_LIMIT')
  return catalog
}
export async function discoverPi(
  input: PiLaunchOptions,
  { cwd: requestedCwd, signal }: { cwd: string; signal: AbortSignal },
): Promise<Catalog> {
  const launch = captureLaunch(input),
    config = limits()
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  const deadline = performance.now() + config.startupMs
  const timer = setTimeout(
    () => controller.abort(new PiError('PI_STARTUP_DEADLINE')),
    config.startupMs,
  )
  try {
    const cwd = await realpath(requestedCwd)
    if (cwd !== launch.launch.canonicalCwd || !(await stat(cwd)).isDirectory())
      fail('PI_ACCOUNT_LAUNCH_SCOPE_MISMATCH')
    await verifyVersion(launch.executable, controller.signal, config)
    check(controller.signal)
    const { process, value } = await startNativeProcess(
      {
        command: launch.executable,
        args: ['--mode', 'rpc', '--offline', '--no-session', ...launch.args],
        cwd,
        env: environmentAtLaunch(launch),
        inheritEnv: false,
        secrets: launch.secrets,
        signal: controller.signal,
        startupTimeoutMs: Math.max(1, Math.ceil(deadline - performance.now())),
        stderrLimit: 64 * 1024,
      },
      async (process) => {
        let router!: PiRouter
        let frames = 0
        const transport = new JsonlTransport({
          stdin: process.child.stdin,
          stdout: process.child.stdout,
          maxLineBytes: config.maxLineBytes,
          maxQueuedBytes: config.maxOutboundBytes,
          maxQueuedFrames: config.maxOutboundFrames,
          onValue(value) {
            if (++frames > 512) throw new PiError('PI_DISCOVERY_FRAME_LIMIT')
            if (
              value &&
              typeof value === 'object' &&
              (value as { type?: unknown }).type === 'response'
            )
              router.receive(value)
          },
        })
        router = new PiRouter(randomUUID(), transport, config, (error) =>
          transport.close(error),
        )
        process.ownTransport(transport)
        void transport.done.then((error) => router.close(error))
        return readPiCatalog(async (command) => {
          const response = await router.request(command)
          if (!response.success) fail('PI_NATIVE_COMMAND_REJECTED')
          return response
        })
      },
    )
    await closeNativeDiscovery(() => process.close())
    check(controller.signal)
    return value
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}
