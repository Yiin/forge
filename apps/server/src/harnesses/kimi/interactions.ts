import { randomUUID } from 'node:crypto'
import type { HarnessEvent, PermissionReply, QuestionAnswer } from '../types.js'
import {
  permissionReplySchema,
  questionAnswerSchema,
} from '@forge/protocol/harness'
import { KimiError, boundedString, jsonBytes, reserveAll } from './limits.js'
import { object } from './transport.js'
import { digest, record, type KimiRecords } from './records.js'
import type { KimiRoot } from './types.js'
import type { KimiLease } from './host.js'

type Request = {
  id: string
  nativeId: string
  kind: 'question' | 'approval'
  root: KimiRoot
  turn: string
  agent: string
  raw: Record<string, unknown>
  state: 'pending' | 'replying' | 'submitted' | 'expired' | 'unknown'
  options: Map<string, Record<string, unknown>>
  release: () => void
  hash: string
  cancelled: boolean
}
export class KimiInteractions {
  private readonly requests = new Map<string, Request>()
  private readonly tombstones = new Map<string, () => void>()
  constructor(
    private readonly records: KimiRecords,
    private readonly lease: KimiLease,
    private readonly mutate: <T>(work: () => Promise<T>) => Promise<T>,
    private readonly uncertain: (error: Error) => Promise<void>,
  ) {}
  private base(request: Request) {
    return {
      ...request.root,
      runtimeGeneration: this.records.scope.runtimeGeneration,
      deliveryId: '',
      providerTurnId: request.turn,
      itemId: request.id,
      ...(request.root.childId ? { childId: request.root.childId } : {}),
    }
  }
  async observe(
    kind: 'question' | 'approval',
    raw: Record<string, unknown>,
    root: KimiRoot,
    turn: string,
    agent: string,
  ) {
    const limits = this.records.budget.limits
    const nativeId = boundedString(raw[`${kind}_id`], limits.nativeIdBytes)
    const id = digest([
      this.records.scope.runtimeGeneration,
      this.records.scope.binding.providerSessionId,
      agent,
      kind,
      nativeId,
    ])
    const clean = { ...raw }
    delete clean.type
    delete clean.sessionId
    delete clean.agentId
    const existing = this.requests.get(id)
    if (existing) {
      if (existing.hash !== digest(clean))
        throw new KimiError('kimi_request_conflict')
      return
    }
    const size = jsonBytes(clean, limits, limits.questionTextBytes)
    const release = reserveAll([
      [this.records.budget, 'interactions'],
      [this.records.budget, 'interactionBytes', size],
      [this.records.host.budget, 'hostRetainedBytes', size],
    ])
    const request: Request = {
      id,
      nativeId,
      kind,
      root,
      turn,
      agent,
      raw: clean,
      state: 'pending',
      options: new Map(),
      release,
      hash: digest(clean),
      cancelled: false,
    }
    try {
      this.requests.set(id, request)
      // This event already passed durable replay. A late pending-list row alone cannot enter this method.
      const pending = object(
        await this.lease.server.http(
          this.lease.lane,
          this.path(kind) + '?status=pending',
        ),
      )
      if (!Array.isArray(pending.items))
        throw new KimiError('kimi_pending_invalid')
      const observed = pending.items
        .map(object)
        .find((item) => item[`${kind}_id`] === nativeId)
      if (!observed || digest(observed) !== digest(clean)) {
        request.state = 'expired'
        this.closeRequest(request)
        return
      }
      let event: HarnessEvent
      if (kind === 'question') {
        if (
          !Array.isArray(clean.questions) ||
          !clean.questions.length ||
          clean.questions.length > limits.questionItems
        )
          throw new KimiError('kimi_question_items')
        const questions = clean.questions.map((value) => {
          const question = object(value)
          if (
            !Array.isArray(question.options) ||
            question.options.length > limits.questionOptions
          )
            throw new KimiError('kimi_question_options')
          return {
            id: boundedString(question.id, limits.nativeIdBytes),
            question: boundedString(
              question.question,
              limits.questionTextBytes,
            ),
            ...(typeof question.header === 'string'
              ? { header: question.header }
              : {}),
            options: question.options.map((value) => {
              const option = object(value)
              return {
                id: boundedString(option.id, limits.nativeIdBytes),
                label: boundedString(option.label, limits.questionTextBytes),
                ...(typeof option.description === 'string'
                  ? { description: option.description }
                  : {}),
              }
            }),
            multiSelect: question.multi_select === true,
            allowFreeInput: question.allow_other === true,
            ...(question.is_secret === true ? { isSecret: true } : {}),
          }
        })
        if (
          new Set(questions.map((q) => q.id)).size !== questions.length ||
          questions.some(
            (q) =>
              new Set(q.options.map((o) => o.id)).size !== q.options.length,
          )
        )
          throw new KimiError('kimi_question_duplicate_ids')
        event = {
          ...this.base(request),
          type: 'question_requested',
          request: { requestId: id, isBlocking: true, questions },
        }
      } else {
        request.options.set('approve_once', { decision: 'approved' })
        request.options.set('reject', { decision: 'rejected' })
        const display =
          clean.tool_input_display &&
          typeof clean.tool_input_display === 'object'
            ? object(clean.tool_input_display)
            : undefined
        const options = [
          { id: 'approve_once', label: 'Approve once' },
          { id: 'reject', label: 'Reject' },
        ]
        if (display?.kind === 'plan_review') {
          const tool = boundedString(clean.tool_call_id, limits.nativeIdBytes)
          const response = object(
            await this.lease.server.http(
              this.lease.lane,
              `/api/v1/sessions/${encodeURIComponent(this.records.scope.binding.providerSessionId)}/transcript/plan?agent_id=${encodeURIComponent(agent)}&tool_call_id=${encodeURIComponent(tool)}`,
              { maxBytes: limits.httpJsonBytes },
            ),
          )
          if (
            response.agent_id !== agent ||
            !Array.isArray(response.plans) ||
            response.plans.length !== 1 ||
            object(response.plans[0]).tool_call_id !== tool
          )
            throw new KimiError('kimi_plan_identity')
          const plan = object(response.plans[0]),
            text = boundedString(plan.plan, limits.retainedItemBytes, true)
          await this.records.commit(
            [id, 'plan'],
            [
              record(
                this.records.scope,
                'live-projection',
                [agent, tool, digest(plan)],
                'plan',
                plan,
                root,
                agent,
              ),
            ],
            [
              {
                ...this.base(request),
                type: 'content_snapshot',
                contentType: 'plan',
                text,
              },
            ],
          )
          if (Array.isArray(display.options) && display.options.length) {
            options.splice(0)
            request.options.clear()
            for (const [index, value] of display.options.entries()) {
              const offered = object(value),
                label = boundedString(offered.label, limits.questionTextBytes),
                key = digest([id, index])
              options.push({ id: key, label })
              request.options.set(key, {
                decision: 'approved',
                selected_label: label,
              })
            }
          }
          for (const [key, label, payload] of [
            [
              'revise',
              'Revise',
              { decision: 'rejected', selected_label: 'Revise' },
            ],
            [
              'reject_exit',
              'Reject and Exit',
              { decision: 'rejected', selected_label: 'Reject and Exit' },
            ],
            ['dismiss_plan', 'Dismiss plan', { decision: 'cancelled' }],
          ] as const) {
            options.push({ id: key, label })
            request.options.set(key, payload)
          }
        } else {
          options.push({
            id: 'approve_session',
            label: 'Approve for this session',
          })
          request.options.set('approve_session', {
            decision: 'approved',
            scope: 'session',
          })
        }
        event = {
          ...this.base(request),
          type: 'permission_requested',
          request: {
            requestId: id,
            toolCallId:
              typeof clean.tool_call_id === 'string'
                ? clean.tool_call_id
                : null,
            title:
              typeof clean.action === 'string'
                ? clean.action
                : 'Kimi permission request',
            options,
          },
        }
      }
      await this.records.commit(
        [id, 'requested'],
        [
          record(
            this.records.scope,
            'live-engine',
            [id, 'requested'],
            'request.pending',
            { requestId: id, nativeId, kind, raw: clean },
            root,
            agent,
          ),
        ],
        [event],
      )
    } catch (error) {
      release()
      this.requests.delete(id)
      throw error
    }
  }
  private path(kind: 'question' | 'approval') {
    return `/api/v1/sessions/${encodeURIComponent(this.records.scope.binding.providerSessionId)}/${kind}s`
  }
  private pending(id: string, kind: Request['kind']) {
    boundedString(id, this.records.budget.limits.forgeIdBytes)
    const request = this.requests.get(id)
    if (!request || request.kind !== kind || request.state !== 'pending')
      throw new KimiError('kimi_request_unavailable')
    return request
  }
  replyQuestion(id: string, answers: Record<string, QuestionAnswer>) {
    const request = this.pending(id, 'question'),
      limits = this.records.budget.limits
    jsonBytes(answers, limits, limits.replyBytes)
    const mapped: Record<string, unknown> = Object.create(null)
    const questions = (request.raw.questions as unknown[]).map(object)
    if (Object.keys(answers).length !== questions.length)
      throw new KimiError('kimi_question_incomplete')
    for (const question of questions) {
      const id = String(question.id)
      if (!Object.hasOwn(answers, id))
        throw new KimiError('kimi_question_incomplete')
      const answer = questionAnswerSchema.parse(answers[id])
      if (answer.type === 'skipped') {
        mapped[id] = { kind: 'skipped' }
        continue
      }
      if (answer.type === 'free_text' || answer.type === 'selected_with_text')
        if (question.allow_other !== true)
          throw new KimiError('kimi_question_free_input')
      if (answer.type === 'free_text') {
        mapped[id] = { kind: 'other', text: answer.text }
        continue
      }
      const allowed = new Set(
        (question.options as unknown[]).map((value) => object(value).id),
      )
      if (
        new Set(answer.optionIds).size !== answer.optionIds.length ||
        answer.optionIds.some((id) => !allowed.has(id))
      )
        throw new KimiError('kimi_question_option')
      if (answer.type === 'selected_with_text') {
        if (question.multi_select !== true)
          throw new KimiError('kimi_question_combined_single')
        mapped[id] = {
          kind: 'multi_with_other',
          option_ids: answer.optionIds,
          other_text: answer.text,
        }
      } else {
        if (
          !answer.optionIds.length ||
          (question.multi_select !== true && answer.optionIds.length !== 1)
        )
          throw new KimiError('kimi_question_cardinality')
        mapped[id] =
          question.multi_select === true
            ? { kind: 'multi', option_ids: answer.optionIds }
            : { kind: 'single', option_id: answer.optionIds[0] }
      }
    }
    return this.submit(request, { answers: mapped, method: 'click' })
  }
  dismissQuestion(id: string) {
    return this.submit(this.pending(id, 'question'), undefined, true)
  }
  replyPermission(reply: PermissionReply) {
    jsonBytes(
      reply,
      this.records.budget.limits,
      this.records.budget.limits.replyBytes,
    )
    reply = permissionReplySchema.parse(reply)
    const request = this.pending(reply.requestId, 'approval')
    if (
      reply.type === 'granted' ||
      (reply.type === 'selected' &&
        (reply.grant !== undefined || reply.scope !== undefined))
    )
      throw new KimiError('kimi_permission_restrictions_unsupported')
    const body =
      reply.type === 'denied'
        ? {
            decision: 'rejected',
            ...(reply.reason ? { feedback: reply.reason } : {}),
          }
        : request.options.get(reply.optionId)
    if (!body) throw new KimiError('kimi_permission_option')
    return this.submit(request, body)
  }
  private submit(request: Request, body: unknown, dismiss = false) {
    request.state = 'replying'
    const attempt = randomUUID()
    return this.mutate(async () => {
      try {
        await this.records.commit(
          [request.id, attempt, 'replying'],
          [
            record(
              this.records.scope,
              'local',
              [request.id, attempt, 'replying'],
              'request.replying',
              { requestId: request.id, attempt, body, dismiss },
              request.root,
            ),
          ],
        )
        if (request.state !== 'replying')
          throw new KimiError('kimi_request_unavailable')
        const response = object(
          await this.lease.server.http(
            this.lease.lane,
            `${this.path(request.kind)}/${encodeURIComponent(request.nativeId)}${dismiss ? ':dismiss' : ''}`,
            { method: 'POST', body, dismiss },
          ),
        )
        if (dismiss ? response.dismissed !== true : response.resolved !== true)
          throw new KimiError(
            'kimi_reply_unknown',
            'Kimi reply confirmation is unknown',
            true,
          )
        request.state = 'submitted'
        await this.records.commit(
          [request.id, attempt, 'submitted'],
          [
            record(
              this.records.scope,
              'local',
              [request.id, attempt, 'submitted'],
              'request.submitted',
              {
                requestId: request.id,
                attempt,
                dismissed: dismiss,
                body,
                nativeResponse: response,
              },
              request.root,
            ),
          ],
          request.cancelled
            ? []
            : [
                {
                  ...this.base(request),
                  type: 'request_cancelled',
                  requestId: request.id,
                  reason: dismiss ? 'Dismissed' : 'Submitted',
                },
              ],
        )
        request.cancelled = true
        this.closeRequest(request)
      } catch (error) {
        if (error instanceof KimiError && error.uncertain) {
          request.state = 'unknown'
          await this.records.commit(
            [request.id, attempt, 'unknown'],
            [
              record(
                this.records.scope,
                'local',
                [request.id, attempt, 'unknown'],
                'request.unknown',
                { requestId: request.id, attempt },
                request.root,
              ),
            ],
          )
          try {
            const pending = object(
              await this.lease.server.http(
                this.lease.lane,
                this.path(request.kind) + '?status=pending',
              ),
            )
            const transcript = object(
              await this.lease.server.http(
                this.lease.lane,
                `/api/v1/sessions/${encodeURIComponent(this.records.scope.binding.providerSessionId)}/transcript?agent_id=${encodeURIComponent(request.agent)}&page_size=${this.records.budget.limits.pageTurns}`,
                { maxBytes: this.records.budget.limits.httpJsonBytes },
              ),
            )
            const items = Array.isArray(pending.items) ? pending.items : []
            const interactions = Array.isArray(transcript.interactions)
              ? transcript.interactions
              : []
            await this.records.commit(
              [request.id, attempt, 'reconciliation'],
              [
                record(
                  this.records.scope,
                  'local',
                  [request.id, attempt, 'reconciliation'],
                  'request.reconciliation',
                  {
                    requestId: request.id,
                    stillPending: items.some(
                      (item) =>
                        object(item)[`${request.kind}_id`] === request.nativeId,
                    ),
                    observedInteraction:
                      interactions.find(
                        (item) =>
                          object(item).interactionId === request.nativeId,
                      ) ?? null,
                    confirmation: 'unknown',
                  },
                  request.root,
                ),
              ],
            )
          } catch {
            /* Failed reads cannot turn an unconfirmed mutation into success. */
          }
          await this.uncertain(error)
        } else if (request.state === 'replying') request.state = 'pending'
        throw error
      }
    })
  }
  private closeRequest(request: Request) {
    request.release()
    if (this.tombstones.has(request.id)) return
    const budget = this.records.budget,
      limits = budget.limits
    const bytes = jsonBytes(
      {
        id: request.id,
        nativeId: request.nativeId,
        hash: request.hash,
        root: request.root,
      },
      limits,
      limits.interactionTombstoneBytes,
    )
    while (
      this.tombstones.size &&
      (this.tombstones.size >= limits.interactionTombstones ||
        budget.count('interactionTombstoneBytes') + bytes >
          limits.interactionTombstoneBytes)
    ) {
      const first = this.tombstones.keys().next().value!
      this.tombstones.get(first)!()
      this.tombstones.delete(first)
      this.requests.delete(first)
    }
    const release = reserveAll([
      [budget, 'interactionTombstones'],
      [budget, 'interactionTombstoneBytes', bytes],
      [this.records.host.budget, 'hostRetainedBytes', bytes],
    ])
    this.tombstones.set(request.id, release)
    request.raw = {}
    request.options.clear()
  }
  async expire(reason: string, root?: KimiRoot, nativeId?: string) {
    const expired: Request[] = []
    for (const request of this.requests.values())
      if (
        (request.state === 'pending' ||
          request.state === 'replying' ||
          request.state === 'unknown') &&
        (!root ||
          (root.operationId === request.root.operationId &&
            root.runId === request.root.runId &&
            root.turnId === request.root.turnId &&
            root.childId === request.root.childId)) &&
        (!nativeId || nativeId === request.nativeId)
      ) {
        request.state = 'expired'
        this.closeRequest(request)
        if (!request.cancelled) expired.push(request)
        request.cancelled = true
      }
    if (expired.length)
      await this.records.commit(
        ['requests.expired', expired.map((r) => r.id)],
        expired.map((r) =>
          record(
            this.records.scope,
            'local',
            [r.id, 'expired'],
            'request.expired',
            { requestId: r.id, reason },
            r.root,
          ),
        ),
        expired.map((r) => ({
          ...this.base(r),
          type: 'request_cancelled',
          requestId: r.id,
          reason,
        })),
        undefined,
        !this.records.accepting,
      )
  }
  close() {
    for (const request of this.requests.values()) request.release()
    this.requests.clear()
    for (const release of this.tombstones.values()) release()
    this.tombstones.clear()
  }
}
