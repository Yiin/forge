import { randomUUID } from 'node:crypto'
import { zRequestPermissionRequest } from '@agentclientprotocol/sdk/dist/schema/zod.gen.js'
import {
  permissionReplySchema,
  type PermissionRequest,
  type QuestionRequest,
} from '@forge/protocol/harness'
import type { HarnessEvent, PermissionReply, QuestionAnswer } from '../types.js'
import type { JsonlRpcTransport, JsonRpcRequest } from '../jsonrpc.js'
import { AcpJournal, type AcpLiveOwner, type AcpTicket } from './ingestion.js'
import type { AcpResourceHost } from './limits.js'
import { immutableData, digest } from './data.js'
import { prepareGrokQuestions } from './questions.js'

export type AcpInteractionBroker = {
  admit(
    input: Readonly<{
      owner: AcpLiveOwner
      request: PermissionRequest | QuestionRequest
      kind: 'permission' | 'question'
      persistence: 'pending'
    }>,
  ): { retire(): void }
}
type Prepared = {
  request: PermissionRequest | QuestionRequest
  kind: 'permission' | 'question'
  toolCallId: string
  answer(input: unknown): unknown
}
type Entry = {
  native: JsonRpcRequest
  owner: AcpLiveOwner
  prepared: Prepared
  state: 'pending' | 'replying' | 'retired' | 'submitted'
  finished: boolean
  done: Promise<void>
  finish(): void
  broker: { retire(): void }
  brokerLive: boolean
  credits: ReturnType<AcpJournal['reserveCredits']>
  release(): void
  timer: ReturnType<typeof setTimeout>
  abort(): void
}
export class AcpInteractions {
  private readonly entries = new Map<string, Entry>()
  constructor(
    private readonly options: {
      profile: string
      rpc: JsonlRpcTransport
      transportGeneration: string
      journal: AcpJournal
      host: AcpResourceHost
      instanceId: string
      broker: AcpInteractionBroker
      event(
        owner: AcpLiveOwner,
        body:
          | { type: 'permission_requested'; request: PermissionRequest }
          | { type: 'question_requested'; request: QuestionRequest },
      ): HarnessEvent
      emit(event: HarnessEvent): void
      fail(error: unknown): void
    },
  ) {}
  private prepare(
    native: JsonRpcRequest,
    owner: AcpLiveOwner,
    requestId: string,
  ): Prepared {
    if (native.method === 'session/request_permission') {
      const params = zRequestPermissionRequest.parse(
        immutableData(native.params, 256 * 1024),
      )
      if (
        params.sessionId !== owner.binding.providerSessionId ||
        params.options.length > 64 ||
        new Set(params.options.map((option) => option.optionId)).size !==
          params.options.length
      )
        throw Error('ACP permission ownership or options are invalid')
      const request: PermissionRequest = immutableData({
        requestId,
        toolCallId: params.toolCall.toolCallId,
        title: params.toolCall.title ?? 'Permission requested',
        options: params.options.map((option) => ({
          id: option.optionId,
          label: option.name,
        })),
      })
      return {
        request,
        toolCallId: params.toolCall.toolCallId,
        kind: 'permission',
        answer(input) {
          const reply = permissionReplySchema.parse(
            immutableData(input, 256 * 1024),
          )
          if (reply.requestId !== requestId)
            throw Error('ACP permission request differs')
          if (
            reply.type === 'granted' ||
            (reply.type === 'selected' &&
              (reply.grant !== undefined || reply.scope !== undefined))
          )
            throw Error('ACP structured permission grants are unsupported')
          if (reply.type === 'denied')
            return { outcome: { outcome: 'cancelled' } }
          if (
            !params.options.some((option) => option.optionId === reply.optionId)
          )
            throw Error('ACP permission option was not offered')
          return { outcome: { outcome: 'selected', optionId: reply.optionId } }
        },
      }
    }
    if (
      this.options.profile === 'grok' &&
      native.method === '_x.ai/ask_user_question'
    ) {
      const prepared = prepareGrokQuestions(requestId, native.params)
      if (prepared.sessionId !== owner.binding.providerSessionId)
        throw Error('ACP question owner differs')
      return {
        request: prepared.request,
        kind: 'question',
        toolCallId: prepared.toolCallId,
        answer: (input) =>
          prepared.answer(input as Record<string, QuestionAnswer>),
      }
    }
    throw Error('Unsupported ACP interaction method')
  }
  async receive(
    native: JsonRpcRequest,
    owner: AcpLiveOwner,
    ticket: AcpTicket,
  ) {
    if (
      Buffer.byteLength(native.method) > 512 ||
      (typeof native.id === 'string' && Buffer.byteLength(native.id) > 512)
    )
      throw Error('ACP interaction identity limit')
    if (this.entries.size >= 32) throw Error('ACP request limit')
    const requestId = randomUUID()
    const prepared = this.prepare(native, owner, requestId)
    if (
      native.runtimeGeneration !== this.options.transportGeneration ||
      native.signal.aborted
    )
      throw Error('Stale ACP interaction')
    const releaseRequest = this.options.host.reserve(
      this.options.instanceId,
      'requests',
    )
    let releaseHandler: (() => void) | undefined,
      credits: Entry['credits'] | undefined,
      broker: Entry['broker'] | undefined,
      registered: Entry | undefined
    try {
      releaseHandler = this.options.host.reserve(
        this.options.instanceId,
        'handlers',
      )
      credits = this.options.journal.reserveCredits(3)
      let finish!: () => void
      const done = new Promise<void>((resolve) => {
        finish = resolve
      })
      const capturedCredits = credits,
        capturedRelease = releaseHandler
      const entry: Entry = {
        native,
        owner: immutableData(owner),
        prepared,
        state: 'pending',
        finished: false,
        done,
        finish,
        broker: { retire() {} },
        brokerLive: false,
        credits: capturedCredits,
        release: () => {
          capturedCredits.release()
          capturedRelease()
          releaseRequest()
        },
        timer: setTimeout(
          () => {
            void this.retire(requestId).catch(this.options.fail)
          },
          this.options.profile === 'hermes' ? 60000 : 300000,
        ),
        abort: () => {
          if (entry.state === 'pending')
            void this.retire(requestId).catch(this.options.fail)
        },
      }
      registered = entry
      this.entries.set(requestId, entry)
      native.signal.addEventListener('abort', entry.abort, { once: true })
      broker = this.options.broker.admit(
        immutableData({
          owner,
          request: prepared.request,
          kind: prepared.kind,
          persistence: 'pending',
        }),
      )
      entry.broker = broker
      entry.brokerLive = true
      if (entry.state === 'retired') this.retireBroker(entry)

      const event =
        prepared.kind === 'permission'
          ? this.options.event(owner, {
              type: 'permission_requested',
              request: prepared.request as PermissionRequest,
            })
          : this.options.event(owner, {
              type: 'question_requested',
              request: prepared.request as QuestionRequest,
            })
      ticket.finish([
        { value: { kind: 'interaction', requestId, status: 'pending' } },
        { value: { kind: 'event', event } },
      ])
      void ticket.committed
        .then(() => {
          if (entry.state !== 'retired') this.options.emit(event)
        })
        .catch(this.options.fail)
      await done
    } catch (error) {
      if (registered) {
        try {
          ticket.finish([{ value: { kind: 'disposition', status: 'failed' } }])
        } catch {
          /* An existing or failed ticket keeps its original state. */
        }
        await this.retire(requestId)
      } else {
        broker?.retire()
        credits?.release()
        releaseHandler?.()
        releaseRequest()
      }
      throw error
    }
  }
  replyPermission(reply: PermissionReply) {
    const captured = immutableData(reply)
    return this.reply(captured.requestId, 'permission', captured)
  }
  replyQuestion(requestId: string, answers: Record<string, QuestionAnswer>) {
    return this.reply(requestId, 'question', answers)
  }
  private async reply(
    requestId: string,
    kind: Prepared['kind'],
    input: unknown,
  ) {
    const entry = this.entries.get(requestId)
    if (
      !entry ||
      entry.state !== 'pending' ||
      entry.prepared.kind !== kind ||
      entry.native.signal.aborted
    )
      throw Error('ACP interaction is not answerable')
    const result = entry.prepared.answer(input)
    entry.state = 'replying'
    const write = this.options.rpc.respondWithSubmission(entry.native, result)
    void write.logical.catch(() => {})
    const evidence = await write.submission
    if (
      evidence.status === 'not_written' &&
      !entry.native.signal.aborted &&
      entry.state === 'replying'
    ) {
      entry.state = 'pending'
      throw Error('ACP reply was not written')
    }
    const status =
      evidence.status === 'written' &&
      evidence.cancellation === 'none' &&
      entry.state === 'replying'
        ? 'submitted'
        : evidence.status === 'not_written'
          ? 'retired'
          : 'indeterminate'
    try {
      entry.credits.consume()
      const ticket = this.options.journal.reserve(entry.owner, {
        kind: 'request',
        producerTicket: requestId,
      })
      ticket.finish([{ value: { kind: 'interaction', requestId, status } }])
      await ticket.committed
      if (status !== 'submitted')
        throw Error(
          status === 'retired'
            ? 'ACP reply was withdrawn before write'
            : 'ACP reply delivery is indeterminate',
        )
      entry.state = 'submitted'
    } finally {
      this.finish(requestId, entry)
    }
  }
  private retireBroker(entry: Entry) {
    if (!entry.brokerLive) return
    entry.brokerLive = false
    try {
      entry.broker.retire()
    } catch (error) {
      try {
        this.options.fail(error)
      } catch {
        /* Cleanup must still release original ownership. */
      }
    }
  }
  private finish(requestId: string, entry: Entry) {
    if (entry.finished) return
    entry.finished = true
    clearTimeout(entry.timer)
    entry.native.signal.removeEventListener('abort', entry.abort)
    this.retireBroker(entry)
    this.entries.delete(requestId)
    entry.release()
    entry.finish()
  }
  async retire(requestId: string) {
    const entry = this.entries.get(requestId)
    if (!entry) return
    if (entry.state === 'retired' || entry.state === 'submitted')
      return entry.done
    const writing = entry.state === 'replying'
    entry.state = 'retired'
    this.retireBroker(entry)
    this.options.rpc.dismiss(entry.native)
    if (writing) return entry.done
    try {
      entry.credits.consume()
      const ticket = this.options.journal.reserve(entry.owner, {
        kind: 'request',
        producerTicket: requestId,
      })
      ticket.finish([
        { value: { kind: 'interaction', requestId, status: 'retired' } },
      ])
      await ticket.committed
    } finally {
      this.finish(requestId, entry)
    }
  }
  async retireOwner(owner: AcpLiveOwner) {
    await Promise.all(
      [...this.entries]
        .filter(([, entry]) => digest(entry.owner) === digest(owner))
        .map(([id]) => this.retire(id)),
    )
  }
}
