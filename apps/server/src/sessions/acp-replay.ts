import type { DatabaseSync } from 'node:sqlite'
import type {
  AcpReplayOwner,
  DurableAcpRecord,
} from '../harnesses/acp/ingestion.js'
import { digest } from '../harnesses/acp/data.js'
import { appendMessageInTransaction } from '../db/queries.js'
import { nativeItem } from './native.js'

/** Import groups are local UI identities. They do not claim historical native roots. */
export function projectAcpReplay(db: DatabaseSync, owner: AcpReplayOwner) {
  const params = [owner.sessionId, owner.loadId, owner.runtimeGeneration]
  const where =
    "session_id=? AND json_extract(value,'$.owner.loadId')=? AND json_extract(value,'$.owner.runtimeGeneration')=? AND json_extract(value,'$.value.kind')='replay'"
  const size = db
    .prepare(
      `SELECT count(*) AS count,coalesce(sum(length(CAST(value AS BLOB))),0) AS bytes FROM acp_records WHERE ${where}`,
    )
    .get(...params) as { count: number; bytes: number }
  if (size.count > 8192 || size.bytes > 32 * 1024 * 1024)
    throw Error('ACP replay projection exceeds limit')
  const records = (
    db
      .prepare(
        `SELECT value FROM acp_records WHERE ${where} ORDER BY admission_ordinal,record_index`,
      )
      .all(...params) as { value: string }[]
  ).map((row) => JSON.parse(row.value) as DurableAcpRecord)
  const names = new Map<string, string>()
  const localName = (value: string) => {
    let name = names.get(value)
    if (!name) {
      name = `item-${names.size}`
      names.set(value, name)
    }
    return name
  }
  const normalized = (value: unknown, key = '', depth = 0): unknown => {
    if (
      depth === 1 &&
      typeof value === 'string' &&
      ['itemId', 'responseId'].includes(key)
    )
      return localName(value)
    if (Array.isArray(value))
      return value.map((item) => normalized(item, '', depth + 1))
    if (!value || typeof value !== 'object') return value
    const object = value as Record<string, unknown>
    return Object.fromEntries(
      Object.entries(object).map(([key, value]) => [
        key,
        key === 'artifactId' && typeof object.sha256 === 'string'
          ? `sha256:${object.sha256}`
          : normalized(value, key, depth + 1),
      ]),
    )
  }
  const fingerprint = digest(
    records.map((record) =>
      digest(
        normalized(
          record.value.kind === 'replay' ? record.value.event : record.value,
        ),
      ),
    ),
  )
  const binding = digest(owner.binding)
  if (
    db
      .prepare(
        'SELECT 1 FROM acp_replay_snapshots WHERE session_id=? AND binding_hash=? AND fingerprint=?',
      )
      .get(owner.sessionId, binding, fingerprint)
  )
    return []
  const turnId = `acp-import:${digest([binding, fingerprint])}`
  db.prepare('INSERT INTO acp_replay_snapshots VALUES (?,?,?,?,?)').run(
    owner.sessionId,
    binding,
    fingerprint,
    owner.loadId,
    turnId,
  )
  const saved: ReturnType<typeof appendMessageInTransaction>[] = []
  const nativeGroups = new Map<string, DurableAcpRecord[]>()
  const nativeKey = (record: DurableAcpRecord) => {
    if (record.value.kind !== 'replay') return undefined
    const event = record.value.event
    const scope = [
      record.subject.childId ?? null,
      record.subject.intervalId ?? null,
    ]
    if (event.type === 'tool_started' || event.type === 'tool_update')
      return JSON.stringify(['tool', event.toolCallId, ...scope])
    if ('providerItemId' in event && typeof event.providerItemId === 'string')
      return JSON.stringify(['item', event.providerItemId, ...scope])
    return undefined
  }
  for (const record of records) {
    const key = nativeKey(record)
    if (key) {
      const group = nativeGroups.get(key) ?? []
      group.push(record)
      nativeGroups.set(key, group)
    }
  }
  const groupSignature = (group: DurableAcpRecord[]) =>
    digest(
      group.map((record) => {
        if (record.value.kind !== 'replay' && record.value.kind !== 'event')
          throw Error('Invalid replay group')
        const {
          itemId: _item,
          responseId: _response,
          runId: _run,
          turnId: _turn,
          runtimeGeneration: _generation,
          deliveryId: _delivery,
          ...body
        } = record.value.event as Record<string, unknown>
        return digest(normalized(body))
      }),
    )
  let liveBytes = 0,
    liveCount = 0
  for (const [key, group] of nativeGroups) {
    const signature = groupSignature(group)
    /* Native identity is used only with matching durable live records and message proof. */
    const [kind, id, child, interval] = JSON.parse(key) as [
      string,
      string,
      string | null,
      string | null,
    ]
    const liveWhere =
      "session_id=? AND json_extract(value,'$.owner.phase')='live' AND json_extract(value,'$.value.kind')='event' AND json_extract(value,'$.owner.binding.provider')=? AND json_extract(value,'$.owner.binding.providerSessionId')=? AND json_extract(value,'$.owner.binding.cwd')=? AND json_extract(value,'$.owner.binding.accountId') IS ? AND json_extract(value,'$.subject.childId') IS ? AND json_extract(value,'$.subject.intervalId') IS ? AND json_extract(value,?)=?"
    const liveParams = [
      owner.sessionId,
      owner.binding.provider,
      owner.binding.providerSessionId,
      owner.binding.cwd,
      owner.binding.accountId,
      child,
      interval,
      kind === 'tool'
        ? '$.value.event.toolCallId'
        : '$.value.event.providerItemId',
      id,
    ]
    const liveSize = db
      .prepare(
        `SELECT count(*) AS count,coalesce(sum(length(CAST(value AS BLOB))),0) AS bytes FROM acp_records WHERE ${liveWhere}`,
      )
      .get(...liveParams) as { count: number; bytes: number }
    liveBytes += liveSize.bytes
    liveCount += liveSize.count
    if (liveBytes > 32 * 1024 * 1024 || liveCount > 8192)
      throw Error('ACP live replay proof exceeds limit')
    const live = (
      db
        .prepare(
          `SELECT value FROM acp_records WHERE ${liveWhere} ORDER BY admission_ordinal,record_index`,
        )
        .all(...liveParams) as { value: string }[]
    ).map((row) => JSON.parse(row.value) as DurableAcpRecord)
    let proved: { turnId: string; itemId: string } | undefined
    if (live.length) {
      const first = live[0]!
      if (
        first.owner.phase !== 'live' ||
        first.value.kind !== 'event' ||
        !('itemId' in first.value.event)
      )
        throw Error('Invalid ACP live item proof')
      const turnId = first.owner.turnId,
        itemId = String(first.value.event.itemId)
      const expected = live
        .map((record) => {
          if (
            record.owner.phase !== 'live' ||
            record.owner.turnId !== turnId ||
            record.value.kind !== 'event' ||
            !('itemId' in record.value.event) ||
            record.value.event.itemId !== itemId
          )
            throw Error('Ambiguous ACP live native identity')
          const content = nativeItem(record.value.event)
          if (!content) return undefined
          const { itemId: _item, turnId: _turn, ...body } = content
          return digest(JSON.parse(JSON.stringify(body)))
        })
        .filter((value): value is string => value !== undefined)
      const messageSize = db
        .prepare(
          'SELECT count(*) AS count,coalesce(sum(length(CAST(content AS BLOB))),0) AS bytes FROM messages WHERE session_id=? AND turn_id=? AND item_id=?',
        )
        .get(owner.sessionId, turnId, itemId) as {
        count: number
        bytes: number
      }
      liveBytes += messageSize.bytes
      liveCount += messageSize.count
      if (liveBytes > 32 * 1024 * 1024 || liveCount > 8192)
        throw Error('ACP live message proof exceeds limit')
      const rows = db
        .prepare(
          'SELECT content FROM messages WHERE session_id=? AND turn_id=? AND item_id=? ORDER BY seq',
        )
        .all(owner.sessionId, turnId, itemId) as { content: string }[]
      const counts = new Map<string, number>()
      for (const row of rows) {
        const hash = digest(JSON.parse(row.content))
        counts.set(hash, (counts.get(hash) ?? 0) + 1)
      }
      if (
        expected.every((hash) => {
          const count = counts.get(hash) ?? 0
          if (!count) return false
          counts.set(hash, count - 1)
          return true
        })
      )
        proved = { turnId, itemId }
      if (proved && groupSignature(live) === signature) continue
    }
    /* replay-only fingerprints do not substitute for committed live message proof. */
    const old = db
      .prepare(
        'SELECT fingerprint FROM acp_replay_native_items WHERE session_id=? AND binding_hash=? AND native_key=?',
      )
      .get(owner.sessionId, binding, key) as { fingerprint: string } | undefined
    if (old?.fingerprint === signature) continue
    const nativeTurn = proved?.turnId ?? `acp-import-native:${binding}`,
      nativeItemId = proved?.itemId ?? `acp-native:${digest([binding, key])}`
    const channels = new Map<string, string>()
    const roles = new Map<string, 'user' | 'agent'>()
    const snapshots = new Map<string, Record<string, unknown>>()
    for (const record of group) {
      if (record.value.kind !== 'replay') continue
      const event = record.value.event
      if (event.type === 'text_delta' || event.type === 'thought_delta') {
        const channel = event.type === 'text_delta' ? 'text' : 'thought'
        channels.set(channel, (channels.get(channel) ?? '') + event.text)
        continue
      }
      if (event.type === 'content_snapshot') {
        channels.set(event.contentType, event.text)
        roles.set(
          event.contentType,
          event.contentType === 'text' && event.role === 'user'
            ? 'user'
            : 'agent',
        )
        snapshots.set(event.contentType, event)
        continue
      }
      const projected = nativeItem({ ...event, turnId: nativeTurn })
      const content = projected
        ? (({ itemId: _item, turnId: _turn, ...body }) => body)(projected)
        : undefined
      if (content)
        saved.push(
          appendMessageInTransaction(db, {
            sessionId: owner.sessionId,
            turnId: nativeTurn,
            itemId: nativeItemId,
            role: 'agent',
            type: content.type,
            content,
          }),
        )
    }
    for (const [contentType, text] of channels)
      saved.push(
        appendMessageInTransaction(db, {
          sessionId: owner.sessionId,
          turnId: nativeTurn,
          itemId: nativeItemId,
          role: roles.get(contentType) ?? 'agent',
          type: 'content_snapshot',
          content: {
            ...(({ itemId: _item, turnId: _turn, ...body }) => body)(
              snapshots.get(contentType) ?? {},
            ),
            ...(group[0]!.subject.childId
              ? { childId: group[0]!.subject.childId }
              : {}),
            type: 'content_snapshot',
            contentType,
            text,
            ...(contentType === 'text'
              ? {
                  role:
                    roles.get(contentType) === 'user' ? 'user' : 'assistant',
                }
              : {}),
            imported: { kind: 'acp-native-item', loadId: owner.loadId },
          },
        }),
      )
    db.prepare(
      'INSERT INTO acp_replay_native_items VALUES (?,?,?,?) ON CONFLICT(session_id,binding_hash,native_key) DO UPDATE SET fingerprint=excluded.fingerprint',
    ).run(owner.sessionId, binding, key, signature)
  }
  for (const [index, record] of records.entries()) {
    if (record.value.kind !== 'replay') continue
    if (nativeKey(record)) continue
    const event = record.value.event
    const content = nativeItem({ ...event, turnId })
    if (!content) continue
    saved.push(
      appendMessageInTransaction(db, {
        sessionId: owner.sessionId,
        turnId,
        itemId: `${turnId}:${'itemId' in event ? localName(String(event.itemId)) : index}`,
        role:
          event.type === 'content_snapshot' &&
          event.contentType === 'text' &&
          event.role === 'user'
            ? 'user'
            : 'agent',
        type: content.type,
        content: {
          ...(({ itemId: _item, turnId: _turn, ...body }) => body)(content),
          imported: {
            kind: 'acp-load-snapshot',
            loadId: owner.loadId,
            providerSessionId: owner.requestedNativeSessionId,
          },
        },
      }),
    )
  }
  return saved
}
