import { z } from 'zod'
import type { ConfirmedNativeBinding, NativeBinding } from '../types.js'
import type { NativeProcess } from '../process.js'
import { canonicalDirectory } from './environment.js'
import { connectCodex, type CodexAdapterOptions } from './catalog.js'
import {
  CodexOptions,
  MiB,
  byteSize,
  cursorSchema,
  fail,
  idSchema,
  initialBody,
  nativeItemSchema,
  record,
  threadSchema,
  turnSchema,
  validateThreadResponse,
  type NativeThread,
} from './wire.js'

const pageFields = {
  cursor: cursorSchema,
  sortDirection: z.enum(['asc', 'desc']).optional(),
}
const historyRequest = z.discriminatedUnion('type', [
  z.strictObject({
    ...pageFields,
    type: z.literal('turns'),
    limit: z.number().int().min(1).max(50).optional(),
    itemsView: z.enum(['summary', 'full', 'notLoaded']).optional(),
  }),
  z.strictObject({
    ...pageFields,
    type: z.literal('items'),
    turnId: idSchema,
    limit: z.number().int().min(1).max(100).optional(),
  }),
])
export type CodexHistoryRequest = z.infer<typeof historyRequest>
const turnsPage = z.object({
  data: z.array(turnSchema).max(50),
  nextCursor: cursorSchema,
  backwardsCursor: cursorSchema,
})
const itemsPage = z.object({
  data: z
    .array(z.object({ turnId: idSchema, item: nativeItemSchema }))
    .max(100),
  nextCursor: cursorSchema,
  backwardsCursor: cursorSchema,
})
export type CodexHistoryPage =
  | ({
      type: 'turns'
      threadId: string
      sortDirection: 'asc' | 'desc'
      itemsView: 'summary' | 'full' | 'notLoaded'
      complete: boolean
    } & z.infer<typeof turnsPage>)
  | ({
      type: 'items'
      threadId: string
      turnId: string
      sortDirection: 'asc' | 'desc'
      complete: boolean
    } & z.infer<typeof itemsPage>)

function validateBinding(options: CodexAdapterOptions, binding: NativeBinding) {
  if (
    binding.provider !== options.provider ||
    binding.accountId !== options.accountId ||
    !binding.providerSessionId
  )
    fail('BINDING_SCOPE')
  idSchema.parse(binding.providerSessionId)
  return { ...binding, providerSessionId: binding.providerSessionId }
}
function checkSource(thread: NativeThread, binding: ConfirmedNativeBinding) {
  if (
    thread.id !== binding.providerSessionId ||
    thread.cwd !== binding.cwd ||
    thread.ephemeral
  )
    fail('HISTORY_BINDING')
}
export async function readCodexHistoryPage(
  options: CodexAdapterOptions,
  binding: NativeBinding,
  page: CodexHistoryRequest,
  signal?: AbortSignal,
): Promise<CodexHistoryPage> {
  const request = historyRequest.parse(page)
  const source = validateBinding(options, binding)
  let process: NativeProcess | undefined
  try {
    const result = await connectCodex(
      options,
      source.cwd,
      async (connection) => {
        process = connection.process
        const metadata = z
          .object({ thread: threadSchema })
          .parse(
            await connection.request(
              'thread/read',
              { threadId: source.providerSessionId, includeTurns: false },
              { signal },
            ),
          )
        checkSource(metadata.thread, source)
        const sortDirection =
          request.sortDirection ?? (request.type === 'turns' ? 'desc' : 'asc')
        const cursor = request.cursor == null ? {} : { cursor: request.cursor }
        if (request.type === 'turns') {
          const itemsView = request.itemsView ?? 'summary'
          const value = await connection.request(
            'thread/turns/list',
            {
              threadId: source.providerSessionId,
              limit: request.limit ?? 50,
              itemsView,
              sortDirection,
              ...cursor,
            },
            { signal },
          )
          if (byteSize(value) > 8 * MiB) fail('HISTORY_LIMIT')
          const page = turnsPage.parse(value)
          return {
            type: 'turns' as const,
            threadId: source.providerSessionId,
            sortDirection,
            itemsView,
            complete: page.nextCursor == null,
            ...page,
          }
        }
        const value = await connection.request(
          'thread/items/list',
          {
            threadId: source.providerSessionId,
            turnId: request.turnId,
            limit: request.limit ?? 100,
            sortDirection,
            ...cursor,
          },
          { signal },
        )
        if (byteSize(value) > 8 * MiB) fail('HISTORY_LIMIT')
        const page = itemsPage.parse(value)
        if (page.data.some((entry) => entry.turnId !== request.turnId))
          fail('HISTORY_TURN')
        // Repeated anchors can carry corrections. Keep the last native version at its original position.
        const deduped = new Map<string, (typeof page.data)[number]>()
        for (const entry of page.data) deduped.set(entry.item.id, entry)
        return {
          type: 'items' as const,
          threadId: source.providerSessionId,
          turnId: request.turnId,
          sortDirection,
          complete: page.nextCursor == null,
          ...page,
          data: [...deduped.values()],
        }
      },
      undefined,
      signal,
      undefined,
      (canonical) => {
        if (canonical !== source.cwd) fail('BINDING_SCOPE')
      },
    )
    return result.value
  } finally {
    await process?.close()
  }
}

export type CodexForkRequest = {
  cwd: string
  lastTurnId?: string
  sourceSessionId?: string
  knownSourceThreadIds?: string[]
}
export type CodexForkResult = {
  binding: ConfirmedNativeBinding
  thread: NativeThread
  sourceThreadId: string
  lastTurnId?: string
}
export async function forkCodexThread(
  options: CodexAdapterOptions,
  binding: NativeBinding,
  request: CodexForkRequest,
  signal?: AbortSignal,
): Promise<CodexForkResult> {
  const source = validateBinding(options, binding)
  let target = request.cwd
  if (request.lastTurnId !== undefined) idSchema.parse(request.lastTurnId)
  if (request.sourceSessionId !== undefined)
    idSchema.parse(request.sourceSessionId)
  if ((request.knownSourceThreadIds?.length ?? 0) > 2048)
    fail('FORK_LINEAGE_LIMIT')
  const known = new Set(request.knownSourceThreadIds ?? [])
  if (known.size > 2048 || byteSize([...known]) > 4 * MiB)
    fail('FORK_LINEAGE_LIMIT')
  for (const id of known) idSchema.parse(id)
  known.add(source.providerSessionId)
  let process: NativeProcess | undefined
  try {
    const result = await connectCodex(
      options,
      target,
      async (connection) => {
        process = connection.process
        const policy = new CodexOptions(
          connection.baseline,
          options.initialOptions,
        )
        const initial = policy.resolve()
        const body = initialBody(initial, target)
        const metadata = z
          .object({ thread: threadSchema })
          .parse(
            await connection.request(
              'thread/read',
              { threadId: source.providerSessionId, includeTurns: false },
              { signal },
            ),
          )
        checkSource(metadata.thread, source)
        if (
          metadata.thread.parentThreadId ||
          (record(metadata.thread.source) &&
            record(metadata.thread.source.subAgent) &&
            record(metadata.thread.source.subAgent.thread_spawn)) ||
          (request.sourceSessionId !== undefined &&
            metadata.thread.sessionId !== request.sourceSessionId)
        )
          fail('FORK_SOURCE_TREE')
        if (request.lastTurnId !== undefined) {
          let cursor: string | undefined
          const seen = new Set<string>()
          let bytes = 0
          let count = 0
          let found = false
          for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
            const value = await connection.request(
              'thread/turns/list',
              {
                threadId: source.providerSessionId,
                limit: 50,
                itemsView: 'summary',
                sortDirection: 'desc',
                ...(cursor === undefined ? {} : { cursor }),
              },
              { signal },
            )
            bytes += byteSize(value)
            const page = turnsPage.parse(value)
            count += page.data.length
            if (bytes > 8 * MiB || count > 5000) fail('FORK_BOUNDARY_LIMIT')
            const boundary = page.data.find(
              (turn) => turn.id === request.lastTurnId,
            )
            if (boundary) {
              if (boundary.status === 'inProgress') fail('FORK_BOUNDARY_ACTIVE')
              found = true
              break
            }
            if (page.nextCursor == null) break
            if (seen.has(page.nextCursor)) fail('FORK_CURSOR_LOOP')
            seen.add(page.nextCursor)
            cursor = page.nextCursor
          }
          if (!found) fail('FORK_BOUNDARY_MISSING')
        }
        const value = await connection.request(
          'thread/fork',
          {
            ...body,
            threadId: source.providerSessionId,
            ephemeral: false,
            excludeTurns: true,
            ...(request.lastTurnId === undefined
              ? {}
              : { lastTurnId: request.lastTurnId }),
          },
          { signal },
        )
        const response = validateThreadResponse(value, target, initial)
        if (response.modelProvider !== connection.provenance.selectedProviderId)
          fail('THREAD_PROVIDER')
        if (
          known.has(response.thread.id) ||
          response.thread.forkedFromId !== source.providerSessionId
        )
          fail('FORK_LINEAGE')
        return {
          binding: Object.freeze({
            provider: options.provider,
            accountId: options.accountId,
            cwd: target,
            providerSessionId: response.thread.id,
          }),
          thread: response.thread,
          sourceThreadId: source.providerSessionId,
          ...(request.lastTurnId === undefined
            ? {}
            : { lastTurnId: request.lastTurnId }),
        }
      },
      undefined,
      signal,
      undefined,
      async (canonical) => {
        target = canonical
        if ((await canonicalDirectory(source.cwd)) !== source.cwd)
          fail('BINDING_SCOPE')
      },
    )
    return result.value
  } finally {
    await process?.close()
  }
}
