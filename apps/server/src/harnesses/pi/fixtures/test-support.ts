import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  chmod,
  rm,
  rename,
  appendFile,
} from 'node:fs/promises'
import { watch } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createPiAdapter,
  type PiAdapterOptions,
  type PiHandle,
  type PiNativeRecord,
  type PiHistoryPage,
  type PiPersistenceOwner,
} from '../index.js'
import type { HarnessEvent, HarnessSession } from '../../types.js'
import { deferred, physicalState } from '../wire.js'
import { imageHash } from '../input.js'

export type PeerConfig = {
  behavior?: string
  pauseInput?: boolean
  lateAck?: boolean
  hold?: string[]
  reject?: string[]
  startupDialog?: boolean
  startupEffect?: boolean
  startupRaw?: string
  startupExit?: number
  startupHang?: boolean
  emptyModels?: boolean
  noModel?: boolean
  changeIdentity?: boolean
  clamp?: boolean
  envKeys?: string[]
  splitAt?: number
  crlf?: boolean
  descendant?: boolean
  ignoreTerm?: boolean
  resumeRace?: 'remove' | 'empty' | 'replace' | 'append'
}
export const usage = {
  input: 1,
  output: 2,
  totalTokens: 3,
  cacheRead: 0,
  cacheWrite: 0,
}
export const assistant = (
  content: unknown[] = [{ type: 'text', text: 'done' }],
  stopReason = 'stop',
) => ({
  role: 'assistant',
  content,
  api: 'fake-api',
  provider: 'fake',
  model: 'model/one',
  timestamp: 1,
  usage,
  stopReason,
})
export const user = (text = 'hello') => ({
  role: 'user',
  content: text,
  timestamp: 0,
})
export async function fixture(config: PeerConfig = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'forge-pi-test-'))
  const home = join(directory, 'account')
  const cwd = join(directory, 'workspace')
  const packageRoot = join(directory, 'package')
  const executable = join(packageRoot, 'dist', 'pi.mjs')
  await Promise.all([
    mkdir(join(home, 'sessions'), { recursive: true }),
    mkdir(cwd),
    mkdir(join(packageRoot, 'dist'), { recursive: true }),
    mkdir(join(directory, 'control')),
  ])
  await writeFile(
    join(packageRoot, 'package.json'),
    JSON.stringify({
      name: '@earendil-works/pi-coding-agent',
      version: '0.84.0',
    }),
  )
  await writeFile(
    executable,
    await readFile(
      fileURLToPath(
        new URL('../../fixtures/pi-rpc-child.mjs', import.meta.url),
      ),
    ),
  )
  await chmod(executable, 0o755)
  await writeFile(join(directory, 'fixture.json'), JSON.stringify(config))
  const records: PiNativeRecord[] = []
  const events: HarnessEvent[] = []
  const pages: PiHistoryPage[] = []
  const images: Array<{ owner: PiPersistenceOwner; size: number }> = []
  const notifications = new Set<() => void>()
  const changed = () => {
    for (const notify of notifications) notify()
  }
  const fileWatcher = watch(directory, changed)
  const handles = new Set<PiHandle>()
  const session: HarnessSession = {
    id: 'forge-session',
    provider: 'pi',
    accountId: 'pi-account',
    cwd,
  }
  const args = ['--fixture-dir', directory]
  const options: PiAdapterOptions = {
    providerId: 'pi',
    executable,
    args,
    env: {},
    launch: {
      credentials: 'native-configured-sources',
      providerId: 'pi',
      canonicalCwd: cwd,
      accountHome: home,
      account: {
        id: 'pi-account',
        kind: 'pi',
        harnessKey: 'pi',
        adapterKind: 'native',
        disabledAt: null,
        homePath: home,
        config: null,
      },
      harness: {
        name: 'Pi fixture',
        command: executable,
        args,
        env: {},
        enabled: true,
        adapterKind: 'native',
        protocol: 'acp',
      },
      selectedEnvOverrides: {},
    },
    loadImage: async () => {
      throw new Error('Unexpected image loader')
    },
    persistImage: async (owner, image) => {
      images.push({ owner, size: image.bytes.length })
      changed()
      return {
        type: 'image',
        attachmentId: `image-${images.length}`,
        mimeType: image.mimeType,
        sizeBytes: image.bytes.length,
        sha256: imageHash(image.bytes),
      }
    },
    persistRecord: async (_owner, _binding, record) => {
      records.push(record)
      changed()
    },
    persistSnapshot: async () => {},
    commitHistoryPage: async (_owner, _binding, { page }) => {
      pages.push(page)
      changed()
    },
  }
  let controlId = 0
  const wait = <T>(
    predicate: () => Promise<T | false> | T | false,
  ): Promise<T> =>
    new Promise((resolve, reject) => {
      let running = false
      let again = false
      let ended = false
      const cleanup = () => {
        ended = true
        clearTimeout(timer)
        notifications.delete(probe)
      }
      const probe = () => {
        if (ended) return
        if (running) {
          again = true
          return
        }
        running = true
        void Promise.resolve()
          .then(predicate)
          .then(
            (value) => {
              if (value !== false) {
                cleanup()
                resolve(value)
              }
            },
            (error) => {
              cleanup()
              reject(error)
            },
          )
          .finally(() => {
            running = false
            if (again) {
              again = false
              probe()
            }
          })
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('Fixture barrier timed out'))
      }, 5000)
      notifications.add(probe)
      probe()
    })
  const wire = async (): Promise<Array<Record<string, unknown>>> => {
    try {
      return (await readFile(join(directory, 'wire.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return []
      throw error
    }
  }
  const emit = (event: HarnessEvent) => {
    events.push(event)
    changed()
  }
  return {
    directory,
    home,
    cwd,
    executable,
    options,
    session,
    records,
    events,
    pages,
    images,
    emit,
    wait,
    wire,
    track(handle: PiHandle) {
      handles.add(handle)
      return handle
    },
    async start(overrides: Partial<PiAdapterOptions> = {}, load = false) {
      const adapter = createPiAdapter({ ...options, ...overrides })
      const handle = await (load
        ? adapter.load(session, emit)
        : adapter.spawn(session, emit))
      handles.add(handle)
      return { adapter, handle }
    },
    async control(input: Record<string, unknown>) {
      const observedEvents = events.length
      const name = `${String(++controlId).padStart(4, '0')}.json`
      const temporary = join(directory, 'control', `${name}.tmp`)
      await writeFile(temporary, JSON.stringify(input))
      await rename(temporary, join(directory, 'control', name))
      await wait(async () => {
        try {
          await readFile(join(directory, `processed-${name}`))
          return true
        } catch {
          // A fatal wire event can close the child before its file acknowledgement.
          return events
            .slice(observedEvents)
            .some(
              (event) =>
                event.type === 'turn_completed' &&
                event.outcome.status !== 'completed',
            )
        }
      })
    },
    async settle(stopReason = 'stop', content?: unknown[]) {
      await this.control({
        state: {
          isStreaming: false,
          isCompacting: false,
          pendingMessageCount: 0,
        },
        events: [
          { type: 'message_end', message: assistant(content, stopReason) },
          { type: 'agent_end', messages: [], willRetry: false },
          { type: 'agent_settled' },
        ],
      })
    },
    async started() {
      return wait(async () => {
        try {
          return JSON.parse(
            await readFile(join(directory, 'started.json'), 'utf8'),
          ) as {
            pid: number
            args: string[]
            env: Record<string, string | null>
          }
        } catch {
          return false
        }
      })
    },
    async close() {
      let pid: number | undefined
      try {
        pid = JSON.parse(
          await readFile(join(directory, 'started.json'), 'utf8'),
        ).pid
      } catch {}
      for (const handle of handles) await handle.kill()
      fileWatcher.close()
      if (pid !== undefined) {
        try {
          const state = await readFile(`/proc/${pid}/stat`, 'utf8')
          if (state.slice(state.lastIndexOf(')') + 2).split(' ')[0] !== 'Z')
            throw new Error('Owned Pi child remains alive')
        } catch (error) {
          if ((error as { code?: string }).code !== 'ENOENT') throw error
        }
      }
      await rm(directory, { recursive: true, force: true })
      if (process.env.FORGE_PI_TEST_RESOURCE_RECEIPT)
        await appendFile(
          process.env.FORGE_PI_TEST_RESOURCE_RECEIPT,
          JSON.stringify({
            directory,
            pid,
            childStopped: true,
            directoryRemoved: true,
            pendingWaiters: notifications.size,
          }) + '\n',
        )
    },
  }
}
export const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])
export function imageLoader(data: Uint8Array = png) {
  return async () => ({
    mime: 'image/png' as const,
    sizeBytes: data.byteLength,
    sha256: imageHash(data),
    readBytes: async () => data,
  })
}
export function latch() {
  return deferred<void>()
}
export async function pending(promise: Promise<unknown>) {
  const sentinel = Symbol('pending')
  return (await Promise.race([promise, Promise.resolve(sentinel)])) === sentinel
}
export function waitPhysicalIdle(): Promise<void> {
  return new Promise((resolve, reject) => {
    let turn: ReturnType<typeof setImmediate>
    const timer = setTimeout(() => {
      clearImmediate(turn)
      reject(new Error('Owned Pi resources did not close'))
    }, 5000)
    const inspect = () => {
      if (physicalState().count === 0) {
        clearTimeout(timer)
        if (process.env.FORGE_PI_TEST_RESOURCE_RECEIPT)
          void appendFile(
            process.env.FORGE_PI_TEST_RESOURCE_RECEIPT,
            JSON.stringify({ physical: physicalState() }) + '\n',
          ).then(resolve, reject)
        else resolve()
      } else turn = setImmediate(inspect)
    }
    inspect()
  })
}
