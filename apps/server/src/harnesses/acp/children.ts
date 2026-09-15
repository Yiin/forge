import { randomUUID } from 'node:crypto'
import type { HarnessEvent } from '../types.js'
import { canonical, digest, immutableData } from './data.js'
import type {
  AcpLiveOwner,
  AcpRecordInput,
  AcpRecordOwner,
} from './ingestion.js'
import type { NumericCapture } from './numbers.js'
import type { AcpProfile } from './profiles.js'
import type { AcpResourceHost } from './limits.js'

export type AcpChildAdmission = Readonly<{
  strings: Readonly<Record<string, string>>
  numbers: NumericCapture
  fallbackOwner: AcpRecordOwner
  exclusiveSubmittedRoot: boolean
  wireOrdinal: number
  rootForPrompt(id: string): AcpLiveOwner | null
}>
export type AcpChildInterval = Readonly<{
  owner: AcpLiveOwner
  providerChildId: string
  parentSessionId: string
  childSessionId?: string
  attemptId?: string
  childId: string
  intervalId: string
  sourceGeneration: string
  spawnOrdinal: number
  parentChildId?: string
  description: string
  closed: boolean
}>
export type AcpChildHistory = Readonly<{
  profile: AcpProfile
  grokRail?: 'public' | 'comet'
  absenceKnown: boolean
  intervals: readonly AcpChildInterval[]
}>
type Body = Record<string, unknown> & { type: string }
type Evidence = {
  method: string
  kind: 'spawn' | 'progress' | 'finish' | 'context' | 'other'
  parentSessionId?: string
  providerChildId?: string
  childSessionId?: string
  attemptId?: string
  promptId?: string
  parentAgentId?: string
  tag?: string
}
type Selection = {
  evidence: Readonly<Evidence>
  owner: AcpRecordOwner | null
  interval?: AcpChildInterval
  parent?: AcpChildInterval
  consumed: boolean
  introduced?: boolean
  wireOrdinal: number
}
function boundedId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 512)
    throw Error('Invalid ACP child identity')
}
function sameScope(a: AcpRecordOwner, b: AcpRecordOwner) {
  return (
    a.sessionId === b.sessionId &&
    a.providerInstanceId === b.providerInstanceId &&
    canonical(a.account) === canonical(b.account)
  )
}
function key(interval: AcpChildInterval) {
  return canonical([
    interval.owner.providerInstanceId,
    interval.owner.account,
    interval.parentSessionId,
    interval.providerChildId,
    interval.childSessionId ?? null,
  ])
}
function field(value: unknown, name: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null)
    throw Error('Invalid ACP child data')
  const descriptor = Object.getOwnPropertyDescriptor(value, name)
  if (descriptor && !('value' in descriptor))
    throw Error('Invalid ACP child accessor')
  return descriptor?.value
}
const routingPaths = [
  'sessionId',
  'update/sessionUpdate',
  'update/subagent_id',
  'update/child_session_id',
  'update/parent_session_id',
  'update/attempt_id',
  'update/parent_prompt_id',
  'update/_meta/attempt_id',
  'update/_meta/cognition.ai~1subagent_started/agentId',
  'update/_meta/cognition.ai~1subagent_completed/agentId',
  'update/_meta/cognition.ai~1subagent_context/parentAgentId',
]
const identityPaths = new Set(
  routingPaths
    .filter((path) => !path.endsWith('sessionUpdate'))
    .map((path) => '/params/' + path),
)
function fields(method: string, params: unknown): Record<string, string> {
  const strings: Record<string, string> = Object.create(null)
  strings['/method'] = method
  for (const path of routingPaths) {
    let value = params
    for (const key of path.split('/'))
      value = field(value, key.replaceAll('~1', '/').replaceAll('~0', '~'))
    if (typeof value === 'string') strings['/params/' + path] = value
  }
  return strings
}
function validateOwner(owner: AcpLiveOwner) {
  if (owner.phase !== 'live') throw Error('Invalid ACP child owner')
  for (const id of [
    owner.sessionId,
    owner.providerInstanceId,
    owner.runtimeGeneration,
    owner.runId,
    owner.turnId,
    owner.binding.provider,
    owner.binding.providerSessionId,
  ])
    boundedId(id)
  if (
    typeof owner.binding.cwd !== 'string' ||
    !owner.binding.cwd ||
    Buffer.byteLength(owner.binding.cwd) > 4096 ||
    owner.binding.provider !== owner.providerInstanceId
  )
    throw Error('Invalid ACP child binding')
  if (owner.account.kind === 'native-default') {
    boundedId(owner.account.configurationId)
    if (owner.binding.accountId !== null)
      throw Error('Invalid ACP child account')
  } else if (owner.account.kind === 'selected-account') {
    boundedId(owner.account.accountId)
    if (owner.binding.accountId !== owner.account.accountId)
      throw Error('Invalid ACP child account')
  } else throw Error('Invalid ACP child account')
}

export class AcpChildren {
  private selections = new WeakMap<AcpChildAdmission, Selection>()
  private readonly intervals: AcpChildInterval[] = []
  private readonly byKey = new Map<string, AcpChildInterval[]>()
  private readonly absenceKnown: boolean
  private readonly release: () => void
  private closed = false
  private retainedBytes = 0
  private retainedNodes = 0
  private readonly validated = new Set<string>()
  constructor(
    private readonly options: {
      profile: AcpProfile
      host: AcpResourceHost
      instanceId: string
      grokRail?: 'public' | 'comet'
      restoredHistory: 'new' | 'unavailable' | AcpChildHistory
      makeEvent(owner: AcpLiveOwner, body: Body): HarnessEvent
    },
  ) {
    this.release = options.host.reserve(
      options.instanceId,
      'retained',
      16 * 1024 * 1024,
    )
    try {
      if (options.profile === 'grok' && !options.grokRail)
        throw Error('ACP Grok child rail is required')
      const history =
        typeof options.restoredHistory === 'object'
          ? immutableData(options.restoredHistory, 16 * 1024 * 1024)
          : options.restoredHistory
      this.options = Object.freeze({
        ...options,
        restoredHistory: 'unavailable',
      })
      this.absenceKnown =
        history === 'new' ||
        (typeof history === 'object' && history.absenceKnown)
      if (typeof history === 'object') {
        const snapshot = history
        if (
          snapshot.profile !== options.profile ||
          snapshot.grokRail !== options.grokRail
        )
          throw Error('Foreign ACP child history profile')
        if (
          typeof snapshot.absenceKnown !== 'boolean' ||
          !Array.isArray(snapshot.intervals)
        )
          throw Error('Invalid ACP child history')
        for (const interval of snapshot.intervals) {
          this.add(interval)
          this.validated.add(interval.intervalId)
        }
      }
    } catch (error) {
      this.release()
      throw error
    }
  }
  private evidence(strings: Readonly<Record<string, string>>): Evidence {
    const method = strings['/method'] ?? ''
    const get = (path: string) => strings['/params/' + path]
    const rail =
      this.options.grokRail === 'public'
        ? '_x.ai/session/update'
        : '_x.ai/session_notification'
    if (this.options.profile === 'grok' && method === rail) {
      const tag = get('update/sessionUpdate')
      const kind =
        tag === 'subagent_spawned'
          ? 'spawn'
          : tag === 'subagent_progress'
            ? 'progress'
            : tag === 'subagent_finished'
              ? 'finish'
              : 'other'
      return {
        method,
        kind,
        tag,
        parentSessionId: get('sessionId'),
        providerChildId: get('update/subagent_id'),
        childSessionId: get('update/child_session_id'),
        attemptId: get('update/attempt_id'),
        promptId: get('update/parent_prompt_id'),
        ...(get('update/parent_session_id') !== undefined &&
        get('update/parent_session_id') !== get('sessionId')
          ? { parentSessionId: undefined }
          : {}),
      }
    }
    if (this.options.profile === 'devin' && method === 'session/update') {
      const meta = 'update/_meta/cognition.ai~1'
      const spawned = get(meta + 'subagent_started/agentId'),
        finished = get(meta + 'subagent_completed/agentId')
      return {
        method,
        kind: spawned
          ? 'spawn'
          : finished
            ? 'finish'
            : get(meta + 'subagent_context/parentAgentId')
              ? 'context'
              : 'other',
        parentSessionId: get('sessionId'),
        providerChildId:
          spawned ?? finished ?? get(meta + 'subagent_context/parentAgentId'),
        parentAgentId: get(meta + 'subagent_context/parentAgentId'),
        tag: get('update/sessionUpdate'),
      }
    }
    if (this.options.profile === 'grok' && method === 'session/update')
      return {
        method,
        kind: 'context',
        childSessionId: get('sessionId'),
        attemptId: get('update/_meta/attempt_id'),
      }
    return { method, kind: 'other' }
  }
  private matches(
    evidence: Evidence,
    scope: AcpRecordOwner,
  ): AcpChildInterval[] {
    return this.intervals.filter(
      (interval) =>
        sameScope(interval.owner, scope) &&
        (!evidence.parentSessionId ||
          interval.parentSessionId === evidence.parentSessionId) &&
        (!evidence.providerChildId ||
          interval.providerChildId === evidence.providerChildId) &&
        (!evidence.childSessionId ||
          interval.childSessionId === evidence.childSessionId),
    )
  }
  private exact(
    evidence: Evidence,
    scope: AcpRecordOwner,
  ): AcpChildInterval | undefined {
    const matches = this.matches(evidence, scope)
    if (evidence.attemptId !== undefined) {
      const exact = matches.filter(
        (interval) => interval.attemptId === evidence.attemptId,
      )
      return exact.length === 1 ? exact[0] : undefined
    }
    return this.absenceKnown &&
      matches.length === 1 &&
      this.byKey.get(key(matches[0]!))?.length === 1
      ? matches[0]
      : undefined
  }
  route(admission: AcpChildAdmission): AcpRecordOwner | null {
    if (this.closed) throw Error('ACP child registry closed')
    const cached = this.selections.get(admission)
    if (cached) return cached.owner
    const strings = immutableData(admission.strings, 16384)
    const evidence = immutableData(this.evidence(strings))
    const fallback = immutableData(admission.fallbackOwner)
    if (fallback.providerInstanceId !== this.options.instanceId)
      throw Error('Foreign ACP child registry')
    const selection: Selection = {
      evidence,
      owner: null,
      consumed: false,
      wireOrdinal: admission.wireOrdinal,
    }
    this.selections.set(admission, selection)
    if (
      admission.numbers.numbers.some((number) => identityPaths.has(number.path))
    )
      return null
    if (evidence.kind === 'other') return (selection.owner = fallback)
    if (
      evidence.kind === 'context' &&
      this.options.profile === 'grok' &&
      (fallback.phase === 'live' || fallback.phase === 'load_replay') &&
      evidence.childSessionId === fallback.binding.providerSessionId
    )
      return (selection.owner = fallback)
    if (
      evidence.kind !== 'context' &&
      (!evidence.parentSessionId || !evidence.providerChildId)
    )
      return null
    if (
      evidence.kind === 'context' &&
      !evidence.childSessionId &&
      !evidence.providerChildId
    )
      return null
    for (const value of [
      evidence.parentSessionId,
      evidence.providerChildId,
      evidence.childSessionId,
      evidence.attemptId,
      evidence.promptId,
      evidence.parentAgentId,
    ])
      if (value !== undefined) boundedId(value)
    const promptOwner = evidence.promptId
      ? immutableData(admission.rootForPrompt(evidence.promptId))
      : undefined
    if (
      evidence.promptId &&
      (!promptOwner ||
        !sameScope(promptOwner, fallback) ||
        promptOwner.binding.providerSessionId !== evidence.parentSessionId)
    )
      return null
    if (evidence.kind !== 'spawn') {
      selection.interval = this.exact(evidence, fallback)
      if (
        promptOwner &&
        selection.interval &&
        digest(promptOwner) !== digest(selection.interval.owner)
      )
        return null
      return (selection.owner = selection.interval?.owner ?? null)
    }
    if (this.options.profile === 'grok' && !evidence.childSessionId) return null
    if (
      this.options.profile === 'devin' &&
      !['tool_call', 'tool_call_update'].includes(evidence.tag ?? '')
    )
      return null
    if (evidence.attemptId) {
      const existing = this.exact(evidence, fallback)
      if (existing) {
        if (promptOwner && digest(promptOwner) !== digest(existing.owner))
          return null
        selection.interval = existing
        return (selection.owner = existing.owner)
      }
    }
    if (evidence.parentAgentId) {
      selection.parent = this.exact(
        {
          ...evidence,
          providerChildId: evidence.parentAgentId,
          childSessionId: undefined,
        },
        fallback,
      )
      if (!selection.parent) return null
      selection.owner = selection.parent.owner
    } else if (evidence.promptId) {
      selection.owner = promptOwner ?? null
    } else if (admission.exclusiveSubmittedRoot && fallback.phase === 'live')
      selection.owner = fallback
    if (
      selection.owner?.phase !== 'live' ||
      selection.owner.binding.providerSessionId !== evidence.parentSessionId
    )
      selection.owner = null
    if (selection.owner?.phase === 'live') {
      const owner = selection.owner
      const interval: AcpChildInterval = immutableData({
        owner,
        providerChildId: evidence.providerChildId!,
        parentSessionId: evidence.parentSessionId!,
        ...(evidence.childSessionId
          ? { childSessionId: evidence.childSessionId }
          : {}),
        ...(evidence.attemptId ? { attemptId: evidence.attemptId } : {}),
        childId: randomUUID(),
        intervalId: randomUUID(),
        sourceGeneration: owner.runtimeGeneration,
        spawnOrdinal: selection.wireOrdinal,
        description: '',
        closed: false,
        ...(selection.parent
          ? { parentChildId: selection.parent.childId }
          : {}),
      })
      this.add(interval)
      selection.interval = interval
      selection.introduced = true
    }
    return selection.owner
  }
  private selection(
    method: string,
    params: unknown,
    owner: AcpRecordOwner,
    admission: AcpChildAdmission,
  ) {
    if (this.closed) throw Error('ACP child registry closed')
    const selected = this.selections.get(admission)
    if (!selected) throw Error('ACP child frame was not admitted')
    const snapshot = params
    if (
      canonical(this.evidence(fields(method, snapshot))) !==
        canonical(selected.evidence) ||
      !selected.owner ||
      digest(selected.owner) !== digest(owner)
    )
      throw Error('ACP child admission changed')
    return { selected, params: snapshot as Record<string, unknown> }
  }
  update(
    method: string,
    params: unknown,
    owner: AcpRecordOwner,
    wireOrdinal: number,
    admission: AcpChildAdmission,
  ): AcpRecordInput[] {
    const { selected, params: snapshot } = this.selection(
      method,
      params,
      owner,
      admission,
    )
    if (selected.consumed) throw Error('ACP child frame already consumed')
    selected.consumed = true
    const { evidence } = selected
    if (evidence.kind === 'other' || evidence.kind === 'context') return []
    if (
      !Number.isSafeInteger(wireOrdinal) ||
      wireOrdinal < 0 ||
      wireOrdinal !== selected.wireOrdinal ||
      owner.phase !== 'live'
    )
      throw Error('Invalid ACP child frame ordinal')
    const update = field(snapshot, 'update')
    if (evidence.kind === 'spawn') {
      if (!selected.introduced) return []
      if (selected.parent && !this.validated.has(selected.parent.intervalId))
        throw Error('ACP child parent introduction is pending')
      const description =
        this.options.profile === 'grok'
          ? field(update, 'description')
          : field(
              field(field(update, '_meta'), 'cognition.ai/subagent_started'),
              'title',
            )
      if (
        description !== undefined &&
        (typeof description !== 'string' ||
          Buffer.byteLength(description) > 65536)
      )
        throw Error('Invalid ACP child description')
      const original = this.intervals.find(
        (value) => value.intervalId === selected.interval!.intervalId,
      )!
      const interval = immutableData({
        ...original,
        description: description ?? '',
      })
      const addedBytes = Math.max(
        interval.description.length * 2,
        Buffer.byteLength(interval.description),
      )
      if (this.retainedBytes + addedBytes > 16 * 1024 * 1024)
        throw Error('ACP child state limit')
      const records = [
        this.event(interval, {
          type: 'child_started',
          description: interval.description,
          providerChildId: interval.providerChildId,
          ...(interval.parentChildId
            ? { parentChildId: interval.parentChildId }
            : {}),
        }),
      ]
      this.retainedBytes += addedBytes
      this.replace(original, interval)
      this.validated.add(interval.intervalId)
      return records
    }
    const interval = this.intervals.find(
      (value) => value.intervalId === selected.interval!.intervalId,
    )!
    if (!this.validated.has(interval.intervalId))
      throw Error('ACP child introduction is pending')
    if (evidence.kind === 'progress' || interval.closed) return []
    let outcome: 'completed' | 'failed' | 'interrupted' | undefined
    if (this.options.profile === 'grok') {
      const status = field(update, 'status')
      if (status === 'completed' || status === 'failed') outcome = status
      else if (status === 'cancelled') outcome = 'interrupted'
    } else {
      const success = field(
        field(field(update, '_meta'), 'cognition.ai/subagent_completed'),
        'success',
      )
      if (success === true) outcome = 'completed'
      else if (success === false) outcome = 'failed'
    }
    if (!outcome) return []
    const closed = immutableData({ ...interval, closed: true })
    const records = [
      this.event(interval, {
        type: 'child_finished',
        outcome: {
          status: outcome,
          ...(outcome === 'failed'
            ? { code: 'ACP_CHILD_FAILED', message: 'Child failed' }
            : {}),
        },
      }),
    ]
    this.replace(interval, closed)
    return records
  }
  isChild(admission: AcpChildAdmission): boolean {
    if (this.closed) throw Error('ACP child registry closed')
    const selected = this.selections.get(admission)
    if (!selected) throw Error('ACP child frame was not admitted')
    if (selected.evidence.kind === 'other') return false
    if (selected.evidence.kind !== 'context' || this.options.profile !== 'grok')
      return true
    const owner = selected.owner
    return (
      !owner ||
      owner.phase === 'control' ||
      selected.evidence.childSessionId !== owner.binding.providerSessionId
    )
  }
  context(
    params: unknown,
    admission: AcpChildAdmission,
  ): { owner: AcpLiveOwner; childId: string; intervalId: string } | null {
    if (this.closed) throw Error('ACP child registry closed')
    const selected = this.selections.get(admission)
    if (!selected?.owner) return null
    this.selection(selected.evidence.method, params, selected.owner, admission)
    const interval = selected.interval
    return interval &&
      !interval.closed &&
      this.validated.has(interval.intervalId)
      ? Object.freeze({
          owner: interval.owner,
          childId: interval.childId,
          intervalId: interval.intervalId,
        })
      : null
  }
  private replace(original: AcpChildInterval, replacement: AcpChildInterval) {
    this.intervals[this.intervals.indexOf(original)] = replacement
    const group = this.byKey.get(key(original))!
    group[group.indexOf(original)] = replacement
  }
  private event(interval: AcpChildInterval, body: Body): AcpRecordInput {
    return {
      subject: { childId: interval.childId, intervalId: interval.intervalId },
      value: {
        kind: 'event',
        event: this.options.makeEvent(interval.owner, {
          ...body,
          itemId: interval.childId,
          childId: interval.childId,
        }),
      },
    }
  }
  private add(interval: AcpChildInterval) {
    validateOwner(interval.owner)
    if (interval.owner.providerInstanceId !== this.options.instanceId)
      throw Error('Foreign ACP child registry')
    if (
      interval.owner.phase !== 'live' ||
      interval.sourceGeneration !== interval.owner.runtimeGeneration ||
      interval.parentSessionId !== interval.owner.binding.providerSessionId ||
      typeof interval.closed !== 'boolean' ||
      !Number.isSafeInteger(interval.spawnOrdinal) ||
      interval.spawnOrdinal < 0
    )
      throw Error('Invalid ACP child history owner')
    for (const id of [
      interval.providerChildId,
      interval.parentSessionId,
      interval.childId,
      interval.intervalId,
      interval.owner.runId,
      interval.owner.turnId,
    ])
      boundedId(id)
    if (interval.attemptId !== undefined) boundedId(interval.attemptId)
    if (interval.childSessionId !== undefined)
      boundedId(interval.childSessionId)
    if (
      typeof interval.description !== 'string' ||
      Buffer.byteLength(interval.description) > 65536
    )
      throw Error('Invalid ACP child history description')
    if (
      this.intervals.some(
        (old) =>
          old.childId === interval.childId ||
          old.intervalId === interval.intervalId,
      )
    )
      throw Error('Duplicate ACP child history ID')
    const group = this.byKey.get(key(interval)) ?? []
    if (
      interval.attemptId &&
      group.some((old) => old.attemptId === interval.attemptId)
    )
      throw Error('Duplicate ACP child attempt')
    const parent = interval.parentChildId
      ? this.intervals.find((old) => old.childId === interval.parentChildId)
      : undefined
    if (
      interval.parentChildId &&
      (!parent || digest(parent.owner) !== digest(interval.owner))
    )
      throw Error('Invalid ACP child ancestry')
    let depth = 0,
      ancestor = parent
    while (ancestor) {
      if (++depth >= 16) throw Error('ACP child depth limit')
      ancestor = this.intervals.find(
        (old) => old.childId === ancestor!.parentChildId,
      )
    }
    const live = this.intervals.filter((old) => !old.closed)
    const countNodes = (value: unknown): number =>
      1 +
      (value && typeof value === 'object'
        ? Object.values(value).reduce<number>(
            (sum, child) => sum + countNodes(child),
            0,
          )
        : 0)
    const nodes = countNodes(interval)
    const encoded = canonical(interval)
    const bytes = Math.max(encoded.length * 2, Buffer.byteLength(encoded)) + 512
    if (
      this.intervals.length >= 1024 ||
      this.retainedNodes + nodes > 60000 ||
      this.retainedBytes + bytes > 16 * 1024 * 1024 ||
      (!interval.closed &&
        (live.length >= 128 ||
          live.filter((old) => digest(old.owner) === digest(interval.owner))
            .length >= 32))
    )
      throw Error('ACP child state limit')
    this.intervals.push(interval)
    group.push(interval)
    this.byKey.set(key(interval), group)
    this.retainedBytes += bytes
    this.retainedNodes += nodes
  }
  snapshot(): AcpChildHistory {
    if (this.closed) throw Error('ACP child registry closed')
    if (
      this.intervals.some(
        (interval) => !this.validated.has(interval.intervalId),
      )
    )
      throw Error('ACP child introduction is pending')
    return immutableData(
      {
        profile: this.options.profile,
        ...(this.options.grokRail ? { grokRail: this.options.grokRail } : {}),
        absenceKnown: this.absenceKnown,
        intervals: this.intervals,
      },
      16 * 1024 * 1024,
    )
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.intervals.length = 0
    this.byKey.clear()
    this.validated.clear()
    this.selections = new WeakMap()
    this.release()
  }
  hasLive(owner: AcpLiveOwner): boolean {
    return this.intervals.some(
      (interval) =>
        !interval.closed && digest(interval.owner) === digest(owner),
    )
  }
}
