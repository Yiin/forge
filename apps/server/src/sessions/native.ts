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
      return make({ ...event })
    case 'usage_snapshot':
      return make({ ...event })
    case 'request_cancelled':
      return make({
        type: 'ask_user_question',
        questionId: event.requestId,
        requestStatus: 'expired',
        source: 'ext',
        turnId: undefined,
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
          'questions' in event.request ? event.request.questions : undefined,
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
  if (typeof answer === 'object' && answer !== null)
    return {
      ...(answer as PermissionReply),
      requestId: request.requestId,
    } as PermissionReply
  const selected = String(answer)
  const optionId =
    request.options.find(
      (option) => option.id === selected || option.label === selected,
    )?.id ?? selected
  return optionId === 'deny'
    ? { type: 'denied', requestId: request.requestId }
    : { type: 'selected', requestId: request.requestId, optionId }
}

function questionAnswers(
  request: Extract<HarnessEvent, { type: 'question_requested' }>['request'],
  answer: unknown,
): Record<string, QuestionAnswer> {
  if (typeof answer === 'object' && answer !== null && !Array.isArray(answer))
    return answer as Record<string, QuestionAnswer>
  const value = Array.isArray(answer) ? answer.map(String) : String(answer)
  return Object.fromEntries(
    request.questions.map((question) => [
      question.id,
      Array.isArray(value)
        ? { type: 'selected', optionIds: value }
        : question.options.some(
              (option) => option.id === value || option.label === value,
            )
          ? {
              type: 'selected',
              optionIds: [
                question.options.find(
                  (option) => option.id === value || option.label === value,
                )!.id,
              ],
            }
          : { type: 'free_text', text: value },
    ]),
  )
}

export function nativeHarness(
  adapter: HarnessAdapter,
  onBinding?: (sessionId: string, providerSessionId: string) => void,
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
    const processEvent = (event: HarnessEvent) => {
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
            : content.map((part) =>
                part.kind === 'text'
                  ? { type: 'text' as const, text: part.text }
                  : {
                      type: 'attachment' as const,
                      attachmentId:
                        part.path ?? ('name' in part ? part.name : ''),
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
                : content.map((part: import('./harness.js').PromptContent) => ({
                    type: 'text' as const,
                    text:
                      part.kind === 'text'
                        ? part.text
                        : 'name' in part
                          ? part.name
                          : (part.path ?? ''),
                  }))
            await handle.steer!(input)
          }
        : undefined,
      cancel: () => handle.cancel(),
      kill: () => handle.kill(),
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
