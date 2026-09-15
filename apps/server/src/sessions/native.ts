import type { HarnessAdapter, HarnessEvent } from '../harnesses/types.js'
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
    const handle = await (resume ? adapter.load : adapter.spawn)!(
      nativeSession,
      (event) => {
        const normalized = item(event)
        if (normalized) onItem(normalized)
        if (event.type === 'run_failed') onExit(new Error(event.message))
        if (
          event.type === 'turn_completed' &&
          event.outcome.status !== 'completed'
        )
          onExit(new Error(event.outcome.status))
      },
    )
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
      answerQuestion: handle.replyQuestion
        ? (id, answer) =>
            handle.replyQuestion!(id, {
              [id]: { type: 'free_text', text: answer },
            })
        : undefined,
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
