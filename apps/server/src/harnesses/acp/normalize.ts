import { randomUUID } from 'node:crypto'
import { zSessionUpdate } from '@agentclientprotocol/sdk/dist/schema/zod.gen.js'
import { harnessEventSchema } from '@forge/protocol/harness'
import type { HarnessEvent } from '../types.js'
import type {
  AcpContentOwner,
  AcpRecordInput,
  AcpReplayEventBody,
} from './ingestion.js'
import type { createAcpContent } from './content.js'
import type { NumericCapture } from './numbers.js'
import type { AcpResourceHost } from './limits.js'
import { digest, immutableData } from './data.js'
import { projectAcpUsage, type AcpUsageKind } from './usage.js'

type Content = ReturnType<typeof createAcpContent>
type Subject = Omit<AcpContentOwner, 'itemId'>
type Body = AcpReplayEventBody
type Item = { id: string; blockIndex: number }
type Tool = {
  itemId: string
  value: Record<string, unknown>
  active: boolean
  content: {
    promise: Promise<unknown>
    retain: () => void
    release: () => void
  }
  release: () => void
}
type State = {
  subject: Subject
  items: Map<string, Item>
  tools: Map<string, Tool>
  releases: Set<() => void>
  active: number
  planSteps: string[]
}

/** Produces ordered journal inputs. Only the runtime can publish or finish a root. */
export class AcpNormalizer {
  private readonly states = new Map<string, State>()
  private closed = false
  constructor(
    private readonly content: Content,
    private readonly host: AcpResourceHost,
    private readonly instanceId: string,
  ) {}
  private state(input: Subject) {
    if (this.closed) throw Error('ACP normalizer is closed')
    const subject = immutableData(input)
    const key = digest(subject)
    let state = this.states.get(key)
    if (!state) {
      if (this.states.size >= 128) throw Error('ACP content owner limit')
      const release = this.host.reserve(
        this.instanceId,
        'retained',
        Buffer.byteLength(JSON.stringify(subject)) * 2 + 1024,
      )
      state = {
        subject,
        items: new Map(),
        tools: new Map(),
        releases: new Set([release]),
        active: 0,
        planSteps: [],
      }
      this.states.set(key, state)
    }
    return state
  }
  private item(state: State, key: string): Item {
    let item = state.items.get(key)
    if (!item) {
      if (state.items.size >= 4096) throw Error('ACP item limit')
      const release = this.host.reserve(
        this.instanceId,
        'retained',
        Buffer.byteLength(key) * 2 + 256,
      )
      item = { id: randomUUID(), blockIndex: 0 }
      state.items.set(key, item)
      state.releases.add(release)
    }
    return item
  }
  private contentSnapshot(input: unknown, work: () => Promise<unknown>) {
    const inputRelease = this.host.reserve(
      this.instanceId,
      'retained',
      Buffer.byteLength(JSON.stringify(input) ?? 'null') * 2 + 256,
    )
    let references = 1,
      releaseResult: (() => void) | undefined
    const promise = Promise.resolve()
      .then(work)
      .then((value) => {
        releaseResult = this.host.reserve(
          this.instanceId,
          'retained',
          Buffer.byteLength(JSON.stringify(value) ?? 'null') * 2 + 256,
        )
        if (!references) releaseResult()
        return value
      })
      .finally(inputRelease)
    void promise.catch(() => {})
    return {
      promise,
      retain() {
        references++
      },
      release() {
        if (--references === 0) releaseResult?.()
      },
    }
  }
  private record(
    subject: Subject,
    body: Body,
    sourceRefs: AcpRecordInput['sourceRefs'] = [],
  ): AcpRecordInput {
    if (subject.owner.phase === 'live') {
      const event = harnessEventSchema.parse({
        ...body,
        runId: subject.owner.runId,
        turnId: subject.owner.turnId,
        runtimeGeneration: subject.owner.runtimeGeneration,
        deliveryId: randomUUID(),
        ...(subject.childId ? { childId: subject.childId } : {}),
      })
      return {
        value: { kind: 'event', event },
        sourceRefs,
        subject: {
          ...('itemId' in body ? { itemId: body.itemId } : {}),
          responseId: subject.responseId,
          childId: subject.childId,
          intervalId: subject.intervalId,
        },
      }
    }
    // Validate replay with a private schema envelope, then remove all live identity fields.
    const validated = harnessEventSchema.parse({
      ...body,
      runId: 'replay-validation',
      turnId: 'replay-validation',
      runtimeGeneration: 'replay-validation',
      deliveryId: 'replay-validation',
    })
    const {
      runId: _run,
      turnId: _turn,
      runtimeGeneration: _generation,
      deliveryId: _delivery,
      ...event
    } = validated as HarnessEvent & { turnId: string }
    return {
      value: { kind: 'replay', event: event as Body },
      sourceRefs,
      subject: {
        ...('itemId' in body ? { itemId: body.itemId } : {}),
        responseId: subject.responseId,
      },
    }
  }
  async usage(
    input: unknown,
    kind: AcpUsageKind,
    numbers: NumericCapture,
    path: string,
    subject: Subject,
    signal: AbortSignal,
  ): Promise<AcpRecordInput[]> {
    const state = this.state(subject)
    state.active++
    try {
      const item = this.item(state, `usage:${kind}`),
        owner = { ...state.subject, itemId: item.id }
      const projection = projectAcpUsage(input, kind, numbers, path)
      if (input === undefined) return []
      const sourceRef = await this.content.source(
        owner,
        projection.source,
        signal,
      )
      if (signal.aborted) throw Error('ACP normalization cancelled')
      if (!projection.patch)
        return [
          this.record(
            state.subject,
            {
              type: 'source_reference',
              subject: {
                kind: 'usage',
                measurementId: item.id,
                responseId: state.subject.responseId,
              },
              sourceRef,
            },
            [sourceRef],
          ),
        ]
      return [
        this.record(
          state.subject,
          {
            type: 'usage_snapshot',
            itemId: item.id,
            measurementId: item.id,
            responseId: state.subject.responseId,
            ...projection.patch,
            sourceRef,
          },
          [sourceRef],
        ),
      ]
    } finally {
      state.active--
    }
  }
  async update(
    input: unknown,
    numbers: NumericCapture,
    subject: Subject,
    signal: AbortSignal,
  ): Promise<AcpRecordInput[]> {
    const release = this.host.reserve(
      this.instanceId,
      'retained',
      32 * 1024 * 1024,
    )
    try {
      return await this.normalizeUpdate(input, numbers, subject, signal)
    } finally {
      release()
    }
  }
  private async normalizeUpdate(
    input: unknown,
    numbers: NumericCapture,
    subject: Subject,
    signal: AbortSignal,
  ): Promise<AcpRecordInput[]> {
    if (
      input &&
      typeof input === 'object' &&
      Object.getOwnPropertyDescriptor(input, 'sessionUpdate')?.value ===
        'usage_update'
    )
      return this.usage(
        input,
        'context',
        numbers,
        '/params/update',
        subject,
        signal,
      )
    const raw = immutableData(input, 16 * 1024 * 1024)
    const update = zSessionUpdate.parse(raw)
    const state = this.state(subject)
    state.active++
    let ownedTool: { native: string; tool: Tool } | undefined
    try {
      if (update.sessionUpdate === 'usage_update')
        return await this.usage(
          raw,
          'context',
          numbers,
          '/params/update',
          subject,
          signal,
        )
      const results: AcpRecordInput[] = []
      if (
        [
          'agent_message_chunk',
          'user_message_chunk',
          'agent_thought_chunk',
        ].includes(update.sessionUpdate)
      ) {
        const item = this.item(state, update.sessionUpdate)
        const owner = { ...state.subject, itemId: item.id }
        const content = (raw as Record<string, unknown>).content as Record<
          string,
          unknown
        >
        const role: 'user' | 'assistant' =
          update.sessionUpdate === 'user_message_chunk' ? 'user' : 'assistant'
        if (content.type === 'text') {
          const {
            sessionUpdate: _type,
            content: _content,
            ...metadata
          } = raw as Record<string, unknown>
          const {
            type: _contentType,
            text: _text,
            ...contentMetadata
          } = content
          if (Object.keys(contentMetadata).length)
            metadata.content = contentMetadata
          const sourceRef = Object.keys(metadata).length
            ? await this.content.source(owner, metadata, signal)
            : undefined
          const body =
            update.sessionUpdate === 'agent_thought_chunk'
              ? {
                  type: 'thought_delta' as const,
                  itemId: item.id,
                  text: content.text as string,
                  sourceRef,
                }
              : {
                  type: 'text_delta' as const,
                  itemId: item.id,
                  text: content.text as string,
                  role,
                  sourceRef,
                }
          results.push(
            this.record(state.subject, body, sourceRef ? [sourceRef] : []),
          )
        } else {
          const blockIndex = item.blockIndex++
          const stored = await this.content.block(owner, content, signal)
          const {
            sessionUpdate: _type,
            content: _content,
            ...outer
          } = raw as Record<string, unknown>
          const outerRef = Object.keys(outer).length
            ? await this.content.source(owner, outer, signal)
            : undefined
          const sourceRefs = [
            ...stored.sourceRefs,
            ...(outerRef ? [outerRef] : []),
          ]
          results.push(
            this.record(
              state.subject,
              {
                type: 'content_block',
                itemId: item.id,
                blockIndex,
                role,
                block: stored.block,
                ...(sourceRefs[0] ? { sourceRef: sourceRefs[0] } : {}),
              },
              sourceRefs,
            ),
          )
          for (const sourceRef of sourceRefs.slice(1))
            results.push(
              this.record(
                state.subject,
                {
                  type: 'source_reference',
                  subject: {
                    kind: 'item',
                    itemId: item.id,
                    responseId: state.subject.responseId,
                  },
                  sourceRef,
                },
                [sourceRef],
              ),
            )
        }
      } else if (
        update.sessionUpdate === 'tool_call' ||
        update.sessionUpdate === 'tool_call_update'
      ) {
        const native = update.toolCallId
        let tool = state.tools.get(native)
        if (!tool && update.sessionUpdate === 'tool_call_update')
          return [{ value: { kind: 'disposition', status: 'ignored' } }]
        const item = this.item(state, `tool:${native}`)
        const { content: nativeContent, ...fields } = raw as Record<
          string,
          unknown
        >
        const next = immutableData(
          { ...tool?.value, ...fields },
          4 * 1024 * 1024,
        )
        const release = this.host.reserve(
          this.instanceId,
          'retained',
          Buffer.byteLength(JSON.stringify(next)) * 2 + 256,
        )
        const releaseOwned = () => {
          release()
          state.releases.delete(releaseOwned)
        }
        state.releases.add(releaseOwned)
        const first = !tool
        const priorTool = tool
        const priorContent = tool?.content
        const contentOwner = { ...state.subject, itemId: item.id }
        const projectedContent =
          nativeContent === undefined && priorContent
            ? (priorContent.retain(), priorContent)
            : this.contentSnapshot(nativeContent, async () => {
                if (nativeContent === undefined || nativeContent === null)
                  return nativeContent
                return await (async () => {
                  const blocks: unknown[] = []
                  for (const [index, entry] of (
                    nativeContent as Array<Record<string, unknown>>
                  ).entries()) {
                    if (entry.type !== 'content') {
                      blocks.push(entry)
                      continue
                    }
                    const { content: body, ...metadata } = entry
                    if (
                      body &&
                      typeof body === 'object' &&
                      (body as Record<string, unknown>).type === 'text'
                    ) {
                      blocks.push(entry)
                      continue
                    }
                    const stored = await this.content.block(
                      contentOwner,
                      body,
                      signal,
                    )
                    blocks.push({
                      ...metadata,
                      blockIndex: index,
                      block: stored.block,
                      ...(stored.sourceRefs.length
                        ? { sourceRefs: stored.sourceRefs }
                        : {}),
                    })
                  }
                  return blocks
                })()
              })
        let toolReleased = false
        tool = {
          itemId: item.id,
          value: next,
          content: projectedContent,
          active: true,
          release: () => {
            if (toolReleased) return
            toolReleased = true
            releaseOwned()
            projectedContent.release()
          },
        }
        ownedTool = { native, tool }
        state.tools.set(native, tool)
        if (priorTool && !priorTool.active) priorTool.release()
        const toolContent = await projectedContent.promise
        const sourceRef = await this.content.source(
          { ...state.subject, itemId: item.id },
          next,
          signal,
        )
        if (first)
          results.push(
            this.record(
              state.subject,
              {
                type: 'tool_started',
                itemId: item.id,
                toolCallId: native,
                name: typeof next.title === 'string' ? next.title : native,
                input: next.rawInput === undefined ? {} : next.rawInput,
                sourceRef,
              },
              [sourceRef],
            ),
          )
        results.push(
          this.record(
            state.subject,
            {
              type: 'tool_update',
              itemId: item.id,
              toolCallId: native,
              status: typeof next.status === 'string' ? next.status : 'unknown',
              output: {
                rawOutput: next.rawOutput,
                content: toolContent,
                locations: next.locations,
                kind: next.kind,
                title: next.title,
              },
              sourceRef,
            },
            [sourceRef],
          ),
        )
      } else if (update.sessionUpdate === 'plan') {
        const item = this.item(state, 'plan')
        if (update.entries.length > 1024) throw Error('ACP plan step limit')
        while (state.planSteps.length < update.entries.length)
          state.planSteps.push(randomUUID())
        const sourceRef = await this.content.source(
          { ...state.subject, itemId: item.id },
          raw,
          signal,
        )
        const steps = update.entries.map((entry, index) => ({
          id: state.planSteps[index]!,
          title: entry.content,
          status:
            entry.status === 'in_progress'
              ? ('running' as const)
              : entry.status,
        }))
        results.push(
          this.record(state.subject, { type: 'plan', itemId: item.id, steps }, [
            sourceRef,
          ]),
        )
        results.push(
          this.record(
            state.subject,
            {
              type: 'source_reference',
              subject: {
                kind: 'item',
                itemId: item.id,
                responseId: state.subject.responseId,
              },
              sourceRef,
            },
            [sourceRef],
          ),
        )
      }
      if (signal.aborted) throw Error('ACP normalization cancelled')
      return results
    } finally {
      if (ownedTool) {
        ownedTool.tool.active = false
        if (state.tools.get(ownedTool.native) !== ownedTool.tool)
          ownedTool.tool.release()
      }
      state.active--
    }
  }
  retire(subject: Subject) {
    const key = digest(immutableData(subject)),
      state = this.states.get(key)
    if (!state) return
    if (state.active) throw Error('ACP normalizer still owns content work')
    this.states.delete(key)
    for (const tool of state.tools.values()) tool.release()
    for (const release of state.releases) release()
  }
  close() {
    if ([...this.states.values()].some((state) => state.active))
      throw Error('ACP normalizer still owns content work')
    this.closed = true
    for (const state of this.states.values()) this.retire(state.subject)
  }
}
