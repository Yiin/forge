import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { boundedEntries } from './scan.js'
import { boundedRead, writeMarker } from './store.js'
import {
  invariant,
  validateServiceGrant,
  serviceGrant,
  CURSOR_LIMITS,
  type CursorServiceGrant,
  type CursorLimits,
  type CursorResources,
} from './limits.js'

type Inventory = {
  reservations: number
  indexes: number
  bytes: number
  dirty: Map<string, CursorServiceGrant>
  temporary: Map<string, number>
}
const locks = new WeakMap<
  CursorResources,
  Map<string, { chain: Promise<unknown>; pending: number }>
>()
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/

export async function inspectInventory(
  root: string,
  limits: CursorLimits,
): Promise<Inventory> {
  invariant((await realpath(root)) === root, 'cursor_inventory_path')
  const result: Inventory = {
    reservations: 0,
    indexes: 0,
    bytes: 0,
    dirty: new Map(),
    temporary: new Map(),
  }
  result.bytes = await boundedRead(
    join(root, 'inventory.lock'),
    limits.markerBytes,
    true,
  ).then(
    (bytes) => bytes.length,
    (error) => {
      if (error.code === 'ENOENT') return 0
      throw error
    },
  )
  invariant(result.bytes <= limits.inventoryBytes, 'cursor_inventory_bytes')
  const directories = await boundedEntries(
    join(root, 'sessions'),
    limits.reservations,
  ).catch((error) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  for (const entry of directories) {
    invariant(
      entry.isDirectory() && uuid.test(entry.name),
      'cursor_inventory_entry',
    )
    const directory = join(root, 'sessions', entry.name)
    invariant(
      (await realpath(directory)) === directory,
      'cursor_inventory_path',
    )
    result.reservations++
    const files = await boundedEntries(directory, 16)
    let manifest = false,
      temporary = 0
    for (const file of files) {
      const path = join(directory, file.name)
      if (['sdk', 'native-data'].includes(file.name)) {
        invariant(file.isDirectory(), 'cursor_inventory_entry')
        continue
      }
      invariant(
        file.isFile() &&
          (/^(manifest\.json|writer-fence\.json(?:\.retired)?)$/.test(
            file.name,
          ) ||
            file.name.endsWith('.tmp')),
        'cursor_inventory_entry',
      )
      const bytes = await boundedRead(path, limits.markerBytes, true)
      result.bytes += bytes.length
      if (file.name === 'manifest.json') manifest = true
      if (file.name === 'writer-fence.json')
        result.dirty.set(
          path,
          validateServiceGrant(
            JSON.parse(bytes.toString('utf8')).identity?.grant,
          ),
        )
      if (file.name.endsWith('.tmp')) temporary += bytes.length
      result.temporary.set(directory, temporary)
      invariant(
        temporary <= limits.markerTemporaryBytes &&
          result.bytes <= limits.inventoryBytes,
        'cursor_inventory_bytes',
      )
    }
    // Partial directory creation still occupies a reservation and a dirty slot.
    // A partial directory lacks a provable grant. Quarantine the full supported
    // capacity until recovery proves retirement; this is not an observed grant.
    if (!manifest && !result.dirty.has(join(directory, 'writer-fence.json')))
      result.dirty.set(
        join(directory, 'writer-fence.json'),
        serviceGrant(CURSOR_LIMITS),
      )
  }
  const indexes = await boundedEntries(
    join(root, 'by-agent'),
    limits.indexes,
  ).catch((error) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  for (const entry of indexes) {
    invariant(
      entry.isFile() &&
        /^[a-f0-9]{64}\.json(?:\.[a-f0-9-]+\.tmp)?$/.test(entry.name),
      'cursor_inventory_index',
    )
    const bytes = await boundedRead(
      join(root, 'by-agent', entry.name),
      limits.markerBytes,
      true,
    )
    result.indexes++
    result.bytes += bytes.length
    if (entry.name.endsWith('.tmp')) {
      const directory = join(root, 'by-agent')
      const temporary = (result.temporary.get(directory) ?? 0) + bytes.length
      invariant(
        temporary <= limits.markerTemporaryBytes,
        'cursor_inventory_bytes',
      )
      result.temporary.set(directory, temporary)
    }
    invariant(result.bytes <= limits.inventoryBytes, 'cursor_inventory_bytes')
  }
  const helpers = await boundedEntries(
    join(root, 'helpers'),
    limits.containers,
  ).catch((error) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  for (const entry of helpers) {
    invariant(
      entry.isDirectory() && uuid.test(entry.name),
      'cursor_inventory_helper',
    )
    const directory = join(root, 'helpers', entry.name)
    invariant(
      (await realpath(directory)) === directory,
      'cursor_inventory_path',
    )
    const entries = await boundedEntries(directory, 8)
    let fence: CursorServiceGrant | undefined,
      manifest = false,
      temporary = 0
    for (const entry of entries)
      if (entry.isFile()) {
        invariant(
          /^(manifest\.json|writer-fence\.json(?:\.retired)?)$/.test(
            entry.name,
          ) || entry.name.endsWith('.tmp'),
          'cursor_inventory_helper',
        )
        const bytes = await boundedRead(
          join(directory, entry.name),
          limits.markerBytes,
          true,
        )
        result.bytes += bytes.length
        invariant(
          result.bytes <= limits.inventoryBytes,
          'cursor_inventory_bytes',
        )
        if (entry.name === 'writer-fence.json')
          fence = validateServiceGrant(
            JSON.parse(bytes.toString('utf8')).identity?.grant,
          )
        if (entry.name === 'manifest.json') manifest = true
        if (entry.name.endsWith('.tmp')) temporary += bytes.length
        result.temporary.set(directory, temporary)
        invariant(
          temporary <= limits.markerTemporaryBytes,
          'cursor_inventory_bytes',
        )
      } else
        invariant(
          entry.isDirectory() && ['sdk', 'native-data'].includes(entry.name),
          'cursor_inventory_helper',
        )
    if (fence || !manifest)
      result.dirty.set(
        join(directory, 'writer-fence.json'),
        fence ?? serviceGrant(CURSOR_LIMITS),
      )
  }
  return result
}

export function inventoryTransaction<T>(
  resources: CursorResources,
  root: string,
  limits: CursorLimits,
  operation: (inventory: Inventory) => Promise<T>,
): Promise<T> {
  let roots = locks.get(resources)
  if (!roots) {
    roots = new Map()
    locks.set(resources, roots)
  }
  let state = roots.get(root)
  if (!state) {
    state = { chain: Promise.resolve(), pending: 0 }
    roots.set(root, state)
  }
  invariant(state.pending < limits.waiting, 'cursor_inventory_queue_limit')
  state.pending++
  const work = state.chain.then(async () => {
    const path = join(root, 'inventory.lock'),
      nonce = randomUUID()
    await writeMarker(path, { version: 1, nonce }, limits, true)
    try {
      const inventory = await inspectInventory(root, limits)
      resources.reconcileDirty(inventory.dirty)
      return await operation(inventory)
    } finally {
      const lock = JSON.parse(
        (await boundedRead(path, limits.markerBytes, true)).toString('utf8'),
      )
      invariant(lock.nonce === nonce, 'cursor_inventory_lock_changed')
      await unlink(path)
      const folder = await open(root, 'r')
      try {
        await folder.sync()
      } finally {
        await folder.close()
      }
    }
  })
  state.chain = work.catch(() => {})
  return work.finally(() => {
    state!.pending--
  })
}

export async function writeInventoryMarker(
  path: string,
  value: unknown,
  inventory: Inventory,
  limits: CursorLimits,
  exclusive = false,
) {
  const size = Buffer.byteLength(JSON.stringify(value)) + 1
  const previous = await lstat(path).then(
    (row) => row.size,
    (error) => {
      if (error.code === 'ENOENT') return 0
      throw error
    },
  )
  invariant(
    inventory.bytes + size <= limits.inventoryBytes &&
      (inventory.temporary.get(dirname(path)) ?? 0) + size <=
        limits.markerTemporaryBytes,
    'cursor_inventory_bytes',
  )
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 })
  await writeMarker(path, value, limits, exclusive)
  inventory.bytes += size - previous
}
