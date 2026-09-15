import {
  permissionReplySchema,
  questionAnswerSchema,
} from '@forge/protocol/harness'
import type { NativeInteractions } from './native-interactions.js'
import type {
  HarnessAdapter,
  HarnessEvent,
  PermissionReply,
  QuestionAnswer,
} from '../harnesses/types.js'
import type { HarnessHandle, HarnessItem, HarnessProcess } from './harness.js'

function item(event: HarnessEvent): HarnessItem | undefined {
  const make = (value: unknown) => value as HarnessItem
  switch (event.type) {
    case 'turn_started':
      return make({ type: 'turn_start', turnId: event.turnId })
    case 'text_delta':
    case 'thought_delta':
      return make({
        type: event.type,
        text: event.text,
        turnId: event.turnId,
        itemId: event.itemId,
      })
    case 'tool_started':
      return make({
        type: 'tool_call',
        toolCallId: event.toolCallId,
        name: event.name,
        input: event.input,
        turnId: event.turnId,
        itemId: event.itemId,
      })
    case 'tool_update':
      return make({
        type: 'tool_update',
        toolCallId: event.toolCallId,
        status: event.status,
        output: event.output,
        turnId: event.turnId,
        itemId: event.itemId,
      })
    case 'child_started':
      return make({
        type: 'tool_call',
        toolCallId: event.childId,
        name: 'child',
        input: { description: event.description },
        turnId: event.turnId,
        itemId: event.itemId,
      })
    case 'child_finished':
      return make({
        type: 'tool_update',
        toolCallId: event.childId,
        status: event.outcome.status,
        output: event.outcome,
        turnId: event.turnId,
        itemId: event.itemId,
      })
    case 'child_updated':
    case 'content_block':
    case 'file_change':
    case 'source_reference':
    case 'usage':
    case 'usage_snapshot':
      return make({ ...event })
    case 'request_cancelled':
      return make({
        type: 'user_answer',
        questionId: event.requestId,
        expired: true,
      })
    case 'plan':
      return make({
        type: 'plan',
        explanation: event.explanation ?? undefined,
        steps: event.steps,
        turnId: event.turnId,
        itemId: event.itemId,
      })
    case 'permission_requested':
    case 'question_requested':
      return make({
        type: 'ask_user_question',
        questionId: event.request.requestId,
        questions:
          'questions' in event.request
            ? event.request.questions
            : [
                {
                  id: event.request.requestId,
                  question: event.request.title,
                  options: event.request.options,
                  multiSelect: false,
                  allowFreeInput: false,
                },
              ],
        question: 'title' in event.request ? event.request.title : undefined,
        options:
          'options' in event.request
            ? event.request.options.map((option) => option.label)
            : undefined,
        source: event.type === 'permission_requested' ? 'permission' : 'ext',
        requestStatus: 'pending',
        toolName:
          'toolName' in event.request ? event.request.toolName : undefined,
        permissionScope:
          'scope' in event.request && event.request.scope === 'session'
            ? 'session'
            : 'once',
        turnId: event.turnId,
        itemId: event.itemId,
      })
    case 'diagnostic':
      return make({
        type: 'error',
        message: event.message,
        code: event.code,
        turnId: event.turnId,
        itemId: event.itemId,
      })
    case 'turn_completed':
      return event.outcome.status === 'completed'
        ? make({ type: 'turn_end', turnId: event.turnId })
        : make({
            type: 'turn_interrupted',
            reason: event.outcome.status,
            turnId: event.turnId,
          })
    case 'run_failed':
      return make({ type: 'error', message: event.message, code: event.code })
    default:
      return undefined
  }
}

function permissionReply(
  request: Extract<HarnessEvent, { type: 'permission_requested' }>['request'],
  answer: unknown,
): PermissionReply {
  if (typeof answer === 'object' && answer !== null && !Array.isArray(answer)) {
    const value = answer as Record<string, unknown>
    if ('type' in value) {
      const reply = permissionReplySchema.parse({
        ...value,
        requestId: request.requestId,
      })
      if (
        reply.type === 'selected' &&
        !request.options.some((option) => option.id === reply.optionId)
      )
        throw Error('Invalid permission option')
      return reply
    }
    if (Object.keys(value).length !== 1 || !(request.requestId in value))
      throw Error('Invalid permission answer')
    answer = value[request.requestId]
  }
  const selected = request.options.find(
    (option) => option.id === answer || option.label === answer,
  )
  if (!selected) throw Error('Invalid permission option')
  return {
    type: 'selected',
    requestId: request.requestId,
    optionId: selected.id,
  }
}

function questionAnswers(
  request: Extract<HarnessEvent, { type: 'question_requested' }>['request'],
  answer: unknown,
): Record<string, QuestionAnswer> {
  const values =
    typeof answer === 'object' && answer !== null && !Array.isArray(answer)
      ? (answer as Record<string, unknown>)
      : Object.fromEntries(request.questions.map((q) => [q.id, answer]))
  if (
    Object.keys(values).some(
      (key) => !request.questions.some((q) => q.id === key),
    )
  )
    throw Error('Unknown native question')
  return Object.fromEntries(
    request.questions.map((q) => {
      const value = values[q.id]
      const parsed = questionAnswerSchema.parse(
        value &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          'type' in value
          ? value
          : Array.isArray(value)
            ? { type: 'selected', optionIds: value }
            : typeof value === 'string' &&
                q.options.some((o) => o.id === value || o.label === value)
              ? {
                  type: 'selected',
                  optionIds: [
                    q.options.find((o) => o.id === value || o.label === value)!
                      .id,
                  ],
                }
              : value && typeof value === 'object'
                ? { type: 'selected_with_text', ...value }
                : { type: 'free_text', text: value },
      )
      if (
        'optionIds' in parsed &&
        (new Set(parsed.optionIds).size !== parsed.optionIds.length ||
          (!q.multiSelect && parsed.optionIds.length > 1) ||
          parsed.optionIds.some((id) => !q.options.some((o) => o.id === id)))
      )
        throw Error('Invalid native question option')
      if ('text' in parsed && !q.allowFreeInput)
        throw Error('Native question does not allow free text')
      return [q.id, parsed]
    }),
  )
}

export function nativeHarness(
  adapter: HarnessAdapter,
  onBinding?: (sessionId: string, providerSessionId: string) => void,
  interactions?: NativeInteractions,
): HarnessProcess {
  const open = async (
    session: import('./harness.js').HarnessSession,
    onItem: (item: HarnessItem) => void,
    onExit: (error?: Error) => void,
    resume: boolean,
  ): Promise<HarnessHandle> => {
    const nativeSession = {
      id: session.id,
      cwd: session.cwd,
      provider: session.harness,
      accountId: session.accountId ?? null,
      binding: session.providerSessionId
        ? {
            provider: session.harness,
            accountId: session.accountId ?? null,
            cwd: session.cwd,
            providerSessionId: session.providerSessionId,
          }
        : null,
    }
    const buffered: HarnessEvent[] = []
    let ready = false
    let nativeHandle: import('../harnesses/types.js').HarnessHandle | undefined
    const permissionRequests = new Map<
      string,
      Extract<HarnessEvent, { type: 'permission_requested' }>['request']
    >()
    const questionRequests = new Map<
      string,
      Extract<HarnessEvent, { type: 'question_requested' }>['request']
    >()
    let generation: string | undefined
    const processEvent = (event: HarnessEvent) => {
      generation ??= event.runtimeGeneration
      if (
        interactions &&
        (event.type === 'permission_requested' ||
          event.type === 'question_requested')
      ) {
        const original = nativeHandle!
        const captured = structuredClone(event)
        interactions.register(
          session.id,
          captured,
          item(captured)!,
          (answer, cancelled) => {
            if (captured.type === 'permission_requested') {
              const reply: PermissionReply = cancelled
                ? { type: 'denied', requestId: captured.request.requestId }
                : permissionReply(captured.request, answer)
              return async () => {
                await original.replyPermission!(reply)
              }
            }
            const replies = cancelled
              ? Object.fromEntries(
                  captured.request.questions.map((q) => [
                    q.id,
                    { type: 'skipped' as const },
                  ]),
                )
              : questionAnswers(captured.request, answer)
            return async () => {
              await original.replyQuestion!(captured.request.requestId, replies)
            }
          },
        )
        return
      }
      if (interactions && event.type === 'request_cancelled') {
        interactions.retire(event.runtimeGeneration, event.requestId)
        return
      }
      if (event.type === 'permission_requested')
        permissionRequests.set(event.request.requestId, event.request)
      if (event.type === 'question_requested')
        questionRequests.set(event.request.requestId, event.request)
      if (event.type === 'request_cancelled') {
        permissionRequests.delete(event.requestId)
        questionRequests.delete(event.requestId)
      }
      if (event.type === 'run_failed') onExit(new Error(event.message))
      const normalized = item(event)
      if (normalized) onItem(normalized)
    }
    const handle = await (resume ? adapter.load : adapter.spawn)!(
      nativeSession,
      (event) => {
        if (!ready) {
          buffered.push(event)
          return
        }
        if (event.type === 'turn_completed' && nativeHandle?.binding)
          onBinding?.(session.id, nativeHandle.binding.providerSessionId)
        processEvent(event)
      },
    )
    nativeHandle = handle
    ready = true
    for (const event of buffered) processEvent(event)
    if (handle.binding)
      onBinding?.(session.id, handle.binding.providerSessionId)
    return {
      prompt: (content) => {
        const input =
          typeof content === 'string'
            ? content
            : content.map((part: import('./harness.js').PromptContent) =>
                part.kind === 'text'
                  ? { type: 'text' as const, text: part.text }
                  : {
                      type: 'attachment' as const,
                      attachmentId: part.attachmentId ?? '',
                      mime: part.mime,
                    },
              )
        const receipt = handle.prompt(input)
        return Promise.resolve(receipt)
          .then((value) => value.completion)
          .then(() => undefined)
      },
      steer: handle.steer
        ? async (content) => {
            const input =
              typeof content === 'string'
                ? content
                : content.map((part: import('./harness.js').PromptContent) =>
                    part.kind === 'text'
                      ? { type: 'text' as const, text: part.text }
                      : {
                          type: 'attachment' as const,
                          attachmentId: part.attachmentId ?? '',
                          mime: part.mime,
                        },
                  )
            await handle.steer!(input)
          }
        : undefined,
      cancel: () => handle.cancel(),
      kill: async () => {
        try {
          await handle.kill()
        } finally {
          if (generation) interactions?.retire(generation)
        }
      },
      setModel: handle.setModel,
      configOptions: handle.configOptions,
      setConfigOption: handle.setConfigOption,
      answerQuestion: (id, answer) => {
        const permission = permissionRequests.get(id)
        if (handle.replyPermission && permission)
          return handle.replyPermission(permissionReply(permission, answer))
        if (!handle.replyQuestion) return undefined
        const request = questionRequests.get(id)
        if (!request) throw new Error(`Unknown native question ${id}`)
        return handle.replyQuestion(id, questionAnswers(request, answer))
      },
      availableModels: handle.availableModels,
    }
  }
  return {
    spawn: (session, onItem, onExit) => open(session, onItem, onExit, false),
    capabilities: {
      ...adapter.capabilities,
      loadSession: Boolean(adapter.load),
    },
    loadSession: adapter.load
      ? (session, onItem, onExit) =>
          open(session, onItem, onExit, true).then((handle) => ({
            handle,
            proven: true,
          }))
      : undefined,
  }
}
