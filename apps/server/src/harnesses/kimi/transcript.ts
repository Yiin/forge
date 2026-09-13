import type { HarnessEvent } from '../types.js'
import {
  KimiError,
  boundedString,
  jsonBytes,
  sequence,
  reserveAll,
  type KimiBudget,
} from './limits.js'
import { object } from './transport.js'
import { digest, record, type KimiRecords } from './records.js'
import type { KimiFrame } from './wire.js'
import type { KimiRoot, KimiSessionCursor, KimiNativeRecord } from './types.js'

/** An ack covers a sequence range. Arrival order and volatile watermarks never replace that range. */
export class KimiReplay {
  private readonly pending = new Map<
    number,
    { frame: KimiFrame; hash: string; release: () => void }
  >()
  private readonly seen = new Map<
    number,
    { hash: string; release: () => void }
  >()
  private scheduled = false
  private serial: Promise<void> = Promise.resolve()
  private acknowledged = false
  private failed?: Error
  cursor: KimiSessionCursor
  constructor(
    cursor: KimiSessionCursor,
    private readonly budget: KimiBudget,
    private readonly apply: (frame: KimiFrame) => Promise<void>,
    private readonly host: KimiBudget = budget,
    private readonly hold: () => () => void = () => () => {},
  ) {
    this.cursor = cursor
  }
  push(frame: KimiFrame) {
    if (frame.volatile) return
    if (frame.epoch !== this.cursor.epoch)
      throw new KimiError('kimi_epoch_changed')
    const bytes = jsonBytes(
      frame,
      this.budget.limits,
      this.budget.limits.wsMessageBytes,
    )
    const freeHash = this.host.reserve('hostRetainedBytes', bytes * 2)
    let hash: string
    try {
      hash = digest(frame)
    } finally {
      freeHash()
    }
    if (frame.seq <= this.cursor.seq) {
      const before = this.seen.get(frame.seq)
      if (before && before.hash !== hash)
        throw new KimiError('kimi_replay_conflict')
      return
    }
    const previous = this.pending.get(frame.seq)
    if (previous) {
      if (previous.hash !== hash) throw new KimiError('kimi_replay_conflict')
      return
    }
    const release = reserveAll([
      [this.budget, 'replayFrames'],
      [this.budget, 'replayBytes', bytes],
      [this.host, 'hostRetainedBytes', bytes],
    ])
    const freeIngestion = this.hold()
    this.pending.set(frame.seq, {
      frame,
      hash,
      release: () => {
        release()
        freeIngestion()
      },
    })
    if (this.acknowledged) this.schedule()
  }
  pause() {
    this.acknowledged = false
  }
  async acknowledge(cursor: KimiSessionCursor) {
    if (cursor.epoch !== this.cursor.epoch || cursor.seq < this.cursor.seq)
      throw new KimiError('kimi_ack_cursor')
    for (let seq = this.cursor.seq + 1; seq <= cursor.seq; seq++)
      if (!this.pending.has(seq)) throw new KimiError('kimi_replay_gap')
    this.acknowledged = true
    this.schedule()
    await this.drain()
  }
  private schedule() {
    if (this.scheduled) return
    this.scheduled = true
    this.serial = this.serial
      .then(async () => {
        if (this.failed) throw this.failed
        while (this.acknowledged) {
          const entry = this.pending.get(this.cursor.seq + 1)
          if (!entry) break
          await this.apply(entry.frame)
          this.cursor = { seq: entry.frame.seq, epoch: entry.frame.epoch }
          this.pending.delete(entry.frame.seq)
          entry.release()
          const bytes = 64 + String(entry.frame.seq).length
          while (
            this.seen.size &&
            (this.budget.count('duplicateEntries') >=
              this.budget.limits.duplicateEntries ||
              this.budget.count('duplicateBytes') + bytes >
                this.budget.limits.duplicateBytes)
          ) {
            const first = this.seen.keys().next().value!
            this.seen.get(first)!.release()
            this.seen.delete(first)
          }
          const release = reserveAll([
            [this.budget, 'duplicateEntries'],
            [this.budget, 'duplicateBytes', bytes],
            [this.host, 'hostRetainedBytes', bytes],
          ])
          this.seen.set(entry.frame.seq, { hash: entry.hash, release })
        }
      })
      .catch((error) => {
        this.failed =
          error instanceof Error ? error : new KimiError('kimi_replay_failed')
      })
      .finally(() => {
        this.scheduled = false
        if (
          !this.failed &&
          this.acknowledged &&
          this.pending.has(this.cursor.seq + 1)
        )
          this.schedule()
      })
  }
  async drain() {
    await this.serial
    if (this.failed) throw this.failed
  }
  dispose() {
    this.acknowledged = false
    for (const entry of this.pending.values()) entry.release()
    this.pending.clear()
    for (const entry of this.seen.values()) entry.release()
    this.seen.clear()
  }
}

type Item = {
  agent: string
  native: Record<string, unknown>
  turnId?: string
  stepId?: string
  root?: KimiRoot
  recordId: string
  itemId: string
  release: () => void
}
const entityIdFields: Readonly<Record<string, string>> = {
  turn: 'turnId',
  step: 'stepId',
  frame: 'frameId',
  marker: 'markerId',
  taskref: 'refId',
  task: 'taskId',
  interaction: 'interactionId',
  attachment: 'attachmentId',
  todo: 'todoId',
  prompt: 'promptId',
}
function nativeEntityId(entity: Record<string, unknown>): unknown {
  for (const field of [
    'frameId',
    'refId',
    'markerId',
    'taskId',
    'attachmentId',
    'interactionId',
    'todoId',
    'promptId',
    'stepId',
    'turnId',
  ])
    if (Object.hasOwn(entity, field)) return entity[field]
  return entity.id
}
export class KimiTranscript {
  private items = new Map<string, Item>()
  private readonly steps = new Map<
    string,
    { root: KimiRoot; release: () => void; agent: string }
  >()
  private readonly baselines = new Map<string, string>()
  private readonly duplicates = new Map<
    string,
    { hash: string; release: () => void }
  >()
  constructor(
    private readonly records: KimiRecords,
    private readonly removeRequests: (root: KimiRoot) => Promise<void>,
    private readonly toolRoot: (
      agent: string,
      callId: string,
    ) => KimiRoot | undefined = () => undefined,
  ) {}
  private setBaseline(agent: string, snapshot: unknown) {
    this.baselines.set(
      agent,
      digest([this.records.checkpoint.transcriptStores?.[agent], snapshot]),
    )
    for (const [id, step] of this.steps)
      if (step.agent === agent) {
        step.release()
        this.steps.delete(id)
      }
  }
  private snapshotEntities(snapshot: Record<string, unknown>) {
    const limits = this.records.budget.limits
    if (!Array.isArray(snapshot.items))
      throw new KimiError('kimi_transcript_baseline')
    const values: {
      field: string
      native: Record<string, unknown>
      turnId?: string
      stepId?: string
    }[] = []
    const add = (
      field: string,
      native: Record<string, unknown>,
      turnId?: string,
      stepId?: string,
    ) => {
      if (values.length >= limits.retainedItems)
        throw new KimiError('kimi_retained_items')
      values.push({ field, native, turnId, stepId })
    }
    for (const value of snapshot.items) {
      const item = object(value)
      if (item.kind !== 'turn') {
        add(item.kind === 'task_ref' ? 'taskref' : 'marker', item)
        continue
      }
      const turnId = boundedString(item.turnId, limits.nativeIdBytes),
        { steps, ...turn } = item
      add('turn', turn, turnId)
      if (!Array.isArray(steps)) throw new KimiError('kimi_transcript_baseline')
      for (const value of steps) {
        const step = object(value),
          stepId = boundedString(step.stepId, limits.nativeIdBytes),
          { frames, ...header } = step
        add('step', header, turnId, stepId)
        if (!Array.isArray(frames))
          throw new KimiError('kimi_transcript_baseline')
        for (const frame of frames) add('frame', object(frame), turnId, stepId)
      }
    }
    for (const field of [
      'task',
      'interaction',
      'attachment',
      'todo',
      'prompt',
    ]) {
      const entries = snapshot[`${field}s`] ?? []
      if (!Array.isArray(entries))
        throw new KimiError('kimi_transcript_baseline')
      for (const value of entries) add(field, object(value))
    }
    return values
  }
  async baseline(
    agent: string,
    snapshot: Record<string, unknown>,
    store = this.records.checkpoint.transcriptStores?.[agent] ??
      'uninitialized',
    end = Infinity,
  ) {
    await this.refreshBaseline(agent, snapshot, store, end)
  }
  async refreshBaseline(
    agent: string,
    snapshot: Record<string, unknown>,
    store = this.records.checkpoint.transcriptStores?.[agent] ??
      'uninitialized',
    end = Infinity,
  ) {
    const limits = this.records.budget.limits
    boundedString(store, limits.cursorBytes)
    if (
      !Array.isArray(snapshot.items) ||
      snapshot.items.filter((value) => object(value).kind === 'turn').length +
        [...this.items.values()].filter(
          (item) => item.agent !== agent && item.native.turnId !== undefined,
        ).length >
        limits.retainedTurns
    )
      throw new KimiError('kimi_retained_turns_limit')
    const snapshotBytes = jsonBytes(snapshot, limits, limits.historyBytes),
      freeTransform = reserveAll([
        [this.records.budget, 'retainedBytes', snapshotBytes],
        [this.records.host.budget, 'hostRetainedBytes', snapshotBytes],
      ])
    const baselineHash = digest([store, snapshot]),
      fresh = new Map<string, Item>(),
      entries: KimiNativeRecord[] = []
    let installed = false
    try {
      for (const value of this.snapshotEntities(snapshot)) {
        const id = boundedString(
            value.native[entityIdFields[value.field]],
            limits.nativeIdBytes,
          ),
          key = digest([agent, id])
        if (fresh.has(key))
          throw new KimiError('kimi_baseline_identity_conflict')
        const release = this.records.retainItem(
          jsonBytes(value.native, limits, limits.retainedItemBytes),
          value.native.kind === 'tool',
        )
        try {
          const native = structuredClone(value.native),
            itemId = digest([
              this.records.scope.binding,
              store,
              baselineHash,
              agent,
              value.field,
              id,
            ]),
            entry = record(
              this.records.scope,
              'cold-import',
              [store, baselineHash, agent, value.field, id],
              'projection.item',
              { native, turnId: value.turnId, stepId: value.stepId, itemId },
              undefined,
              agent,
            )
          entries.push(entry)
          fresh.set(key, {
            agent,
            native,
            turnId: value.turnId,
            stepId: value.stepId,
            itemId,
            recordId: entry.recordId,
            release,
          })
        } catch (error) {
          release()
          throw error
        }
      }
      const old = [...this.items.entries()].filter(
        ([, item]) => item.agent === agent,
      )
      const owners = new Map(
        old
          .filter(([, item]) => item.root)
          .map(([, item]) => [digest(item.root), item.root!]),
      )
      const key = [
        'recovery.baseline',
        agent,
        baselineHash,
        this.records.checkpoint.session ?? null,
      ]
      // Persist hidden entity chunks first. Only the final transaction publishes their IDs and watermark.
      let chunk: KimiNativeRecord[] = []
      for (const entry of entries) {
        if (
          chunk.length &&
          (chunk.length >= limits.sinkBatchRecords ||
            jsonBytes(chunk, limits, limits.sinkBatchBytes) +
              jsonBytes(entry, limits, limits.sinkBatchBytes) +
              1024 >
              limits.sinkBatchBytes)
        ) {
          await this.records.commit(
            [key, 'entities', chunk[0].recordId],
            chunk,
            [],
            undefined,
            false,
            end,
          )
          chunk = []
        }
        chunk.push(entry)
      }
      if (chunk.length)
        await this.records.commit(
          [key, 'entities', chunk[0].recordId],
          chunk,
          [],
          undefined,
          false,
          end,
        )
      for (const root of owners.values()) await this.removeRequests(root)
      await this.records.commit(
        key,
        [
          record(
            this.records.scope,
            'cold-import',
            key,
            'transcript.store.baseline',
            {
              store,
              baselineHash,
              seq: snapshot.seq,
              meta: snapshot.meta,
              agents: snapshot.agents,
              pending_interactions: snapshot.pending_interactions,
            },
            undefined,
            agent,
          ),
          record(
            this.records.scope,
            'local',
            [key, 'projection'],
            'projection.snapshot',
            {
              visibleItemIds: [...this.items.values()]
                .filter((item) => item.agent !== agent)
                .map((item) => item.recordId)
                .concat([...fresh.values()].map((item) => item.recordId)),
              removedItemIds: [],
              unavailableItemIds: old.map(([, item]) => item.recordId),
            },
            undefined,
            agent,
          ),
        ],
        [],
        {
          ...this.records.checkpoint,
          transcripts: {
            ...this.records.checkpoint.transcripts,
            [agent]: sequence(snapshot.seq),
          },
          transcriptStores: {
            ...this.records.checkpoint.transcriptStores,
            [agent]: store,
          },
        },
        false,
        end,
      )
      for (const [key, item] of old) {
        item.release()
        this.items.delete(key)
      }
      for (const [key, item] of fresh) this.items.set(key, item)
      this.setBaseline(agent, snapshot)
      installed = true
    } finally {
      freeTransform()
      if (!installed) for (const item of fresh.values()) item.release()
    }
  }
  step(agent: string, turn: string, step: string, root: KimiRoot) {
    const key = digest([agent, turn, step])
    if (this.steps.has(key)) {
      if (digest(this.steps.get(key)!.root) !== digest(root))
        throw new KimiError('kimi_projection_step_conflict')
      return
    }
    const budget = this.records.budget
    const release = reserveAll([
      [budget, 'ownerEntries'],
      [
        this.records.host.budget,
        'hostRetainedBytes',
        jsonBytes(
          { agent, turn, step, root },
          budget.limits,
          budget.limits.ownerBytes,
        ),
      ],
      [
        budget,
        'ownerBytes',
        jsonBytes(
          { agent, turn, step, root },
          budget.limits,
          budget.limits.ownerBytes,
        ),
      ],
    ])
    this.steps.set(key, { root, release, agent })
  }
  finishOwner(root: KimiRoot) {
    for (const [id, step] of this.steps)
      if (
        step.root.operationId === root.operationId &&
        step.root.childId === root.childId
      ) {
        step.release()
        this.steps.delete(id)
      }
  }
  async engineDelta(frame: KimiFrame, root: KimiRoot) {
    const limits = this.records.budget.limits,
      agent = boundedString(
        frame.payload.agentId ?? 'main',
        limits.nativeIdBytes,
      ),
      text = boundedString(frame.payload.delta, limits.retainedItemBytes, true),
      kind = frame.type === 'thinking.delta' ? 'thinking' : 'text',
      key = digest(['engine-content', agent, root, kind]),
      previous = this.items.get(key),
      before = String(previous?.native.text ?? '')
    if (
      Buffer.byteLength(before) + Buffer.byteLength(text) >
      limits.retainedItemBytes
    )
      throw new KimiError('kimi_item_bytes')
    const release = this.records.retainItem(
      Buffer.byteLength(before) + Buffer.byteLength(text) + 256,
      false,
    )
    let committed = false
    try {
      const native = { kind, text: before + text },
        entry = record(
          this.records.scope,
          'live-engine',
          [frame.epoch, frame.seq, 'content'],
          'projection.item',
          { native, itemId: key },
          root,
          agent,
        )
      await this.records.commit(
        ['engine-content', frame.epoch, frame.seq],
        [
          entry,
          record(
            this.records.scope,
            'local',
            ['engine-content', frame.epoch, frame.seq, 'snapshot'],
            'projection.snapshot',
            {
              visibleItemIds: [...this.items.entries()]
                .filter(([id]) => id !== key)
                .map(([, item]) => item.recordId)
                .concat(entry.recordId),
              removedItemIds: [],
              unavailableItemIds: [],
            },
          ),
        ],
        [
          {
            ...root,
            runtimeGeneration: this.records.scope.runtimeGeneration,
            deliveryId: '',
            itemId: key,
            type: kind === 'thinking' ? 'thought_delta' : 'text_delta',
            text,
          },
        ],
      )
      this.items.set(key, {
        agent,
        native,
        root,
        recordId: entry.recordId,
        itemId: key,
        release,
      })
      previous?.release()
      committed = true
    } finally {
      if (!committed) release()
    }
  }
  async apply(frame: KimiFrame) {
    const payload = frame.payload,
      limits = this.records.budget.limits
    if (
      !Array.isArray(payload.ops) ||
      payload.ops.length > limits.transcriptBatchOps
    )
      throw new KimiError('kimi_transcript_ops_limit')
    const payloadBytes = jsonBytes(payload, limits, limits.replayBytes)
    const freeWork = reserveAll([
      [
        this.records.budget,
        'retainedBytes',
        payloadBytes * 2 + this.items.size * 128,
      ],
      [
        this.records.host.budget,
        'hostRetainedBytes',
        payloadBytes * 2 + this.items.size * 128,
      ],
    ])
    try {
      await this.applyReserved(frame)
    } finally {
      freeWork()
    }
  }
  private async applyReserved(frame: KimiFrame) {
    const payload = frame.payload,
      limits = this.records.budget.limits
    const agent = boundedString(payload.agent_id, limits.nativeIdBytes)
    const next = sequence(payload.seq),
      current = this.records.checkpoint.transcripts[agent] ?? 0
    const duplicateKey = digest([
        this.records.checkpoint.transcriptStores?.[agent],
        agent,
        next,
      ]),
      hash = digest({ seq: next, ops: payload.ops })
    if (next <= current) {
      const previous = this.duplicates.get(duplicateKey)
      if (!previous) throw new KimiError('kimi_transcript_duplicate_unproved')
      if (previous.hash !== hash)
        throw new KimiError('kimi_transcript_duplicate_conflict')
      return
    }
    if (next !== current + 1) throw new KimiError('kimi_transcript_gap')
    if (
      !Array.isArray(payload.ops) ||
      payload.ops.length > limits.transcriptBatchOps
    )
      throw new KimiError('kimi_transcript_ops_limit')
    jsonBytes(payload.ops, limits, limits.replayBytes)
    const entries: KimiNativeRecord[] = [],
      events: HarnessEvent[] = []
    const staged = new Map(this.items),
      fresh: Item[] = [],
      removedRoots = new Map<string, KimiRoot>(),
      resets = new Map<string, unknown>()
    const removedIds = new Set<string>(),
      unavailableIds = new Set<string>()
    const materialize = (item: Omit<Item, 'release' | 'recordId'>) => {
      const value = record(
        this.records.scope,
        item.root ? 'live-projection' : 'cold-import',
        [this.baselines.get(item.agent), item.agent, item.itemId],
        'projection.item',
        {
          native: item.native,
          turnId: item.turnId,
          stepId: item.stepId,
          itemId: item.itemId,
        },
        item.root,
        item.agent,
      )
      entries.push({ ...value, providerItemId: item.itemId })
      return value.recordId
    }
    const replace = (
      key: string,
      build: () => Omit<Item, 'release' | 'recordId'>,
      size: number,
      tool = false,
    ) => {
      const release = this.records.retainItem(size, tool)
      try {
        const item = build(),
          next = { ...item, recordId: materialize(item), release }
        fresh.push(next)
        staged.set(key, next)
      } catch (error) {
        release()
        throw error
      }
    }
    let committed = false,
      freeDuplicate = () => {}
    try {
      for (const [index, value] of payload.ops.entries()) {
        const op = object(value),
          kind = boundedString(op.op, limits.nativeIdBytes)
        const known = [
          'reset',
          'turn.upsert',
          'step.upsert',
          'frame.upsert',
          'append',
          'marker.upsert',
          'taskref.upsert',
          'task.upsert',
          'interaction.upsert',
          'attachment.upsert',
          'todo.upsert',
          'prompt.upsert',
          'meta.merge',
          'items.remove',
        ]
        if (!known.includes(kind))
          throw new KimiError('kimi_transcript_operation_unsupported')
        const key = [this.baselines.get(agent), agent, next, index]
        entries.push(
          record(
            this.records.scope,
            'live-projection',
            key,
            kind,
            op,
            undefined,
            agent,
          ),
        )
        if (kind === 'items.remove') {
          if (!Array.isArray(op.ids)) throw new KimiError('kimi_removal_ids')
          const ids = new Set(
              op.ids.map((id) => boundedString(id, limits.nativeIdBytes)),
            ),
            removedItemIds: string[] = []
          const tools = new Set<string>()
          for (let pass = 0; pass <= staged.size; pass++) {
            let changed = false
            for (const item of staged.values()) {
              if (item.agent !== agent) continue
              const id = String(nativeEntityId(item.native))
              if (
                ids.has(id) ||
                (item.turnId && ids.has(item.turnId)) ||
                (item.stepId && ids.has(item.stepId)) ||
                (typeof item.native.toolCallId === 'string' &&
                  tools.has(item.native.toolCallId))
              ) {
                if (!ids.has(id)) {
                  ids.add(id)
                  changed = true
                }
                if (
                  typeof item.native.toolCallId === 'string' &&
                  !tools.has(item.native.toolCallId)
                ) {
                  tools.add(item.native.toolCallId)
                  changed = true
                }
                for (const reference of [
                  ...(Array.isArray(item.native.attachmentIds)
                    ? item.native.attachmentIds
                    : []),
                  item.native.approvalId,
                ].filter((value) => typeof value === 'string'))
                  if (!ids.has(reference as string)) {
                    ids.add(reference as string)
                    changed = true
                  }
              }
            }
            if (!changed) break
          }
          for (const [key, item] of staged)
            if (
              item.agent === agent &&
              (ids.has(String(nativeEntityId(item.native))) ||
                (item.turnId && ids.has(item.turnId)) ||
                (item.stepId && ids.has(item.stepId)))
            ) {
              // Original callbacks expire before storage or render replacement begins.
              if (item.root) removedRoots.set(digest(item.root), item.root)
              removedItemIds.push(item.recordId)
              removedIds.add(item.recordId)
              staged.delete(key)
            }
          entries.push(
            record(
              this.records.scope,
              'live-projection',
              [key, 'removal'],
              'projection.removal',
              {
                removedItemIds,
                unavailableItemIds: [],
                visibleItemIds: [...staged.values()].map(
                  (item) => item.recordId,
                ),
              },
            ),
          )
          continue
        }
        if (kind === 'reset') {
          object(op.snapshot)
          resets.set(agent, op.snapshot)
          for (const [key, item] of staged)
            if (item.agent === agent) {
              unavailableIds.add(item.recordId)
              if (item.root) removedRoots.set(digest(item.root), item.root)
              staged.delete(key)
            }
          for (const value of this.snapshotEntities(object(op.snapshot))) {
            const id = boundedString(
                value.native[entityIdFields[value.field]],
                limits.nativeIdBytes,
              ),
              key = digest([agent, id]),
              size = jsonBytes(value.native, limits, limits.retainedItemBytes),
              release = this.records.retainItem(
                size,
                value.native.kind === 'tool',
              )
            try {
              const item = {
                  agent,
                  native: structuredClone(value.native),
                  turnId: value.turnId,
                  stepId: value.stepId,
                  itemId: digest([
                    agent,
                    this.records.checkpoint.transcriptStores?.[agent],
                    next,
                    'reset',
                    value.field,
                    id,
                  ]),
                },
                installed = { ...item, recordId: materialize(item), release }
              fresh.push(installed)
              staged.set(key, installed)
            } catch (error) {
              release()
              throw error
            }
          }
          continue
        }
        if (kind === 'append') {
          const target = object(op.target),
            id = boundedString(
              target.type === 'frame' ? target.frameId : target.taskId,
              limits.nativeIdBytes,
            )
          if (target.type !== 'frame' && target.type !== 'task')
            throw new KimiError('kimi_append_target')
          const key = digest([agent, id])
          let item = staged.get(key)
          if (!item && target.type === 'task') {
            const native = {
                taskId: id,
                kind: 'other',
                state: 'running',
                detached: false,
                outputTail: '',
              },
              nextItem = {
                agent,
                native,
                itemId: digest([this.baselines.get(agent), agent, 'task', id]),
              }
            replace(
              key,
              () => nextItem,
              jsonBytes(native, limits, limits.retainedItemBytes),
            )
            item = staged.get(key)
          }
          if (!item) throw new KimiError('kimi_append_target')
          const text = boundedString(op.text, limits.retainedItemBytes, true),
            offset = sequence(op.offset)
          const field = target.type === 'task' ? 'outputTail' : 'text'
          if (
            target.type === 'frame' &&
            !['text', 'thinking'].includes(String(item.native.kind))
          )
            throw new KimiError('kimi_append_target')
          const current =
            typeof item.native[field] === 'string'
              ? (item.native[field] as string)
              : ''
          if (offset > current.length) throw new KimiError('kimi_append_offset')
          const overlap = Math.min(current.length - offset, text.length)
          if (
            current.slice(offset, offset + overlap) !== text.slice(0, overlap)
          )
            throw new KimiError('kimi_append_offset')
          const suffix = text.slice(overlap)
          if (!suffix) continue
          if (
            Buffer.byteLength(current) + Buffer.byteLength(suffix) >
            limits.retainedItemBytes
          )
            throw new KimiError('kimi_item_bytes')
          const original = item,
            size =
              jsonBytes(item.native, limits, limits.retainedItemBytes) +
              jsonBytes(suffix, limits, limits.retainedItemBytes) -
              2
          if (size > limits.retainedItemBytes)
            throw new KimiError('kimi_item_bytes')
          replace(
            key,
            () => ({
              ...original,
              native: { ...original.native, [field]: current + suffix },
            }),
            size,
          )
          if (item.root && target.type === 'frame')
            events.push({
              ...item.root,
              runtimeGeneration: this.records.scope.runtimeGeneration,
              deliveryId: '',
              itemId: item.itemId,
              type:
                item.native.kind === 'thinking'
                  ? 'thought_delta'
                  : 'text_delta',
              text: suffix,
            })
          continue
        }
        const field = kind.split('.')[0]
        const native =
          op[field] ??
          (field === 'marker' || field === 'taskref' ? op.item : undefined)
        if (!native || typeof native !== 'object') continue
        const entity = object(native),
          id = boundedString(
            entity[entityIdFields[field] ?? 'id'],
            limits.nativeIdBytes,
          )
        const turnId =
          typeof op.turnId === 'string'
            ? op.turnId
            : field === 'turn'
              ? id
              : undefined
        const stepId = typeof op.stepId === 'string' ? op.stepId : undefined
        // Display turn/step IDs also name cold history. Only a native call identity joins an owner.
        let root =
          ((field === 'frame' && entity.kind === 'tool') ||
            (field === 'interaction' && entity.toolCallId !== undefined)) &&
          !resets.has(agent)
            ? this.toolRoot(
                agent,
                boundedString(entity.toolCallId, limits.nativeIdBytes),
              )
            : undefined
        if (field === 'todo' && !resets.has(agent)) {
          const owners = [...staged.values()]
            .filter(
              (item) =>
                item.agent === agent &&
                item.native.kind === 'tool' &&
                item.native.todoId === id &&
                item.root,
            )
            .map((item) => item.root!)
          if (
            owners.length &&
            owners.every((owner) => digest(owner) === digest(owners[0]))
          )
            root = owners[0]
        }
        const itemKey = digest([agent, id]),
          previous = staged.get(itemKey)
        if (previous?.root && root?.operationId !== previous.root.operationId)
          continue
        if (field === 'frame' && entity.kind === 'tool')
          for (const key of ['input', 'inputText', 'output', 'display'])
            if (entity[key] !== undefined) {
              if (typeof entity[key] === 'string')
                boundedString(entity[key], limits.toolValueBytes, true)
              else jsonBytes(entity[key], limits, limits.toolValueBytes)
            }
        const size = jsonBytes(entity, limits, limits.retainedItemBytes)
        const itemId =
          previous?.itemId ??
          digest([
            this.records.scope.binding,
            this.records.scope.runtimeGeneration,
            this.baselines.get(agent),
            agent,
            field,
            id,
            root?.operationId,
          ])
        if (
          field === 'turn' &&
          !staged.has(itemKey) &&
          [...staged.values()].filter(
            (item) => item.native.turnId !== undefined,
          ).length >= limits.retainedTurns
        )
          throw new KimiError('kimi_retained_turns_limit')
        replace(
          itemKey,
          () => ({
            agent,
            native: structuredClone(entity),
            turnId,
            stepId,
            root,
            itemId,
          }),
          size,
          entity.kind === 'tool',
        )
        if (root && field === 'frame') {
          const base = {
            ...root,
            runtimeGeneration: this.records.scope.runtimeGeneration,
            deliveryId: '',
            itemId,
          }
          if (entity.kind === 'text' || entity.kind === 'thinking') {
            const text = boundedString(
              entity.text,
              limits.retainedItemBytes,
              true,
            )
            events.push(
              entity.kind === 'thinking'
                ? {
                    ...base,
                    type: 'content_snapshot',
                    contentType: 'thought',
                    text,
                  }
                : {
                    ...base,
                    type: 'content_snapshot',
                    contentType: 'text',
                    text,
                    ...(entity.role === 'user' ? { role: 'user' } : {}),
                  },
            )
          } else if (entity.kind === 'tool') {
            const tool = boundedString(entity.toolCallId, limits.nativeIdBytes)
            if (!previous)
              events.push({
                ...base,
                type: 'tool_started',
                toolCallId: tool,
                name: boundedString(entity.name, limits.nativeIdBytes),
                input: entity.input,
              })
            events.push({
              ...base,
              type: 'tool_update',
              toolCallId: tool,
              status: boundedString(entity.state, limits.nativeIdBytes),
              output: entity.output,
            })
          } else if (entity.kind === 'notice') {
            if (!['info', 'warning', 'error'].includes(String(entity.level)))
              throw new KimiError('kimi_notice_level')
            events.push(
              this.records.diagnostic(
                root,
                itemId,
                entity.message,
                entity.level as 'info' | 'warning' | 'error',
                typeof entity.source === 'string'
                  ? entity.source
                  : 'kimi_native_notice',
                entity.detail,
              ),
            )
          }
        }
        if (root && field === 'todo') {
          if (
            !Array.isArray(entity.items) ||
            entity.items.length > limits.retainedItems
          )
            throw new KimiError('kimi_todo_items')
          const statuses = {
            pending: 'pending',
            in_progress: 'running',
            done: 'completed',
          } as const
          const steps = entity.items.map((value, index) => {
            const item = object(value),
              status = statuses[item.status as keyof typeof statuses]
            if (!status) throw new KimiError('kimi_todo_status')
            return {
              id: digest([agent, id, index]),
              title: boundedString(item.title, limits.retainedItemBytes, true),
              status,
            }
          })
          events.push({
            runId: root.runId,
            turnId: root.turnId,
            ...(root.childId ? { childId: root.childId } : {}),
            runtimeGeneration: this.records.scope.runtimeGeneration,
            deliveryId: '',
            itemId,
            type: 'plan',
            steps,
          })
        }
      }
      entries.push(
        record(
          this.records.scope,
          'live-projection',
          [agent, next, 'snapshot'],
          'projection.snapshot',
          {
            visibleItemIds: [...staged.values()].map((item) => item.recordId),
            removedItemIds: [...removedIds],
            unavailableItemIds: [...unavailableIds],
          },
          undefined,
          agent,
        ),
      )
      this.records.preflight(entries, events)
      while (
        this.duplicates.size &&
        (this.records.budget.count('duplicateEntries') >=
          limits.duplicateEntries ||
          this.records.budget.count('duplicateBytes') + 128 >
            limits.duplicateBytes)
      ) {
        const key = this.duplicates.keys().next().value!
        this.duplicates.get(key)!.release()
        this.duplicates.delete(key)
      }
      freeDuplicate = reserveAll([
        [this.records.budget, 'duplicateEntries'],
        [this.records.budget, 'duplicateBytes', 128],
        [this.records.host.budget, 'hostRetainedBytes', 128],
      ])
      for (const root of removedRoots.values()) await this.removeRequests(root)
      await this.records.commit(
        [
          'transcript',
          this.records.checkpoint.transcriptStores?.[agent] ?? null,
          agent,
          next,
        ],
        entries,
        events,
        {
          ...this.records.checkpoint,
          transcripts: {
            ...this.records.checkpoint.transcripts,
            [agent]: next,
          },
        },
      )
      if (!this.records.accepting)
        throw new KimiError('kimi_generation_retired')
      for (const [key, old] of this.items)
        if (staged.get(key) !== old) old.release()
      const retained = new Set(staged.values())
      for (const item of fresh) if (!retained.has(item)) item.release()
      this.items = staged
      for (const [agent, snapshot] of resets) this.setBaseline(agent, snapshot)
      this.duplicates.set(duplicateKey, { hash, release: freeDuplicate })
      committed = true
    } finally {
      if (!committed) {
        freeDuplicate()
        for (const item of fresh) item.release()
      }
    }
  }
  async unavailable(payload: unknown) {
    const ids = [...this.items.values()].map((item) => item.recordId)
    for (const item of this.items.values())
      if (item.root) await this.removeRequests(item.root)
    await this.records.commit(
      ['splice', digest(payload)],
      [
        record(
          this.records.scope,
          'local',
          ['splice', digest(payload)],
          'projection.unavailable',
          {
            visibleItemIds: [],
            removedItemIds: [],
            unavailableItemIds: ids,
            evidence: payload,
          },
        ),
      ],
    )
  }
  async replaceRoot(
    root: KimiRoot,
    providerTurn: string,
    entries: readonly KimiNativeRecord[],
    events: readonly HarnessEvent[],
    end = Infinity,
  ) {
    if (performance.now() >= end) throw new KimiError('kimi_history_deadline')
    const removed = [...this.items.entries()].filter(
      ([, item]) =>
        item.root?.operationId === root.operationId &&
        item.root?.childId === root.childId,
    )
    const old = new Set(removed.map(([, item]) => item.recordId))
    const fresh: Item[] = []
    try {
      for (const entry of entries)
        fresh.push({
          agent: 'main',
          native: { id: entry.recordId, kind: entry.kind },
          turnId: `t${providerTurn}`,
          root,
          recordId: entry.recordId,
          itemId: entry.recordId,
          release: this.records.retainItem(
            jsonBytes(
              entry,
              this.records.budget.limits,
              this.records.budget.limits.retainedItemBytes,
            ),
            false,
          ),
        })
      await this.records.commit(
        [root.operationId, 'final-projection'],
        [
          ...entries,
          record(
            this.records.scope,
            'local',
            [root.operationId, 'final-projection'],
            'projection.snapshot',
            {
              visibleItemIds: [...this.items.values()]
                .filter((item) => !old.has(item.recordId))
                .map((item) => item.recordId)
                .concat(fresh.map((item) => item.recordId)),
              removedItemIds: [...old],
              unavailableItemIds: [],
            },
            root,
            'main',
          ),
        ],
        events,
        undefined,
        false,
        end,
      )
      for (const [key, item] of removed) {
        this.items.delete(key)
        item.release()
      }
      for (const item of fresh)
        this.items.set(digest(['final', item.recordId]), item)
    } catch (error) {
      for (const item of fresh) item.release()
      throw error
    }
  }
  close() {
    for (const item of this.items.values()) item.release()
    this.items.clear()
    for (const step of this.steps.values()) step.release()
    this.steps.clear()
    for (const entry of this.duplicates.values()) entry.release()
    this.duplicates.clear()
  }
}
