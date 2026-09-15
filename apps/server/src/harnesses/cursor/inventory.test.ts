import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  symlink,
  readFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cursorLimits,
  CursorResources,
  plainCopy,
  jsonStringBytes,
  serviceGrant,
} from './limits.js'
import {
  inspectInventory,
  inventoryTransaction,
  writeInventoryMarker,
} from './inventory.js'
import { scanNativeData, CursorScanner } from './scan.js'
import { CursorStore, writeMarker } from './store.js'
import { CursorFixtureStore } from '../../../test/fixtures/cursor-store.js'
import { CursorContainer } from './container.js'
import type { CursorLaunch } from './launch.js'
import { NativeProcess } from '../process.js'
import { deferred } from '../transport-test-helpers.js'
const roots: string[] = []
async function root() {
  const path = await mkdtemp(join(tmpdir(), 'forge-cursor-inventory-'))
  roots.push(path)
  return path
}
afterEach(async () => {
  for (const path of roots.splice(0))
    await rm(path, { recursive: true, force: true })
})
describe('Cursor durable inventory and bounded native scans', () => {
  it('writes the complete 32 KiB marker including its newline and refuses the next byte before replacement', async () => {
    const path = await root(),
      limits = cursorLimits(),
      file = join(path, 'marker.json')
    const value = { value: 'x'.repeat(limits.markerBytes - 13) }
    await writeMarker(file, value, limits, true)
    expect((await readFile(file)).length).toBe(limits.markerBytes)
    await expect(
      writeMarker(file, { value: value.value + 'x' }, limits),
    ).rejects.toThrow('cursor_marker_limit')
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(value)
  })
  it('retains the 64 KiB temporary marker allowance before admitting another physical rewrite', async () => {
    const path = await root(),
      limits = cursorLimits(),
      resources = new CursorResources()
    const directory = join(path, 'sessions', randomUUID()),
      file = join(directory, 'manifest.json')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeMarker(file, {}, limits, true)
    const value = { value: 'x'.repeat(limits.markerBytes - 13) }
    const temporary = [
      join(directory, 'manifest.json.1.tmp'),
      join(directory, 'manifest.json.2.tmp'),
    ]
    for (const target of temporary)
      await writeMarker(target, value, limits, true)
    expect((await inspectInventory(path, limits)).bytes).toBe(
      limits.markerTemporaryBytes + 3,
    )
    await expect(
      inventoryTransaction(resources, path, limits, (inventory) =>
        writeInventoryMarker(file, { updated: true }, inventory, limits),
      ),
    ).rejects.toThrow('cursor_inventory_bytes')
    expect(await readFile(file, 'utf8')).toBe('{}\n')
    await rm(temporary[0])
    await inventoryTransaction(resources, path, limits, (inventory) =>
      writeInventoryMarker(file, value, inventory, limits),
    )
    expect((await readFile(file)).length).toBe(limits.markerBytes)
    await writeFile(join(directory, 'manifest.json.3.tmp'), 'x', {
      mode: 0o600,
    })
    await writeMarker(temporary[0], value, limits, true)
    await expect(inspectInventory(path, limits)).rejects.toThrow(
      'cursor_inventory_bytes',
    )
  })
  it('rejects replacement before spawn while four original store writes remain physically held across pool replacement', async () => {
    const path = await root(),
      limits = cursorLimits(),
      parent = new CursorResources(),
      replacement = new CursorResources()
    const gates = Array.from({ length: 4 }, () => deferred<void>()),
      entered = Array.from({ length: 4 }, () => deferred<void>())
    const operations: Promise<unknown>[] = [],
      stores: CursorStore[] = [],
      fences: string[] = [],
      releases: Array<() => void> = []
    const spawn = vi.spyOn(NativeProcess, 'start')
    try {
      for (let index = 0; index < 4; index++) {
        const directory = join(path, 'sessions', randomUUID()),
          sdk = join(directory, 'sdk'),
          fence = join(directory, 'writer-fence.json')
        await mkdir(sdk, { recursive: true, mode: 0o700 })
        await writeFile(join(directory, 'manifest.json'), '{}', { mode: 0o600 })
        await writeFile(
          fence,
          JSON.stringify({ identity: { grant: serviceGrant(limits) } }),
          { mode: 0o600 },
        )
        fences.push(fence)
        releases.push(parent.reserveContainer(fence, limits))
        const backing = new CursorFixtureStore(sdk),
          create = backing.agents.create.bind(backing.agents)
        backing.agents.create = async (input) => {
          entered[index].resolve()
          await gates[index].promise
          return create(input)
        }
        const store = new CursorStore(
          sdk,
          path,
          backing,
          new CursorResources(),
          limits,
          true,
        )
        stores.push(store)
        store.beginAttempt(`attempt-${index}`)
        operations.push(
          store.agents.create({
            agent: {
              agentId: `agent-${index}`,
              cwd: path,
              createdAt: 1,
              updatedAt: 1,
              status: 'idle',
              activeRunId: null,
            },
          }),
        )
      }
      await Promise.all(entered.map((value) => value.promise))
      await inventoryTransaction(replacement, path, limits, async () => {})
      expect(replacement.snapshot()).toMatchObject({
        containers: 4,
        storeOperations: 128,
        storeInputBytes: 64 * 1024 * 1024,
        scans: 4,
      })
      const owner = {
        forgeSessionId: 'fifth',
        provider: 'cursor',
        accountId: 'account',
        cwd: path,
        storeId: randomUUID(),
        generation: randomUUID(),
        attemptId: 'attempt',
        runId: 'run',
        turnId: 'turn',
      }
      const container = new CursorContainer(
        { stateRoot: path } as CursorLaunch,
        owner,
        join(path, 'sessions', owner.storeId, 'sdk'),
        replacement,
        limits,
        () => {},
      )
      await expect(container.start()).rejects.toThrow('cursor_resource_limit')
      expect(spawn).not.toHaveBeenCalled()
      expect(replacement.snapshot().storeOperations).toBe(128)
    } finally {
      gates.forEach((gate) => gate.resolve())
      await Promise.all(operations)
      for (const store of stores) await store.drain(true)
      releases.forEach((release) => release())
      fences.forEach((fence) => replacement.releaseContainer(fence))
      spawn.mockRestore()
    }
  })
  it('restores all original dirty service grants before any replacement admission', async () => {
    const path = await root(),
      original = new CursorResources(),
      replacement = new CursorResources(),
      limits = cursorLimits()
    const fences: string[] = [],
      releases: Array<() => void> = []
    for (let index = 0; index < 4; index++) {
      const directory = join(path, 'sessions', randomUUID()),
        fence = join(directory, 'writer-fence.json')
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await writeFile(join(directory, 'manifest.json'), '{}', { mode: 0o600 })
      await writeFile(
        fence,
        JSON.stringify({ identity: { grant: serviceGrant(limits) } }),
        { mode: 0o600 },
      )
      fences.push(fence)
      releases.push(original.reserveContainer(fence, limits))
    }
    try {
      await inventoryTransaction(replacement, path, limits, async () => {})
      expect(replacement.snapshot()).toMatchObject({
        containers: 4,
        storeOperations: 128,
        storeInputBytes: 64 * 1024 * 1024,
        scans: 4,
      })
      expect(() =>
        replacement.reserveContainer('fifth-service', limits),
      ).toThrow('cursor_resource_limit')
      expect(replacement.snapshot()).toMatchObject({
        containers: 4,
        storeOperations: 128,
        storeInputBytes: 64 * 1024 * 1024,
        scans: 4,
      })
      await inventoryTransaction(replacement, path, limits, async () => {})
      expect(replacement.snapshot().storeOperations).toBe(128)
      await rm(fences[0], { force: true })
      await inventoryTransaction(replacement, path, limits, async () => {})
      expect(replacement.snapshot().storeOperations).toBe(128)
      expect(() =>
        replacement.reserveContainer('still-unproved', limits),
      ).toThrow('cursor_resource_limit')
    } finally {
      releases.forEach((release) => release())
      fences.forEach((fence) => replacement.releaseContainer(fence))
    }
  })
  it('charges dirty and partial reservations after a resource-pool restart', async () => {
    const path = await root(),
      directory = join(path, 'sessions', randomUUID())
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const limits = cursorLimits({ containers: 1 }),
      resources = new CursorResources()
    await inventoryTransaction(resources, path, limits, async (inventory) => {
      expect(inventory.reservations).toBe(1)
      expect(inventory.dirty.size).toBe(1)
      expect(() => resources.reserveContainer('other', limits)).toThrow(
        'resource_limit',
      )
    })
    expect(resources.snapshot().containers).toBe(1)
    await inventoryTransaction(resources, path, limits, async () => {})
    expect(resources.snapshot().containers).toBe(1)
    await rm(directory, { recursive: true, force: true })
    await inventoryTransaction(resources, path, limits, async () => {})
    expect(resources.snapshot().containers).toBe(1)
  })
  it('serializes inventory writes and never steals an existing lock', async () => {
    const path = await root(),
      resources = new CursorResources(),
      limits = cursorLimits(),
      order: string[] = []
    await Promise.all([
      inventoryTransaction(resources, path, limits, async () => {
        order.push('first')
        await new Promise((resolve) => setTimeout(resolve, 15))
        order.push('first-end')
      }),
      inventoryTransaction(resources, path, limits, async () => {
        order.push('second')
      }),
    ])
    expect(order).toEqual(['first', 'first-end', 'second'])
    await writeFile(join(path, 'inventory.lock'), '{}', { mode: 0o600 })
    await expect(
      inventoryTransaction(resources, path, limits, async () => {}),
    ).rejects.toThrow()
    expect(await readFile(join(path, 'inventory.lock'), 'utf8')).toBe('{}')
  })
  it('reserves committed plus temporary inventory bytes before replacement', async () => {
    const path = await root(),
      indexes = join(path, 'by-agent')
    await mkdir(indexes, { mode: 0o700 })
    const file = join(indexes, `${'a'.repeat(64)}.json`)
    await writeFile(file, JSON.stringify({ value: 'a'.repeat(240) }), {
      mode: 0o600,
    })
    const limits = cursorLimits({ inventoryBytes: 500 }),
      resources = new CursorResources()
    await expect(
      inventoryTransaction(resources, path, limits, (inventory) =>
        writeInventoryMarker(
          file,
          { value: 'b'.repeat(280) },
          inventory,
          limits,
        ),
      ),
    ).rejects.toThrow('inventory_bytes')
    expect(JSON.parse(await readFile(file, 'utf8')).value).toBe('a'.repeat(240))
  })
  it('bounds retained reservation and index counts without dropping old entries', async () => {
    const path = await root()
    for (let index = 0; index < 2; index++)
      await mkdir(join(path, 'sessions', randomUUID()), { recursive: true })
    await expect(
      inspectInventory(path, cursorLimits({ reservations: 1 })),
    ).rejects.toThrow('directory_limit')
    const indexes = join(path, 'by-agent')
    await mkdir(indexes)
    await writeFile(join(indexes, `${'a'.repeat(64)}.json`), '{}', {
      mode: 0o600,
    })
    await writeFile(join(indexes, `${'b'.repeat(64)}.json`), '{}', {
      mode: 0o600,
    })
    await expect(
      inspectInventory(path, cursorLimits({ indexes: 1 })),
    ).rejects.toThrow('directory_limit')
  })
  it('fails native entry, depth, pending path, name-byte and file-byte ceilings', async () => {
    for (const [key, value] of [
      ['scanEntries', 1],
      ['scanPending', 1],
      ['scanPathBytes', 1],
      ['nativeBytes', 1],
      ['scanDepth', 1],
    ] as const) {
      const path = await root()
      await mkdir(join(path, 'one', 'nested'), { recursive: true })
      await mkdir(join(path, 'two'))
      await writeFile(join(path, 'file'), 'bytes')
      await expect(
        scanNativeData(path, cursorLimits({ [key]: value })),
      ).rejects.toThrow()
    }
  })
  it('rejects external links and coalesces concurrent scan requests', async () => {
    const path = await root(),
      external = await root()
    await writeFile(join(external, 'file'), 'private')
    await symlink(external, join(path, 'link'))
    await expect(scanNativeData(path, cursorLimits())).rejects.toThrow(
      'external_link',
    )
    await rm(join(path, 'link'))
    const resources = new CursorResources(),
      scanner = new CursorScanner(path, resources, cursorLimits())
    const first = scanner.request()
    expect(scanner.request()).toBe(first)
    await first
    await scanner.stop()
    expect(resources.snapshot().scans).toBe(0)
  })
  it('retains one observed failed scan Promise for later coalesced callback requests', async () => {
    const path = await root(),
      resources = new CursorResources(),
      scanner = new CursorScanner(path, resources, cursorLimits())
    const failure = new Error('held scan failed'),
      gate = deferred<void>(),
      entered = deferred<void>()
    const scan = resources.scan.bind(resources)
    vi.spyOn(resources, 'scan').mockImplementation((key, limits, operation) =>
      scan(key, limits, async () => {
        entered.resolve()
        await gate.promise
        await operation()
        throw failure
      }),
    )
    const first = scanner.request(),
      observed = first.catch((error) => error)
    await entered.promise
    for (let index = 0; index < 32; index++)
      expect(scanner.request()).toBe(first)
    expect(resources.snapshot().scans).toBe(1)
    gate.resolve()
    expect(await observed).toBe(failure)
    for (let index = 0; index < 32; index++)
      expect(scanner.request()).toBe(first)
    await expect(scanner.stop()).rejects.toBe(failure)
    expect(resources.snapshot().scans).toBe(0)
  })
  it('accounts for JSON escapes before copying strings', () => {
    for (const value of ['\u0000', '\n', '"\\', '\ud800', '😀'])
      expect(jsonStringBytes(value)).toBe(
        Buffer.byteLength(JSON.stringify(value)),
      )
    expect(() => plainCopy('\u0000'.repeat(10), 30)).toThrow('value_bytes')
  })
})
