import { randomUUID } from 'node:crypto'
import {
  KimiBudget,
  KimiError,
  kimiLimits,
  reserveAll,
  jsonBytes,
} from './limits.js'
import {
  sameAuthority,
  assertIdentity,
  type EffectiveAuthority,
} from './authority.js'
import { KimiServer } from './server.js'
import type { KimiHost, KimiHostOptions } from './types.js'
import type { KimiRecords } from './records.js'

type Home = {
  authority: EffectiveAuthority
  budget: KimiBudget
  server: Promise<KimiServer>
  consumers: number
  residents: Map<string, () => void>
  writers: Set<string>
  ingestions: Map<
    string,
    { records: KimiRecords; ready: Promise<void>; references: number }
  >
  leases: Set<() => void>
  release: () => void
  stopping?: Promise<void>
}
export type KimiLease = {
  server: KimiServer
  lane: string
  home: Home
  resident(id?: string): (confirmedId: string) => void
  claimWriter(nativeSessionId: string): void
  ingestion(
    nativeSessionId: string,
    sessionId: string,
    create: () => { records: KimiRecords; ready: Promise<void> },
  ): Promise<KimiRecords>
  close(): Promise<void>
}

/** One instance belongs to the backend composition root and survives adapter replacement. */
export class KimiHostOwner implements KimiHost {
  readonly budget: KimiBudget
  private readonly homes = new Map<string, Home>()
  private closed = false
  private readonly physicalCallbacks = new Set<Promise<unknown>>()
  constructor(options: KimiHostOptions = {}) {
    this.budget = new KimiBudget(kimiLimits(options.limits))
  }
  track<T>(work: Promise<T>): Promise<T> {
    this.physicalCallbacks.add(work)
    void work.finally(() => this.physicalCallbacks.delete(work)).catch(() => {})
    return work
  }
  async acquire(
    authority: EffectiveAuthority,
    kind: 'session' | 'helper',
    writer?: string,
  ): Promise<KimiLease> {
    if (this.closed) throw new KimiError('kimi_host_closed')
    await assertIdentity(authority.home)
    if (this.closed) throw new KimiError('kimi_host_closed')
    let home = this.homes.get(authority.home.path)
    if (home && (!sameAuthority(home.authority, authority) || home.stopping))
      throw new KimiError('kimi_server_authority_changed')
    let startupRelease: (() => void) | undefined
    if (!home) {
      const release = reserveAll([
        [this.budget, 'hostHomes'],
        [
          this.budget,
          'hostRetainedBytes',
          jsonBytes(
            authority,
            this.budget.limits,
            this.budget.limits.stateReadBytes,
          ),
        ],
      ])
      try {
        startupRelease = this.budget.reserve('hostStartups')
      } catch (error) {
        release()
        throw error
      }
      const entry: Home = {
        authority,
        budget: new KimiBudget(this.budget.limits),
        server: undefined!,
        consumers: 0,
        residents: new Map(),
        writers: new Set(),
        ingestions: new Map(),
        leases: new Set(),
        release,
      }
      home = entry
      entry.budget.add('homeServers')
      this.homes.set(authority.home.path, entry)
      entry.server = KimiServer.start(authority, this.budget).finally(
        startupRelease,
      )
      void entry.server.then(
        (server) =>
          server.done.then(() => {
            if (server.cleanupProved) this.releaseHome(entry)
          }),
        (error) => {
          if (!(error instanceof KimiError && error.uncertain))
            this.releaseHome(entry)
        },
      )
    }
    const ownedHome = home
    if (writer && ownedHome.writers.has(writer))
      throw new KimiError('kimi_session_writer_busy')
    let release: () => void
    try {
      release = reserveAll([
        [this.budget, kind === 'session' ? 'hostSessions' : 'hostHelpers'],
        [ownedHome.budget, kind === 'session' ? 'homeSessions' : 'homeHelpers'],
      ])
    } catch (error) {
      if (!ownedHome.consumers) await this.stopHome(ownedHome)
      throw error
    }
    ownedHome.consumers++
    const freeLease = () => {
      release()
      ownedHome.leases.delete(freeLease)
    }
    ownedHome.leases.add(freeLease)
    if (writer) ownedHome.writers.add(writer)
    let server: KimiServer
    try {
      server = await ownedHome.server
      if (this.closed) throw new KimiError('kimi_host_closed')
    } catch (error) {
      ownedHome.consumers--
      if (writer) ownedHome.writers.delete(writer)
      freeLease()
      throw error
    }
    const lane = randomUUID()
    let closed = false
    const ingestions: string[] = []
    return {
      server,
      lane,
      home: ownedHome,
      claimWriter: (nativeSessionId) => {
        const key = `native:${nativeSessionId}`
        if (key !== writer && ownedHome.writers.has(key))
          throw new KimiError('kimi_session_writer_busy')
        if (writer) ownedHome.writers.delete(writer)
        writer = key
        ownedHome.writers.add(key)
      },
      ingestion: async (nativeSessionId, sessionId, create) => {
        let entry = ownedHome.ingestions.get(nativeSessionId)
        if (entry && entry.records.scope.sessionId !== sessionId)
          throw new KimiError('kimi_history_session_owner')
        if (!entry) {
          const created = create()
          entry = { ...created, references: 0 }
          ownedHome.ingestions.set(nativeSessionId, entry)
        }
        entry.references++
        ingestions.push(nativeSessionId)
        await entry.ready
        return entry.records
      },
      resident: (id?: string) => {
        if (id && ownedHome.residents.has(id)) return () => {}
        const key = id ?? `pending:${randomUUID()}`
        let free: () => void
        try {
          free = reserveAll([
            [this.budget, 'hostResidentSessions'],
            [ownedHome.budget, 'homeResidentSessions'],
          ])
        } catch {
          throw new KimiError('kimi_resident_session_limit')
        }
        ownedHome.residents.set(key, free)
        return (confirmedId) => {
          if (ownedHome.residents.has(confirmedId) && confirmedId !== key) {
            ownedHome.residents.delete(key)
            free()
            return
          }
          ownedHome.residents.delete(key)
          ownedHome.residents.set(confirmedId, free)
        }
      },
      close: async () => {
        if (closed) return
        closed = true
        await server.closeLane(lane).catch(() => {})
        ownedHome.consumers--
        if (writer) ownedHome.writers.delete(writer)
        for (const id of ingestions) {
          const entry = ownedHome.ingestions.get(id)
          if (entry && --entry.references === 0) ownedHome.ingestions.delete(id)
        }
        freeLease()
        if (!ownedHome.consumers) await this.stopHome(ownedHome)
      },
    }
  }
  private releaseHome(home: Home) {
    if (this.homes.get(home.authority.home.path) !== home) return
    for (const release of home.residents.values()) release()
    home.residents.clear()
    for (const release of home.leases) release()
    home.writers.clear()
    home.ingestions.clear()
    home.release()
    this.homes.delete(home.authority.home.path)
  }
  private stopHome(home: Home) {
    home.stopping ??= home.server.then((server) => server.close())
    return home.stopping
  }
  async close() {
    this.closed = true
    const results = await Promise.allSettled(
      [...this.homes.values()].map((home) => this.stopHome(home)),
    )
    await Promise.allSettled(this.physicalCallbacks)
    for (const result of results)
      if (result.status === 'rejected') throw result.reason
  }
}

export function createKimiHost(options?: KimiHostOptions): KimiHost {
  return new KimiHostOwner(options)
}
export function hostOwner(host: KimiHost): KimiHostOwner {
  if (!(host instanceof KimiHostOwner)) throw new KimiError('kimi_invalid_host')
  return host
}
