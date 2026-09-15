import { randomUUID } from 'node:crypto'
import type {
  AcpContentOwner,
  AcpRecordInput,
  AcpReplayEventBody,
  AcpSourceRef,
} from './ingestion.js'
import type { createAcpContent } from './content.js'
import type { AcpResourceHost } from './limits.js'
import type { NumericCapture } from './numbers.js'
import { digest, immutableData, immutableNumericData } from './data.js'
import { projectAcpUsage } from './usage.js'

type Subject = Omit<AcpContentOwner, 'itemId'>
type Response = {
  subject: Subject
  responseId: string
  nativeSessionId: string
  nativeId?: string
  closed: boolean
  reasoningClosed: boolean
  release: () => void
}
type Options = {
  content: ReturnType<typeof createAcpContent>
  host: AcpResourceHost
  instanceId: string
  record(
    subject: Subject,
    body: AcpReplayEventBody,
    sourceRefs?: readonly AcpSourceRef[],
  ): AcpRecordInput
  item(subject: Subject, kind: 'thought' | 'assistant'): string | undefined
}
const identity = (value: unknown) => {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 512)
    throw Error('Invalid Grok response identity')
  return value
}

/** Handles only the pinned public Grok response rail. These boundaries never finish a root. */
export class AcpResponses {
  private readonly currentByOwner = new Map<string, Response>()
  private readonly byNative = new Map<string, Response>()
  private readonly responses = new Set<Response>()
  private active = 0
  private closed = false
  private readonly options: Readonly<Options>
  constructor(options: Options) {
    this.options = Object.freeze({ ...options })
  }
  owner(nativeSessionId: string, nativeMessageId: string): Subject | null {
    if (this.closed) return null
    return (
      this.byNative.get(JSON.stringify([nativeSessionId, nativeMessageId]))
        ?.subject ?? null
    )
  }
  current(subject: Subject, kind: 'thought' | 'assistant'): Subject | null {
    const response = this.currentByOwner.get(digest(subject))
    return response &&
      !response.closed &&
      !(kind === 'thought' && response.reasoningClosed)
      ? response.subject
      : null
  }
  async update(
    input: unknown,
    numbers: NumericCapture,
    subject: Subject,
    nativeRailSessionId: string,
    signal: AbortSignal,
  ): Promise<AcpRecordInput[]> {
    if (this.closed) throw Error('Grok response registry is closed')
    const release = this.options.host.reserve(
      this.options.instanceId,
      'retained',
      4 * 1024 * 1024,
    )
    this.active++
    try {
      const captured = immutableData(subject)
      const rail = identity(nativeRailSessionId)
      if (
        !captured.childId &&
        rail !== captured.owner.binding.providerSessionId
      )
        throw Error('Foreign Grok response rail')
      const sourceNumbers = immutableData(numbers)
      const tokens = new Map(
        sourceNumbers.numbers.map((token) => [token.path, token]),
      )
      const raw = immutableNumericData(input, (path, value) => {
        const token = tokens.get('/params' + path)
        if (!token || !Object.is(Number(token.text), value))
          throw Error('Grok response lost numeric source')
        return token.text
      }) as Record<string, unknown>
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw Error('Invalid Grok response update')
      const nativeSessionId = identity(raw.sessionId)
      if (nativeSessionId !== rail)
        return this.quarantine(captured, raw, signal)
      const update = raw.update as Record<string, unknown>
      if (!update || typeof update !== 'object' || Array.isArray(update))
        throw Error('Invalid Grok response boundary')
      const kind = update.sessionUpdate
      if (
        ![
          'response_started',
          'reasoning_completed',
          'response_completed',
        ].includes(String(kind))
      )
        return []
      const nativeId =
        update.message_id == null ? undefined : identity(update.message_id)
      const ownerKey = digest(captured)
      let response = this.currentByOwner.get(ownerKey)
      const nativeKey = nativeId
        ? JSON.stringify([nativeSessionId, nativeId])
        : undefined
      if (kind === 'response_started') {
        if (
          (response && !response.closed) ||
          (nativeKey && this.byNative.has(nativeKey))
        )
          return this.quarantine(captured, raw, signal)
        if (this.responses.size >= 4096)
          throw Error('Grok response identity limit')
        const responseId = randomUUID()
        const capturedSubject = immutableData({ ...captured, responseId })
        const releaseResponse = this.options.host.reserve(
          this.options.instanceId,
          'retained',
          Buffer.byteLength(JSON.stringify(capturedSubject)) * 2 + 2048,
        )
        response = {
          subject: capturedSubject,
          responseId,
          nativeSessionId,
          nativeId,
          closed: false,
          reasoningClosed: false,
          release: releaseResponse,
        }
        this.responses.add(response)
        this.currentByOwner.set(ownerKey, response)
        if (nativeKey) this.byNative.set(nativeKey, response)
      } else if (nativeKey) {
        const exact = this.byNative.get(nativeKey)
        if (
          !exact ||
          digest({ ...exact.subject, responseId: undefined }) !==
            digest({ ...captured, responseId: undefined })
        )
          return this.quarantine(captured, raw, signal)
        response = exact
      }
      if (!response || response.nativeSessionId !== nativeSessionId)
        return this.quarantine(captured, raw, signal)
      if (kind === 'reasoning_completed') response.reasoningClosed = true
      if (kind === 'response_completed') {
        response.closed = true
        response.reasoningClosed = true
      }
      const original = (input as Record<string, unknown>).update as Record<
        string,
        unknown
      >
      const usage =
        kind === 'response_started'
          ? original
          : kind === 'response_completed'
            ? original.usage
            : undefined
      const usagePath =
        kind === 'response_started' ? '/params/update' : '/params/update/usage'
      const projection = projectAcpUsage(
        usage,
        'grok_response',
        numbers,
        usagePath,
      )
      const thoughtItem =
        kind === 'reasoning_completed'
          ? this.options.item(response.subject, 'thought')
          : undefined
      const sourceRef = await this.options.content.source(
        { ...response.subject, itemId: thoughtItem ?? response.responseId },
        { native: raw, usage: projection.source },
        signal,
      )
      if (signal.aborted) throw Error('Grok response normalization cancelled')
      const records: AcpRecordInput[] = []
      records.push(
        this.options.record(
          response.subject,
          {
            type: 'source_reference',
            subject: thoughtItem
              ? {
                  kind: 'item',
                  itemId: thoughtItem,
                  responseId: response.responseId,
                }
              : { kind: 'response', responseId: response.responseId },
            boundary:
              kind === 'response_started'
                ? 'opened'
                : kind === 'reasoning_completed'
                  ? 'reasoning_closed'
                  : 'closed',
            sourceRef,
          },
          [sourceRef],
        ),
      )
      if (projection.patch)
        records.push(
          this.options.record(
            response.subject,
            {
              type: 'usage_snapshot',
              itemId: response.responseId,
              measurementId: response.responseId,
              responseId: response.responseId,
              ...projection.patch,
              sourceRef,
            },
            [sourceRef],
          ),
        )
      return records
    } finally {
      this.active--
      release()
    }
  }
  private async quarantine(
    subject: Subject,
    source: unknown,
    signal: AbortSignal,
  ): Promise<AcpRecordInput[]> {
    const capturedSubject = { ...subject, itemId: randomUUID() }
    const sourceRef = await this.options.content.source(
      capturedSubject,
      source,
      signal,
    )
    const { owner: _owner, ...recordSubject } = capturedSubject
    return [
      {
        subject: recordSubject,
        value: {
          kind: 'disposition',
          status: 'ignored',
          code: 'grok_response_identity_unproved',
        },
        sourceRefs: [sourceRef],
      },
    ]
  }
  close() {
    if (this.active)
      throw Error('Grok response registry still owns source work')
    this.closed = true
    for (const response of this.responses) response.release()
    this.responses.clear()
    this.currentByOwner.clear()
    this.byNative.clear()
  }
}
