import { z } from 'zod'
import {
  questionAnswerSchema,
  type QuestionRequest,
} from '@forge/protocol/harness'
import type { QuestionAnswer } from '../types.js'
import { redactSecrets } from '../diagnostics.js'
import {
  bytes,
  fail,
  freeze,
  id,
  MiB,
  snapshot,
  type PiLimits,
} from './wire.js'
import {
  uiMetadataSchema,
  uiRequestSchema,
  type PiRecordBody,
} from './normalize.js'

export type PiQuestionOwner = { runId: string; turnId: string }
type NativeQuestion = z.infer<typeof uiRequestSchema>
type NativeResponse = { type: 'extension_ui_response'; id: string } & (
  { value: string } | { confirmed: boolean } | { cancelled: true }
)
type Held = {
  requestId: string
  questionId: string
  native: NativeQuestion
  owner: PiQuestionOwner
  request: QuestionRequest
  state: 'pending' | 'replying' | 'expired' | 'submitted'
  expires: number
  timer: ReturnType<typeof setTimeout>
  size: number
}
export class PiQuestions {
  private requests = new Map<string, Held>()
  private nativeIds = new Set<string>()
  private retained = 0
  private closed = false
  private metadata = new Map<string, z.infer<typeof uiMetadataSchema>>()
  constructor(
    private readonly options: {
      limits: Readonly<PiLimits>
      secrets?: readonly string[]
      now: () => number
      nextId: () => string
      validOwner: (owner: PiQuestionOwner) => boolean
      send: (response: NativeResponse) => Promise<void>
      record: (body: PiRecordBody, owner?: PiQuestionOwner) => Promise<void>
      requested: (request: QuestionRequest, owner: PiQuestionOwner) => void
      expired: (
        requestId: string,
        reason: string,
        owner: PiQuestionOwner,
      ) => void
      pendingChanged: (waiting: boolean) => void
      fatal: (error: unknown) => void
    },
  ) {}
  get pendingCount() {
    return [...this.requests.values()].filter(
      (r) => r.state === 'pending' || r.state === 'replying',
    ).length
  }
  private changed() {
    this.options.pendingChanged(
      [...this.requests.values()].some((r) => r.state === 'pending'),
    )
  }
  receive(value: unknown, owner?: PiQuestionOwner) {
    if (this.closed) fail('PI_REQUEST_GENERATION_EXPIRED')
    const method = (value as { method?: string })?.method
    if (!['select', 'confirm', 'input', 'editor'].includes(method ?? '')) {
      const metadata = uiMetadataSchema.safeParse(value)
      if (!metadata.success) fail('PI_UNSUPPORTED_EXTENSION_UI')
      const native = freeze(metadata.data)
      const key =
        native.method === 'setStatus'
          ? `status:${native.statusKey}`
          : native.method === 'setWidget'
            ? `widget:${native.widgetKey}`
            : native.method
      if (
        (native.method === 'setStatus' && native.statusText === undefined) ||
        (native.method === 'setWidget' && native.widgetLines === undefined)
      )
        this.metadata.delete(key)
      else if (native.method !== 'notify') this.metadata.set(key, native)
      if (this.metadata.size > 130 || bytes([...this.metadata]) > MiB)
        fail('PI_UI_METADATA_LIMIT')
      void this.options
        .record({ type: 'ui_metadata', native }, owner)
        .catch(this.options.fatal)
      return
    }
    if (!owner)
      fail(
        'PI_STARTUP_UI_UNAVAILABLE',
        'Pi installs its input reader after blocking startup hooks finish.',
      )
    const native = freeze(uiRequestSchema.parse(value))
    if (this.nativeIds.has(native.id)) fail('PI_DUPLICATE_NATIVE_REQUEST')
    if (
      this.nativeIds.size >= this.options.limits.maxRequestIds ||
      this.pendingCount >= this.options.limits.maxQuestions
    )
      fail('PI_REQUEST_LIMIT')
    const size = bytes(native)
    if (this.retained + size > MiB) fail('PI_REQUEST_BYTES_LIMIT')
    const requestId = id.parse(this.options.nextId())
    const questionId = `${requestId}:q`
    const choices =
      native.method === 'select'
        ? native.options
        : native.method === 'confirm'
          ? ['Yes', 'No']
          : []
    const request: QuestionRequest = freeze({
      requestId,
      isBlocking: true,
      questions: [
        {
          id: questionId,
          header: redactSecrets(native.title, this.options.secrets),
          question: redactSecrets(
            native.method === 'confirm' ? native.message : native.title,
            this.options.secrets,
          ),
          options: choices.map((label, index) => ({
            id: `${requestId}:option:${index}`,
            label: redactSecrets(label, this.options.secrets),
          })),
          multiSelect: false,
          allowFreeInput:
            native.method === 'input' || native.method === 'editor',
        },
      ],
    })
    const nativeTimeout =
      'timeout' in native && native.timeout !== undefined && native.timeout > 0
        ? native.timeout
        : 900_000
    const lifetime = Math.min(
      900_000,
      Math.max(
        0,
        nativeTimeout -
          ('timeout' in native &&
          native.timeout !== undefined &&
          native.timeout > 0
            ? 250
            : 0),
      ),
    )
    const held: Held = {
      requestId,
      questionId,
      native,
      owner: freeze({ ...owner }),
      request,
      state: 'pending',
      expires: this.options.now() + lifetime,
      size,
      timer: setTimeout(
        () => this.expire(held, 'Pi dialog expired locally'),
        lifetime,
      ),
    }
    this.nativeIds.add(native.id)
    this.requests.set(requestId, held)
    this.retained += size
    this.changed()
    void this.options
      .record(
        { type: 'ui_request', requestId, native, status: 'pending' },
        held.owner,
      )
      .catch(this.options.fatal)
    this.options.requested(request, held.owner)
    if (lifetime === 0)
      this.expire(held, 'Pi dialog timeout leaves no reply window')
  }
  private expire(held: Held, reason: string) {
    if (held.state !== 'pending') return Promise.resolve()
    held.state = 'expired'
    clearTimeout(held.timer)
    this.requests.delete(held.requestId)
    this.retained -= held.size
    this.changed()
    if (!this.closed) {
      const persisted = this.options.record(
        {
          type: 'ui_request',
          requestId: held.requestId,
          native: held.native,
          status: 'expired',
          reason,
        },
        held.owner,
      )
      void persisted.catch(this.options.fatal)
      this.options.expired(held.requestId, reason, held.owner)
      return persisted
    }
    return Promise.resolve()
  }
  async reply(requestId: string, input: Record<string, QuestionAnswer>) {
    const held = this.requests.get(requestId)
    if (!held || held.state !== 'pending' || this.closed)
      fail('PI_REQUEST_UNAVAILABLE')
    held.state = 'replying'
    this.changed()
    let response: NativeResponse
    try {
      const answers = z
        .record(z.string(), questionAnswerSchema)
        .parse(snapshot(input, 128 * 1024))
      const keys = Object.keys(answers)
      if (keys.length !== 1 || keys[0] !== held.questionId)
        fail('PI_QUESTION_ANSWER_INVALID')
      const answer = answers[held.questionId]!
      if (answer.type === 'skipped')
        response = {
          type: 'extension_ui_response',
          id: held.native.id,
          cancelled: true,
        }
      else if (
        held.native.method === 'select' ||
        held.native.method === 'confirm'
      ) {
        if (answer.type !== 'selected' || answer.optionIds.length !== 1)
          fail('PI_QUESTION_ANSWER_INVALID')
        const index = held.request.questions[0]!.options.findIndex(
          (option) => option.id === answer.optionIds[0],
        )
        if (index < 0) fail('PI_QUESTION_ANSWER_INVALID')
        response =
          held.native.method === 'select'
            ? {
                type: 'extension_ui_response',
                id: held.native.id,
                value: held.native.options[index]!,
              }
            : {
                type: 'extension_ui_response',
                id: held.native.id,
                confirmed: index === 0,
              }
      } else {
        if (
          answer.type !== 'free_text' ||
          Buffer.byteLength(answer.text) > 64 * 1024
        )
          fail('PI_QUESTION_ANSWER_INVALID')
        response = {
          type: 'extension_ui_response',
          id: held.native.id,
          value: answer.text,
        }
      }
    } catch (error) {
      if (!this.closed && held.state === 'replying') held.state = 'pending'
      this.changed()
      throw error
    }
    return this.submit(held, response)
  }
  async cancel(requestId: string) {
    const held = this.requests.get(requestId)
    if (!held || held.state !== 'pending' || this.closed)
      fail('PI_REQUEST_UNAVAILABLE')
    held.state = 'replying'
    this.changed()
    return this.submit(held, {
      type: 'extension_ui_response',
      id: held.native.id,
      cancelled: true,
    })
  }
  private async submit(held: Held, response: NativeResponse) {
    if (
      this.closed ||
      !this.options.validOwner(held.owner) ||
      this.options.now() >= held.expires
    ) {
      held.state = 'pending'
      this.expire(held, 'Pi dialog owner expired')
      fail('PI_REQUEST_UNAVAILABLE')
    }
    clearTimeout(held.timer)
    try {
      // There is no native acknowledgement. A completed write proves submission only.
      await this.options.send(freeze(response))
      if (this.closed || !this.options.validOwner(held.owner))
        fail('PI_REQUEST_GENERATION_EXPIRED')
      await this.options.record(
        {
          type: 'ui_reply',
          requestId: held.requestId,
          native: response,
          status: 'submitted',
        },
        held.owner,
      )
      held.state = 'submitted'
      this.requests.delete(held.requestId)
      this.retained -= held.size
      this.changed()
    } catch (error) {
      this.options.fatal(error)
      throw error
    }
  }
  expireOwner(owner: PiQuestionOwner, reason: string) {
    for (const held of this.requests.values())
      if (
        held.owner.runId === owner.runId &&
        held.owner.turnId === owner.turnId
      )
        this.expire(held, reason)
  }
  async cancelPending() {
    const writes: Promise<void>[] = []
    for (const held of this.requests.values()) {
      if (held.state !== 'pending') continue
      writes.push(this.expire(held, 'Pi operation cancelled'))
      writes.push(
        this.options.send({
          type: 'extension_ui_response',
          id: held.native.id,
          cancelled: true,
        }),
      )
    }
    await Promise.all(writes)
  }
  close() {
    if (this.closed) return
    this.closed = true
    for (const held of this.requests.values()) {
      clearTimeout(held.timer)
      held.state = 'expired'
    }
    this.requests.clear()
    this.nativeIds.clear()
    this.metadata.clear()
    this.retained = 0
    this.changed()
  }
}
