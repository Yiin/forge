import { closeNativeDiscovery, NativeCleanupError } from '../native-cleanup.js'
import { randomUUID, createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import type { ConfirmedNativeBinding, HarnessEvent } from '../types.js'
import { captureAuthority, effectiveAuthority } from './authority.js'
import {
  KimiBudget,
  KimiError,
  boundedString,
  deadline,
  jsonBytes,
  sequence,
  reserveAll,
} from './limits.js'
import { hostOwner, type KimiHostOwner, type KimiLease } from './host.js'
import { KimiRecords, digest, record } from './records.js'
import { object, type KimiOwnedBytes } from './transport.js'
import type {
  KimiAttachmentSink,
  KimiCatalog,
  KimiHistoryCursor,
  KimiHost,
  KimiImportScope,
  KimiLaunchAuthority,
  KimiMessageCursor,
  KimiNativeRecord,
  KimiRecordSink,
  KimiRoot,
  KimiStateReader,
} from './types.js'

export function checkHistoryDeadline(end: number) {
  if (performance.now() >= end) throw new KimiError('kimi_history_deadline')
}
/** Encoded transform values and their canonical strings coexist with the owned page. */
export function reserveHistoryTransform(
  records: KimiRecords,
  valueBytes: number,
  metadataBytes = 0,
) {
  const bytes = 2 * (valueBytes + metadataBytes)
  return reserveAll([
    [records.budget, 'retainedBytes', bytes],
    [records.host.budget, 'hostRetainedBytes', bytes],
  ])
}
/** The returned lease owns the page through transforms and durable admission. */
export async function readHistoryPage(
  lease: KimiLease,
  host: KimiHostOwner,
  budget: KimiBudget,
  path: string,
  signal: AbortSignal,
  end: number,
  read?: (path: string, maximum: number) => Promise<unknown>,
) {
  checkHistoryDeadline(end)
  const maximum = Math.min(
    budget.limits.httpJsonBytes,
    budget.limits.retainedBytes - budget.count('retainedBytes'),
  )
  if (maximum < 1) throw new KimiError('kimi_history_limit')
  let release = reserveAll([
    [budget, 'retainedBytes', maximum],
    [host.budget, 'hostRetainedBytes', maximum],
  ])
  let transferred = false
  const physical = host.track(
    Promise.resolve().then(() =>
      read
        ? read(path, maximum)
        : lease.server.http(lease.lane, path, { maxBytes: maximum, signal }),
    ),
  )
  try {
    const value = object(
      await deadline(
        physical,
        Math.max(1, end - performance.now()),
        signal,
        budget,
        host.budget,
      ),
    )
    checkHistoryDeadline(end)
    const bytes = jsonBytes(value, budget.limits, maximum)
    release()
    release = reserveAll([
      [budget, 'retainedBytes', bytes],
      [host.budget, 'hostRetainedBytes', bytes],
    ])
    transferred = true
    return { value, bytes, release }
  } finally {
    if (!transferred) void physical.finally(() => release()).catch(() => {})
  }
}

export async function readCatalog(
  lease: KimiLease,
  budget: KimiBudget,
  signal: AbortSignal,
): Promise<{ catalog: KimiCatalog; release: () => void }> {
  const limits = budget.limits
  let release = reserveAll([
    [budget, 'retainedBytes', limits.modelCatalogBytes * 3],
    [
      lease.server.hostBudget,
      'hostRetainedBytes',
      limits.modelCatalogBytes * 3,
    ],
  ])
  let transferred = false
  try {
    const result = object(
      await lease.server.http(lease.lane, '/api/v1/models', { signal }),
    )
    jsonBytes(result, limits, limits.modelCatalogBytes)
    if (!Array.isArray(result.items) || result.items.length > limits.models)
      throw new KimiError('kimi_catalog_limit')
    const models = result.items.map((value) => {
      const item = object(value),
        contextWindow = sequence(item.max_context_size)
      if (!contextWindow) throw new KimiError('kimi_catalog_context')
      const strings = (value: unknown) => {
        if (value === undefined) return undefined
        if (!Array.isArray(value) || value.length > limits.models)
          throw new KimiError('kimi_catalog_values')
        return value.map((value) => boundedString(value, limits.modelIdBytes))
      }
      return {
        id: boundedString(item.model, limits.modelIdBytes),
        provider: boundedString(item.provider, limits.modelIdBytes),
        contextWindow,
        ...(item.display_name
          ? {
              displayName: boundedString(
                item.display_name,
                limits.modelIdBytes,
              ),
            }
          : {}),
        capabilities: strings(item.capabilities),
        efforts: strings(item.support_efforts),
        ...(item.default_effort
          ? {
              defaultEffort: boundedString(
                item.default_effort,
                limits.modelIdBytes,
              ),
            }
          : {}),
      }
    })
    if (new Set(models.map((model) => model.id)).size !== models.length)
      throw new KimiError('kimi_catalog_duplicate')
    const config = object(
      await lease.server.http(lease.lane, '/api/v1/config', { signal }),
    )
    const defaultModel =
      typeof config.default_model === 'string' &&
      models.some((model) => model.id === config.default_model)
        ? config.default_model
        : undefined
    const defaultEffort =
      typeof config.thinking === 'string'
        ? config.thinking
        : models.find((model) => model.id === defaultModel)?.defaultEffort
    const catalog: KimiCatalog = Object.freeze({
      version: '0.34.0',
      models,
      defaultModel,
      defaultEffort,
      commands: {
        status: 'unsupported' as const,
        reason: 'Kimi 0.34.0 has no complete command catalog',
      },
    })
    const bytes = jsonBytes(catalog, limits, limits.modelCatalogBytes)
    release()
    release = reserveAll([
      [budget, 'retainedBytes', bytes],
      [lease.server.hostBudget, 'hostRetainedBytes', bytes],
    ])
    transferred = true
    return { catalog, release }
  } finally {
    if (!transferred) release()
  }
}
export async function discoverKimi(options: {
  authority: KimiLaunchAuthority
  host: KimiHost
  signal: AbortSignal
}): Promise<KimiCatalog> {
  const host = hostOwner(options.host),
    authority = captureAuthority(options.authority, host.budget.limits)
  const effective = await effectiveAuthority(authority)
  options.signal.throwIfAborted()
  const lease = await host.acquire(effective, 'helper').catch((error) => {
    if (
      error instanceof KimiError &&
      error.code === 'kimi_home_cleanup_unproved'
    )
      throw new NativeCleanupError(host.cleanupHome(effective))
    throw error
  })
  try {
    const owned = await readCatalog(
      lease,
      new KimiBudget(host.budget.limits),
      options.signal,
    )
    try {
      return owned.catalog
    } finally {
      owned.release()
    }
  } finally {
    const cleanup = () => lease.server.close()
    await closeNativeDiscovery(() => lease.close(), cleanup)
  }
}

export async function validateNativeSession(
  value: unknown,
  binding: ConfirmedNativeBinding,
) {
  const session = object(value)
  if (
    session.id !== binding.providerSessionId ||
    (await realpath(String(object(session.metadata).cwd))) !== binding.cwd
  )
    throw new KimiError('kimi_resume_mismatch')
}

export async function preserveMessage(
  value: unknown,
  snapshotId: string,
  records: KimiRecords,
  lease: KimiLease,
  host: KimiHostOwner,
  sink: KimiAttachmentSink,
  root?: KimiRoot,
  importId?: string,
  end = Infinity,
) {
  checkHistoryDeadline(end)
  const limits = records.budget.limits
  const valueBytes = jsonBytes(value, limits, limits.messageBytes)
  const metadataBytes =
    jsonBytes(
      { scope: records.scope, root, snapshotId },
      limits,
      limits.stateReadBytes,
    ) + 1024
  const releases = [reserveHistoryTransform(records, valueBytes, metadataBytes)]
  const physicalSinks = new Set<Promise<unknown>>()
  let delivered = false,
    released = false
  const release = () => {
    if (released) return
    released = true
    const free = () => releases.forEach((release) => release())
    if (physicalSinks.size) void Promise.allSettled(physicalSinks).then(free)
    else free()
  }
  try {
    const message = object(value),
      id = boundedString(message.id, limits.nativeIdBytes)
    if (
      message.session_id !== records.scope.binding.providerSessionId ||
      !['system', 'user', 'assistant', 'tool'].includes(String(message.role)) ||
      !Array.isArray(message.content)
    )
      throw new KimiError('kimi_message_identity')
    const positional = id.startsWith(
      `msg_${records.scope.binding.providerSessionId}_`,
    )
    let native = record(
      records.scope,
      'message',
      [id, positional ? snapshotId : null],
      'message',
      message,
      root,
    )
    const attachmentIds: string[] = [],
      media: KimiNativeRecord[] = []
    let unavailable = false
    const scan = async (value: unknown, path: string): Promise<void> => {
      checkHistoryDeadline(end)
      if (typeof value === 'string') {
        if (value.includes('[media missing]')) unavailable = true
        return
      }
      if (!value || typeof value !== 'object') return
      if (Array.isArray(value)) {
        for (const [index, item] of value.entries())
          await scan(item, `${path}/${index}`)
        return
      }
      const part = object(value)
      let source: Record<string, unknown> | undefined
      if (part.source && typeof part.source === 'object')
        source = object(part.source)
      else if (part.type === 'file' && typeof part.file_id === 'string')
        source = { kind: 'file', file_id: part.file_id }
      else
        for (const key of ['imageUrl', 'videoUrl', 'audioUrl'])
          if (part[key]) source = { kind: 'url', ...object(part[key]) }
      if (source) {
        if (
          source.kind === 'url' &&
          typeof source.url === 'string' &&
          source.url.startsWith('kimi-file://')
        ) {
          const reference = boundedString(source.url, limits.jsonStringBytes),
            rest = reference.slice('kimi-file://'.length),
            query = rest.indexOf('?path=')
          source = {
            kind: 'file',
            file_id: boundedString(
              query < 0 ? rest : rest.slice(0, query),
              limits.nativeIdBytes,
            ),
          }
        }
        releases.push(
          reserveHistoryTransform(
            records,
            jsonBytes(source, limits, limits.messageBytes),
            metadataBytes + Buffer.byteLength(path),
          ),
        )
        let bytes: Uint8Array | undefined,
          mime: string | undefined,
          fileId: string | undefined
        let releaseBytes = () => {},
          submitted = false
        try {
          if (source.kind === 'file') {
            fileId = boundedString(source.file_id, limits.nativeIdBytes)
            try {
              let delivered = false
              const reading = host.track(
                lease.server
                  .http(
                    lease.lane,
                    `/api/v1/files/${encodeURIComponent(fileId)}`,
                    {
                      raw: true,
                      maxBytes: limits.attachmentBytes,
                      signal: records.signal,
                    },
                  )
                  .then((value) => {
                    const owned = value as KimiOwnedBytes
                    if (performance.now() >= end) {
                      owned.release()
                      throw new KimiError('kimi_history_deadline')
                    }
                    return owned
                  }),
              )
              let owned: KimiOwnedBytes
              try {
                owned = Number.isFinite(end)
                  ? await deadline(
                      reading,
                      Math.max(1, end - performance.now()),
                      records.signal,
                      records.budget,
                      host.budget,
                    )
                  : await reading
                delivered = true
              } finally {
                if (!delivered)
                  void reading.then((value) => value.release()).catch(() => {})
              }
              bytes = owned.bytes
              releaseBytes = owned.release
            } catch (error) {
              if (
                error instanceof KimiError &&
                [
                  'kimi_resource_limit',
                  'kimi_history_deadline',
                  'kimi_deadline',
                ].includes(error.code)
              )
                throw error
              unavailable = true
            }
            mime =
              typeof source.media_type === 'string'
                ? source.media_type
                : typeof part.media_type === 'string'
                  ? part.media_type
                  : undefined
            // Preserve unknown MIME as bytes; never advertise an invented image type.
            mime ??= 'application/octet-stream'
          } else {
            let encoded: string | undefined
            if (source.kind === 'base64') {
              mime = boundedString(source.media_type, 128)
              encoded = boundedString(
                source.data,
                Math.ceil(limits.attachmentBytes / 3) * 4,
                true,
              )
            } else if (
              source.kind === 'url' &&
              typeof source.url === 'string' &&
              source.url.startsWith('data:')
            ) {
              const match =
                /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(source.url)
              if (!match) throw new KimiError('kimi_media_encoding')
              mime = match[1]
              encoded = match[2]
            }
            if (encoded !== undefined) {
              if (
                encoded.length > Math.ceil(limits.attachmentBytes / 3) * 4 ||
                !mime ||
                !/^[\w.+-]+\/[\w.+-]+$/.test(mime)
              )
                throw new KimiError('kimi_media_limit')
              if (
                !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
                  encoded,
                )
              )
                throw new KimiError('kimi_media_encoding')
              const size =
                (encoded.length / 4) * 3 -
                (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0)
              if (size > limits.attachmentBytes)
                throw new KimiError('kimi_media_limit')
              releaseBytes = host.budget.reserve('hostAttachmentBytes', size)
              const releaseValidation = host.budget.reserve(
                'hostIpcBytes',
                encoded.length * 2,
              )
              try {
                bytes = Buffer.from(encoded, 'base64')
                if (
                  (bytes as Buffer).toString('base64') !== encoded ||
                  bytes.length > limits.attachmentBytes
                )
                  throw new KimiError('kimi_media_encoding')
              } finally {
                releaseValidation()
              }
            }
          }
          if (bytes && mime) {
            checkHistoryDeadline(end)
            const releaseCall = reserveAll([[host.budget, 'sinkCalls']])
            let physicalStarted = false
            try {
              const sha256 = createHash('sha256').update(bytes).digest('hex'),
                nativeAttachmentId = digest([
                  native.recordId,
                  path,
                  fileId,
                  sha256,
                ])
              const sourceIdentity = {
                domain: 'message' as const,
                key: nativeAttachmentId,
                revision: sha256,
              }
              const captured = bytes,
                capturedMime = mime
              submitted = true
              physicalStarted = true
              const physical = host.track(
                Promise.resolve()
                  .then(() => {
                    checkHistoryDeadline(end)
                    return sink({
                      scope: records.scope,
                      importId,
                      agentId: 'main',
                      nativeAttachmentId,
                      sourceIdentity,
                      nativeFileId: fileId,
                      mime: capturedMime,
                      sizeBytes: captured.length,
                      sha256,
                      bytes: (async function* () {
                        for (
                          let offset = 0;
                          offset < captured.length;
                          offset += limits.ipcMediaChunkBytes
                        )
                          yield captured.subarray(
                            offset,
                            offset + limits.ipcMediaChunkBytes,
                          )
                      })(),
                      signal: records.signal,
                    })
                  })
                  .finally(() => {
                    releaseBytes()
                    releaseCall()
                  }),
              )
              physicalSinks.add(physical)
              void physical
                .finally(() => physicalSinks.delete(physical))
                .catch(() => {})
              const stored = await deadline(
                physical,
                Math.min(limits.sinkMs, Math.max(1, end - performance.now())),
                records.signal,
                records.budget,
                host.budget,
              )
              checkHistoryDeadline(end)
              attachmentIds.push(
                boundedString(stored.attachmentId, limits.forgeIdBytes),
              )
              media.push(
                record(
                  records.scope,
                  'message',
                  [native.recordId, path, sha256],
                  'media',
                  {
                    nativeAttachmentId,
                    source,
                    mime,
                    sha256,
                    attachmentId: stored.attachmentId,
                  },
                  root,
                ),
              )
            } finally {
              if (!physicalStarted) releaseCall()
            }
          } else
            media.push(
              record(
                records.scope,
                'message',
                [native.recordId, path],
                source.kind === 'file' ? 'media.unavailable' : 'media.external',
                {
                  source,
                  bytesStored: false,
                  coverage: source.kind === 'file' ? 'unavailable' : 'external',
                },
                root,
              ),
            )
          return
        } finally {
          if (!submitted) releaseBytes()
        }
      }
      for (const [key, item] of Object.entries(part))
        await scan(item, `${path}/${key}`)
    }
    await scan(message.content, 'content')
    native = { ...native, attachmentIds }
    const events: HarnessEvent[] = []
    if (root && (message.role === 'assistant' || message.role === 'user'))
      for (const [index, value] of message.content.entries()) {
        const part = object(value),
          type = part.type
        if (type !== 'text' && type !== 'thinking') continue
        releases.push(reserveHistoryTransform(records, 0, metadataBytes))
        const text = boundedString(
          type === 'text' ? part.text : part.thinking,
          limits.retainedItemBytes,
          true,
        )
        const base = {
          ...root,
          runtimeGeneration: records.scope.runtimeGeneration,
          deliveryId: '',
          itemId: digest([native.recordId, index]),
        }
        events.push(
          type === 'text'
            ? {
                ...base,
                type: 'content_snapshot',
                contentType: 'text',
                role: message.role,
                text,
              }
            : {
                ...base,
                type: 'content_snapshot',
                contentType: 'thought',
                text,
              },
        )
      }
    delivered = true
    return { records: [native, ...media], events, unavailable, release }
  } finally {
    if (!delivered) release()
  }
}

export async function readKimiHistory(options: {
  authority: KimiLaunchAuthority
  host: KimiHost
  binding: ConfirmedNativeBinding
  importScope: KimiImportScope
  cursor?: KimiHistoryCursor
  messageCursor?: KimiMessageCursor
  readState: KimiStateReader
  commitRecords: KimiRecordSink
  storeAttachment: KimiAttachmentSink
  signal: AbortSignal
}): Promise<{
  next?: KimiHistoryCursor
  nextMessage?: KimiMessageCursor
  complete: boolean
  coverage: {
    transcript: 'complete' | 'partial' | 'unavailable'
    messages: 'complete' | 'partial' | 'unavailable'
    media: 'complete' | 'partial' | 'unavailable'
  }
  limits: readonly string[]
}> {
  const host = hostOwner(options.host),
    limits = host.budget.limits
  const authority = await effectiveAuthority(
    captureAuthority(options.authority, limits),
  )
  jsonBytes(options.binding, limits, limits.stateReadBytes)
  jsonBytes(options.importScope, limits, limits.cursorBytes)
  const binding = structuredClone(options.binding),
    scope = structuredClone(options.importScope)
  boundedString(scope.sessionId, limits.forgeIdBytes)
  boundedString(scope.importId, limits.forgeIdBytes)
  boundedString(binding.providerSessionId, limits.nativeIdBytes)
  if (
    binding.provider !== authority.selected.provider ||
    binding.accountId !== authority.selected.account.id ||
    (await realpath(binding.cwd)) !== binding.cwd
  )
    throw new KimiError('kimi_history_binding')
  for (const cursor of [options.cursor, options.messageCursor]) {
    if (!cursor) continue
    jsonBytes(cursor, limits, limits.cursorBytes)
    if (cursor.nativeSessionId !== binding.providerSessionId)
      throw new KimiError('kimi_cursor_binding')
    boundedString(cursor.agentId, limits.nativeIdBytes)
    boundedString(cursor.snapshotId, limits.nativeIdBytes)
  }
  if (options.cursor && options.cursor.source !== 'transcript')
    throw new KimiError('kimi_cursor_domain')
  if (
    options.messageCursor &&
    (options.messageCursor.source !== 'messages' ||
      options.messageCursor.agentId !== 'main')
  )
    throw new KimiError('kimi_cursor_domain')
  if (
    options.cursor &&
    options.messageCursor &&
    options.cursor.snapshotId !== options.messageCursor.snapshotId
  )
    throw new KimiError('kimi_cursor_snapshot')
  const lease = await host.acquire(authority, 'helper')
  const budget = new KimiBudget(limits),
    generation = randomUUID()
  const createRecords = () =>
    new KimiRecords(
      { sessionId: scope.sessionId, binding, runtimeGeneration: generation },
      budget,
      host,
      options.commitRecords,
      () => {},
      options.signal,
      scope.importId,
    )
  const coverage = {
    transcript: 'partial' as 'complete' | 'partial' | 'unavailable',
    messages: 'partial' as 'complete' | 'partial' | 'unavailable',
    media: 'complete' as 'complete' | 'partial' | 'unavailable',
  }
  let next = options.cursor,
    nextMessage = options.messageCursor
  const disclosed = [
    'Native main message loading allocates the full journal internally',
  ]
  const readEnd = performance.now() + limits.historyMs
  const readReleases: (() => void)[] = []
  let finalEnd = readEnd
  try {
    const records = await lease.ingestion(
      binding.providerSessionId,
      scope.sessionId,
      () => {
        const records = createRecords()
        return { records, ready: records.restore(options.readState) }
      },
    )
    lease.resident(binding.providerSessionId)(binding.providerSessionId)
    await validateNativeSession(
      await lease.server.http(
        lease.lane,
        `/api/v1/sessions/${encodeURIComponent(binding.providerSessionId)}`,
      ),
      binding,
    )
    const base = `/api/v1/sessions/${encodeURIComponent(binding.providerSessionId)}`
    const ownedSnapshot = await readHistoryPage(
      lease,
      host,
      budget,
      `${base}/snapshot`,
      options.signal,
      readEnd,
    )
    readReleases.push(ownedSnapshot.release)
    const snapshot = ownedSnapshot.value
    await validateNativeSession(snapshot.session, binding)
    let snapshotId =
      options.cursor?.snapshotId ?? options.messageCursor?.snapshotId
    if (!snapshotId) {
      const releaseHash = reserveHistoryTransform(
        records,
        ownedSnapshot.bytes,
        jsonBytes(binding, limits, limits.stateReadBytes),
      )
      try {
        snapshotId = digest([binding, snapshot])
      } finally {
        releaseHash()
      }
    }
    const end = readEnd,
      seen = new Map<string, () => void>()
    const retainCursor = (key: string) => {
      const bytes = Buffer.byteLength(key)
      const release = reserveAll([
        [budget, 'cursorEntries'],
        [budget, 'cursorStateBytes', bytes],
        [budget, 'retainedBytes', bytes],
        [host.budget, 'hostRetainedBytes', bytes],
      ])
      readReleases.push(release)
      seen.set(key, release)
    }
    let transcriptWatermark: number | undefined,
      mixedTranscript = false
    for (let page = 0; page < limits.historyPages; page++) {
      checkHistoryDeadline(end)
      const agent = next?.agentId ?? 'main'
      const owned = await readHistoryPage(
          lease,
          host,
          budget,
          `${base}/transcript?agent_id=${encodeURIComponent(agent)}&page_size=${limits.pageTurns}${next ? `&before_turn=${encodeURIComponent(next.beforeTurn)}` : ''}`,
          options.signal,
          end,
        ),
        response = owned.value
      let releaseTransform = () => {}
      try {
        budget.add(
          'historyBytes',
          jsonBytes(response, limits, limits.httpJsonBytes),
        )
        if (
          response.agent_id !== agent ||
          !Array.isArray(response.items) ||
          typeof response.has_more !== 'boolean' ||
          response.items.length > limits.retainedItems ||
          response.items.filter((item) => object(item).kind === 'turn').length >
            limits.pageTurns
        )
          throw new KimiError('kimi_history_page')
        const watermark = sequence(response.seq)
        if (transcriptWatermark === undefined) transcriptWatermark = watermark
        else if (watermark !== transcriptWatermark) mixedTranscript = true
        releaseTransform = reserveHistoryTransform(
          records,
          owned.bytes,
          (response.items.length + 1) *
            (jsonBytes(
              { scope: records.scope, snapshotId, agent },
              limits,
              limits.stateReadBytes,
            ) +
              1024) +
            1024,
        )
        const key = digest(response.items)
        if (seen.has(key) || (response.has_more && !response.items.length))
          throw new KimiError('kimi_history_progress')
        retainCursor(key)
        const entries = response.items.map((item) =>
          record(
            records.scope,
            'cold-import',
            [snapshotId, agent, object(item).turnId ?? object(item).id],
            'history.turn',
            item,
            undefined,
            agent,
          ),
        )
        if (page === 0)
          entries.push(
            record(
              records.scope,
              'cold-import',
              [snapshotId, agent, 'global'],
              'history.global',
              { ...response, items: [] },
              undefined,
              agent,
            ),
          )
        next = response.has_more
          ? {
              nativeSessionId: binding.providerSessionId,
              agentId: agent,
              source: 'transcript',
              snapshotId,
              beforeTurn: boundedString(
                object(
                  response.items.find((item) => object(item).kind === 'turn'),
                ).turnId,
                limits.nativeIdBytes,
              ),
            }
          : undefined
        checkHistoryDeadline(end)
        await records.commit(
          ['history', snapshotId, agent, key],
          entries,
          [],
          {
            transcripts: {},
            history: next,
          },
          false,
          end,
        )
        if (!next) {
          coverage.transcript = mixedTranscript ? 'partial' : 'complete'
          break
        }
      } finally {
        releaseTransform()
        owned.release()
      }
    }
    if (options.cursor?.agentId && options.cursor.agentId !== 'main') {
      coverage.messages = 'unavailable'
      coverage.media = 'partial'
      disclosed.push('Kimi has no complete child message or media history API')
    } else {
      for (const release of seen.values()) release()
      seen.clear()
      const messageEnd = performance.now() + limits.messageMs
      finalEnd = messageEnd
      for (let page = 0; page < limits.messagePages; page++) {
        checkHistoryDeadline(messageEnd)
        const owned = await readHistoryPage(
            lease,
            host,
            budget,
            `${base}/messages?page_size=${limits.pageMessages}${nextMessage ? `&before_id=${encodeURIComponent(nextMessage.beforeId)}` : ''}`,
            options.signal,
            messageEnd,
          ),
          response = owned.value
        const outputReleases: (() => void)[] = []
        let releaseHash = () => {}
        try {
          budget.add(
            'messageBytes',
            jsonBytes(response, limits, limits.httpJsonBytes),
          )
          if (
            !Array.isArray(response.items) ||
            typeof response.has_more !== 'boolean' ||
            response.items.length > limits.pageMessages
          )
            throw new KimiError('kimi_message_page')
          releaseHash = reserveHistoryTransform(records, owned.bytes)
          const key = digest(response.items)
          releaseHash()
          if (seen.has(key) || (response.has_more && !response.items.length))
            throw new KimiError('kimi_message_progress')
          retainCursor(key)
          const entries: KimiNativeRecord[] = []
          for (const message of response.items) {
            const preserved = await preserveMessage(
              message,
              snapshotId,
              records,
              lease,
              host,
              options.storeAttachment,
              undefined,
              scope.importId,
              messageEnd,
            )
            outputReleases.push(preserved.release)
            entries.push(...preserved.records)
            if (preserved.unavailable) coverage.media = 'partial'
          }
          nextMessage = response.has_more
            ? {
                nativeSessionId: binding.providerSessionId,
                agentId: 'main',
                source: 'messages',
                snapshotId,
                beforeId: boundedString(
                  object(response.items[response.items.length - 1]).id,
                  limits.nativeIdBytes,
                ),
              }
            : undefined
          checkHistoryDeadline(messageEnd)
          await records.commit(
            ['messages', snapshotId, key],
            entries,
            [],
            {
              transcripts: {},
              messages: nextMessage,
            },
            false,
            messageEnd,
          )
          if (!nextMessage) {
            coverage.messages = 'complete'
            break
          }
        } finally {
          releaseHash()
          outputReleases.forEach((release) => release())
          owned.release()
        }
      }
    }
    const finalOwned = await readHistoryPage(
      lease,
      host,
      budget,
      `${base}/snapshot`,
      options.signal,
      finalEnd,
    )
    readReleases.push(finalOwned.release)
    const finalSnapshot = finalOwned.value
    await validateNativeSession(finalSnapshot.session, binding)
    checkHistoryDeadline(finalEnd)
    if (
      finalSnapshot.epoch !== snapshot.epoch ||
      sequence(finalSnapshot.as_of_seq) !== sequence(snapshot.as_of_seq)
    ) {
      if (coverage.transcript === 'complete') coverage.transcript = 'partial'
      if (coverage.messages === 'complete') coverage.messages = 'partial'
      disclosed.push('Native history changed while pages were read')
    }
    return {
      next,
      nextMessage,
      coverage,
      complete: Object.values(coverage).every((value) => value === 'complete'),
      limits: disclosed,
    }
  } finally {
    readReleases.forEach((release) => release())
    await lease.close()
  }
}
