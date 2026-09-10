import { watch, type FSWatcher } from 'node:fs'
import { lstat, opendir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type {
  WorkspaceChange,
  WorkspaceTarget,
} from '@forge/protocol/workspace'
import {
  descriptorPath,
  ownedTemporary,
  relativePath,
  WorkspaceError,
  WorkspacePath,
} from './paths.js'
import {
  publicWorkspace,
  type WorkspaceResolution,
  type WorkspaceObservations,
} from './target.js'
import type { WorkspaceFiles } from './files.js'
import { WORKSPACE_LIMITS } from './limits.js'

type DirectoryWatch = {
  watcher: FSWatcher
  identity: string
  children: Set<string>
}
type RootWatch = {
  workspace: WorkspaceResolution
  directories: Map<string, DirectoryWatch>
  subscribers: Set<Subscription>
  paths: Set<string>
  resync: boolean
  bytes: number
  mode: WorkspaceChange['mode']
  debounce?: ReturnType<typeof setTimeout>
  burst?: ReturnType<typeof setTimeout>
  repair: ReturnType<typeof setInterval>
  refresh?: Promise<void>
  refreshDebounce?: ReturnType<typeof setTimeout>
  refreshBurst?: ReturnType<typeof setTimeout>
  dirtyDirectories: Set<string>
  fullRefresh: boolean
  incompleteCoverage: boolean
  initialized: boolean
  stopped: boolean
  controller: AbortController
}
type CheckoutPoll = {
  subscribers: Set<Subscription>
  timer: ReturnType<typeof setInterval>
  pending?: Promise<void>
}

/** A single pending consumer and a bounded queue; overflow discards detail and forces resync. */
export class Subscription {
  readonly id = randomUUID()
  private sequence = 0
  private queue: WorkspaceChange[] = []
  private bytes = 0
  private wake?: () => void
  private stopped = false
  private cleanupDone = false
  onStop?: () => void
  constructor(
    public workspace: WorkspaceResolution,
    readonly onClose: () => void,
  ) {}
  push(
    paths: string[],
    resyncRequired: boolean,
    mode: WorkspaceChange['mode'],
    targetChanged = false,
  ) {
    if (this.stopped) return
    let event: WorkspaceChange = {
      watchId: this.id,
      sequence: ++this.sequence,
      workspace: publicWorkspace(this.workspace),
      paths,
      resyncRequired,
      mode,
      ...(targetChanged ? { targetChanged: true } : {}),
    }
    const size = Buffer.byteLength(JSON.stringify(event))
    if (
      this.queue.length >= WORKSPACE_LIMITS.subscriberBatches ||
      this.bytes + size > WORKSPACE_LIMITS.subscriberBytes
    ) {
      this.queue = []
      this.bytes = 0
      event = { ...event, paths: [], resyncRequired: true }
    }
    this.queue.push(event)
    this.bytes += Buffer.byteLength(JSON.stringify(event))
    this.wake?.()
    this.wake = undefined
    if (targetChanged) this.close(true)
  }
  async next(): Promise<WorkspaceChange | undefined> {
    while (!this.queue.length && !this.stopped)
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
    const value = this.queue.shift()
    if (value) this.bytes -= Buffer.byteLength(JSON.stringify(value))
    return value
  }
  close(drain = false) {
    this.stopped = true
    if (!drain) {
      this.queue = []
      this.bytes = 0
      this.onStop?.()
    }
    this.wake?.()
    this.wake = undefined
    if (!this.cleanupDone) {
      this.cleanupDone = true
      this.onClose()
    }
  }
}

export class WorkspaceWatches {
  private roots = new Map<string, RootWatch>()
  private checkouts = new Map<string, CheckoutPoll>()
  private subscriptions = new Set<Subscription>()
  private directoryCount = 0
  private closed = false
  private pending = new Set<Promise<unknown>>()
  constructor(private service: WorkspaceFiles) {}
  get diagnostics() {
    return {
      watchRoots: this.roots.size,
      watchDirectories: this.directoryCount,
      subscribers: this.subscriptions.size,
      checkoutPolls: this.checkouts.size,
      watchTasks: this.pending.size,
    }
  }
  private track<T>(promise: Promise<T>) {
    this.pending.add(promise)
    void promise.finally(() => this.pending.delete(promise)).catch(() => {})
    return promise
  }
  async subscribe(target: WorkspaceTarget, signal?: AbortSignal) {
    if (this.closed)
      throw new WorkspaceError(
        'unavailable',
        503,
        'Workspace watcher is closed',
      )
    if (this.subscriptions.size >= WORKSPACE_LIMITS.subscribers)
      throw new WorkspaceError(
        'busy',
        429,
        'Workspace subscription limit reached',
      )
    const workspace = await this.service.operation(signal, (signal) =>
      this.service.targets.resolve(target, signal),
    )
    if (this.closed || this.subscriptions.size >= WORKSPACE_LIMITS.subscribers)
      throw new WorkspaceError(
        'busy',
        429,
        'Workspace subscription limit reached',
      )
    let root = this.roots.get(workspace.workspaceId)
    if (!root) {
      if (this.roots.size >= WORKSPACE_LIMITS.watchRoots)
        throw new WorkspaceError(
          'busy',
          429,
          'Workspace watch root limit reached',
        )
      root = {
        workspace,
        directories: new Map(),
        subscribers: new Set(),
        paths: new Set(),
        resync: false,
        bytes: 0,
        mode: 'repair_only',
        dirtyDirectories: new Set(),
        fullRefresh: true,
        incompleteCoverage: true,
        initialized: false,
        stopped: false,
        controller: new AbortController(),
        repair: setInterval(() => {
          this.invalidate(workspace.workspaceId, [], true)
          this.scheduleRefresh(selectedRoot)
        }, WORKSPACE_LIMITS.repairMs),
      }
      this.roots.set(workspace.workspaceId, root)
    }
    const selectedRoot = root
    let subscription!: Subscription
    const abort = () => subscription.close()
    subscription = new Subscription(workspace, () => {
      signal?.removeEventListener('abort', abort)
      this.subscriptions.delete(subscription)
      selectedRoot.subscribers.delete(subscription)
      const poll = this.checkouts.get(workspace.checkoutKey)
      poll?.subscribers.delete(subscription)
      if (poll && !poll.subscribers.size) {
        clearInterval(poll.timer)
        this.checkouts.delete(workspace.checkoutKey)
      }
      if (!selectedRoot.subscribers.size) this.stopRoot(selectedRoot)
    })
    this.subscriptions.add(subscription)
    root.subscribers.add(subscription)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) {
      subscription.close()
      throw new WorkspaceError(
        'interrupted',
        503,
        'Workspace subscription interrupted',
      )
    }
    this.startPoll(subscription)
    if (!root.initialized) await this.refresh(root)
    else if (root.refresh) await root.refresh
    subscription.push([], true, root.mode)
    return subscription
  }
  private stopRoot(root: RootWatch) {
    if (root.stopped) return
    root.stopped = true
    root.controller.abort()
    clearTimeout(root.debounce)
    clearTimeout(root.burst)
    root.debounce = undefined
    root.burst = undefined
    clearTimeout(root.refreshDebounce)
    clearTimeout(root.refreshBurst)
    clearInterval(root.repair)
    this.roots.delete(root.workspace.workspaceId)
    for (const entry of root.directories.values()) this.closeDirectory(entry)
    root.directories.clear()
  }
  private closeDirectory(entry: DirectoryWatch) {
    entry.watcher.close()
    this.directoryCount--
  }
  private removeTree(root: RootWatch, path: string) {
    const pending = [path]
    while (pending.length) {
      const selected = pending.pop()!
      const entry = root.directories.get(selected)
      if (!entry) continue
      pending.push(...entry.children)
      this.closeDirectory(entry)
      root.directories.delete(selected)
    }
  }
  private scheduleRefresh(root: RootWatch, path?: string) {
    if (root.stopped) return
    root.mode = 'repair_only'
    if (path === undefined) root.fullRefresh = true
    else root.dirtyDirectories.add(path)
    if (root.dirtyDirectories.size > WORKSPACE_LIMITS.watchEvents) {
      root.dirtyDirectories.clear()
      root.fullRefresh = true
      root.mode = 'repair_only'
      this.invalidate(root.workspace.workspaceId, [], true)
    }
    // An active pass drains this set before it can report native coverage.
    if (root.refresh) return
    clearTimeout(root.refreshDebounce)
    root.refreshDebounce = setTimeout(
      () => void this.refresh(root),
      WORKSPACE_LIMITS.debounceMs,
    )
    root.refreshBurst ??= setTimeout(
      () => void this.refresh(root),
      WORKSPACE_LIMITS.burstMs,
    )
  }
  private refresh(root: RootWatch) {
    if (root.refresh) return root.refresh
    if (root.stopped) return Promise.resolve()
    clearTimeout(root.refreshDebounce)
    clearTimeout(root.refreshBurst)
    root.refreshDebounce = undefined
    root.refreshBurst = undefined
    root.mode = 'repair_only'
    const task = this.track(
      this.service
        .operation(root.controller.signal, async (signal) => {
          let visited = 0,
            passes = 0
          while (root.fullRefresh || root.dirtyDirectories.size) {
            if (++passes > WORKSPACE_LIMITS.watchEvents)
              throw new Error('Workspace watch refresh limit reached')
            const full =
              root.fullRefresh ||
              (root.incompleteCoverage && root.dirtyDirectories.has(''))
            root.fullRefresh = false
            const queue = full ? [''] : [...root.dirtyDirectories]
            root.dirtyDirectories.clear()
            const queued = new Set(queue)
            while (queue.length) {
              signal.throwIfAborted()
              if (++visited > WORKSPACE_LIMITS.watchDirectories)
                throw new Error('Workspace watch directory limit reached')
              const path = queue.shift()!
              let chain: WorkspacePath
              try {
                chain = await WorkspacePath.open(
                  root.workspace.cwd,
                  root.workspace.rootIdentity,
                  path,
                  true,
                  signal,
                )
              } catch (error) {
                this.removeTree(root, path)
                if (
                  path &&
                  ((error as NodeJS.ErrnoException).code === 'ENOENT' ||
                    (error instanceof WorkspaceError &&
                      error.code === 'file_not_found'))
                )
                  continue
                throw error
              }
              let failure: unknown
              try {
                const info = await chain.parent.stat({ bigint: true })
                const identity = `${info.dev}:${info.ino}`
                if (root.directories.get(path)?.identity !== identity)
                  this.removeTree(root, path)
                if (!root.directories.has(path)) {
                  await this.service.hooks.beforeWatchDirectory?.(path)
                  signal.throwIfAborted()
                  if (this.directoryCount >= WORKSPACE_LIMITS.watchDirectories)
                    throw new Error('Workspace watch directory limit reached')
                  const watcher = watch(
                    descriptorPath(chain.parent),
                    { persistent: false },
                    (event, filename) => {
                      if (!filename) {
                        this.invalidate(root.workspace.workspaceId, [], true)
                        this.scheduleRefresh(root)
                        return
                      }
                      const name = filename.toString()
                      if (name.toLowerCase() === '.git' || ownedTemporary(name))
                        return
                      const relative = path ? `${path}/${name}` : name
                      try {
                        relativePath(relative)
                      } catch {
                        this.invalidate(root.workspace.workspaceId, [], true)
                        this.scheduleRefresh(root)
                        return
                      }
                      this.invalidate(root.workspace.workspaceId, [relative])
                      if (event === 'rename') this.scheduleRefresh(root, path)
                    },
                  )
                  watcher.on('error', () => {
                    if (root.directories.get(path)?.watcher === watcher)
                      this.removeTree(root, path)
                    root.mode = 'repair_only'
                    this.invalidate(root.workspace.workspaceId, [], true)
                    this.scheduleRefresh(root)
                  })
                  root.directories.set(path, {
                    watcher,
                    identity,
                    children: new Set(),
                  })
                  this.directoryCount++
                }
                const children = new Set<string>()
                const dir = await opendir(descriptorPath(chain.parent))
                let entries = 0
                try {
                  for await (const child of dir) {
                    signal.throwIfAborted()
                    if (++entries > WORKSPACE_LIMITS.scan)
                      throw new Error('Workspace watch scan limit reached')
                    if (
                      child.name.toLowerCase() === '.git' ||
                      ownedTemporary(child.name)
                    )
                      continue
                    const relative = path ? `${path}/${child.name}` : child.name
                    try {
                      relativePath(relative)
                    } catch {
                      continue
                    }
                    const info = await lstat(
                      descriptorPath(chain.parent, child.name),
                      { bigint: true },
                    ).catch((error) => {
                      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                        return null
                      throw error
                    })
                    if (!info?.isDirectory()) continue
                    children.add(relative)
                    if (
                      full ||
                      root.directories.get(relative)?.identity !==
                        `${info.dev}:${info.ino}`
                    ) {
                      if (!queued.has(relative)) {
                        if (queued.size >= WORKSPACE_LIMITS.watchDirectories)
                          throw new Error(
                            'Workspace watch directory limit reached',
                          )
                        queue.push(relative)
                        queued.add(relative)
                      }
                    }
                  }
                } finally {
                  await dir.close().catch(() => {})
                }
                const entry = root.directories.get(path)!
                for (const child of entry.children)
                  if (!children.has(child)) this.removeTree(root, child)
                entry.children = children
              } catch (error) {
                failure = error
              }
              try {
                await chain.verify()
              } catch (error) {
                this.removeTree(root, path)
                failure = error
              } finally {
                await chain.close()
              }
              if (failure) throw failure
            }
            if (full) root.incompleteCoverage = false
          }
          signal.throwIfAborted()
          root.mode = root.incompleteCoverage ? 'repair_only' : 'native'
        })
        .catch(() => {
          if (!root.stopped) {
            root.mode = root.directories.size ? 'repair_only' : 'unavailable'
            root.incompleteCoverage = true
            root.dirtyDirectories.clear()
            root.fullRefresh = false
            this.invalidate(root.workspace.workspaceId, [], true)
          }
        }),
    )
    root.refresh = task
    void task
      .finally(() => {
        root.refresh = undefined
        root.initialized = true
        if (root.paths.size || root.resync)
          this.invalidate(root.workspace.workspaceId, [])
        if (root.dirtyDirectories.size || root.fullRefresh)
          this.scheduleRefresh(
            root,
            root.dirtyDirectories.values().next().value,
          )
      })
      .catch(() => {})
    return task
  }
  invalidate(workspaceId: string, paths: string[], resync = false) {
    const root = this.roots.get(workspaceId)
    if (!root || root.stopped) return
    root.resync ||= resync
    for (const path of paths) {
      try {
        relativePath(path)
      } catch {
        continue
      }
      if (!root.paths.has(path)) {
        root.paths.add(path)
        root.bytes += Buffer.byteLength(path)
      }
      if (
        root.paths.size > WORKSPACE_LIMITS.watchEvents ||
        root.bytes > WORKSPACE_LIMITS.subscriberBytes
      ) {
        root.paths.clear()
        root.bytes = 0
        root.resync = true
        break
      }
    }
    clearTimeout(root.debounce)
    root.debounce = setTimeout(
      () => this.flush(root),
      WORKSPACE_LIMITS.debounceMs,
    )
    root.burst ??= setTimeout(() => this.flush(root), WORKSPACE_LIMITS.burstMs)
  }
  private flush(root: RootWatch) {
    clearTimeout(root.debounce)
    clearTimeout(root.burst)
    root.debounce = undefined
    root.burst = undefined
    if (root.stopped || !root.initialized) return
    for (const subscription of root.subscribers)
      subscription.push(
        root.resync ? [] : [...root.paths].sort(),
        root.resync,
        root.mode,
      )
    root.paths.clear()
    root.bytes = 0
    root.resync = false
  }
  private startPoll(subscription: Subscription) {
    const key = subscription.workspace.checkoutKey
    let poll = this.checkouts.get(key)
    if (!poll) {
      poll = {
        subscribers: new Set(),
        timer: setInterval(
          () => this.poll(key),
          WORKSPACE_LIMITS.checkoutPollMs,
        ),
      }
      this.checkouts.set(key, poll)
    }
    poll.subscribers.add(subscription)
  }
  private poll(key: string) {
    const poll = this.checkouts.get(key)
    if (!poll || poll.pending || this.closed) return
    const task = this.track(
      this.service
        .operation(undefined, async (signal) => {
          const observations: WorkspaceObservations = {
            targets: new Map(),
            checkouts: new Map(),
          }
          const first = [...poll.subscribers][0]
          if (!first) return
          for (const subscriber of Array.from(poll.subscribers)) {
            try {
              const next = await this.service.targets.resolve(
                subscriber.workspace.target,
                signal,
                observations,
              )
              const changed =
                next.workspaceId !== subscriber.workspace.workspaceId ||
                next.workspaceRevision !==
                  subscriber.workspace.workspaceRevision
              const targetChanged =
                next.workspaceId !== subscriber.workspace.workspaceId
              subscriber.workspace = next
              if (changed)
                subscriber.push(
                  [],
                  true,
                  this.roots.get(next.workspaceId)?.mode ?? 'unavailable',
                  targetChanged,
                )
            } catch {
              subscriber.push([], true, 'unavailable', true)
            }
          }
        })
        .catch(() => {
          for (const subscriber of poll.subscribers)
            subscriber.push([], true, 'unavailable')
        }),
    )
    poll.pending = task
    void task
      .finally(() => {
        poll.pending = undefined
      })
      .catch(() => {})
  }
  async close() {
    this.closed = true
    for (const subscriber of this.subscriptions) subscriber.close()
    for (const root of this.roots.values()) this.stopRoot(root)
    for (const poll of this.checkouts.values()) clearInterval(poll.timer)
    this.checkouts.clear()
    while (this.pending.size) await Promise.allSettled(this.pending)
  }
}
