import { describe, expect, it } from 'vitest'
import {
  createCompletionHandle,
  type HarnessAdapter,
} from '../harnesses/types.js'
import { nativeHarness } from './native.js'

describe('native session bridge', () => {
  it('keeps the provider completion authoritative and translates typed events', async () => {
    let emit!: (event: any) => void
    const completion = createCompletionHandle({
      completionId: 'completion-1',
      runId: 'run-1',
      turnId: 'turn-1',
    })
    const adapter = {
      kind: 'native',
      capabilities: {
        loadSession: false,
        steer: false,
        queue: false,
        cancel: true,
        permissions: false,
        questions: false,
        models: false,
      },
      spawn: async (_session: any, callback: any) => {
        emit = callback
        return {
          binding: {
            provider: 'fake',
            accountId: null,
            cwd: process.cwd(),
            providerSessionId: 'provider-1',
          },
          prompt: () => ({
            receiptId: 'receipt-1',
            runId: 'run-1',
            turnId: 'turn-1',
            completion,
          }),
          cancel() {},
          kill() {},
        }
      },
    } as unknown as HarnessAdapter
    const received: any[] = []
    const bridged = nativeHarness(adapter)
    const handle = await bridged.spawn(
      { id: 'session-1', cwd: process.cwd(), harness: 'fake' },
      (value) => received.push(value),
      () => undefined,
    )
    const delivered = Promise.resolve(handle.prompt('hello'))
    emit({ type: 'turn_started', turnId: 'turn-1' })
    emit({
      type: 'text_delta',
      turnId: 'turn-1',
      itemId: 'item-1',
      text: 'hello',
    })
    expect(received).toEqual([
      { type: 'turn_start', turnId: 'turn-1' },
      { type: 'text_delta', turnId: 'turn-1', itemId: 'item-1', text: 'hello' },
    ])
    let settled = false
    void delivered.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    completion.settle({ status: 'completed', runId: 'run-1', turnId: 'turn-1' })
    await delivered
    expect(settled).toBe(true)
  })
})

describe('native session interaction bridge', () => {
  const interactiveAdapter = () => {
    const permissionReplies: any[] = []
    const questionReplies: any[] = []
    let emit!: (event: any) => void
    const adapter = {
      kind: 'native',
      capabilities: {
        loadSession: false,
        steer: false,
        queue: false,
        cancel: true,
        permissions: true,
        questions: true,
        models: false,
      },
      spawn: async (_session: any, callback: any) => {
        emit = callback
        return {
          binding: null,
          prompt: () => ({
            receiptId: 'receipt-1',
            runId: 'run-1',
            turnId: 'turn-1',
            completion: createCompletionHandle({
              completionId: 'completion-1',
              runId: 'run-1',
              turnId: 'turn-1',
            }),
          }),
          cancel() {},
          kill() {},
          replyPermission: (reply: any) => {
            permissionReplies.push(reply)
          },
          replyQuestion: (id: string, answers: any) => {
            questionReplies.push({ id, answers })
          },
        }
      },
    } as unknown as HarnessAdapter
    return {
      adapter,
      permissionReplies,
      questionReplies,
      emit: (event: any) => emit(event),
    }
  }

  it('reports an interrupted turn without ending the session process', async () => {
    const fake = interactiveAdapter()
    const received: any[] = []
    const exits: (Error | undefined)[] = []
    const handle = await nativeHarness(fake.adapter).spawn(
      { id: 'session-1', cwd: process.cwd(), harness: 'fake' },
      (value) => received.push(value),
      (error) => exits.push(error),
    )
    expect(handle).toBeDefined()
    fake.emit({
      type: 'turn_completed',
      turnId: 'turn-1',
      outcome: { status: 'interrupted', reason: 'cancelled' },
    })
    expect(received).toEqual([
      { type: 'turn_interrupted', reason: 'interrupted', turnId: 'turn-1' },
    ])
    expect(exits).toEqual([])
  })

  it('answers a permission request with the option id behind the chosen label', async () => {
    const fake = interactiveAdapter()
    const handle = await nativeHarness(fake.adapter).spawn(
      { id: 'session-1', cwd: process.cwd(), harness: 'fake' },
      () => undefined,
      () => undefined,
    )
    fake.emit({
      type: 'permission_requested',
      turnId: 'turn-1',
      itemId: 'item-1',
      request: {
        requestId: 'request-1',
        toolCallId: 'tool-1',
        title: 'Run the command?',
        options: [
          { id: 'allow_once', label: 'Allow once' },
          { id: 'reject_once', label: 'Reject' },
        ],
      },
    })
    await handle.answerQuestion!('request-1', 'Reject')
    expect(fake.permissionReplies).toEqual([
      { type: 'selected', requestId: 'request-1', optionId: 'reject_once' },
    ])
    expect(fake.questionReplies).toEqual([])
  })

  it('answers an extension question through the question channel', async () => {
    const fake = interactiveAdapter()
    const handle = await nativeHarness(fake.adapter).spawn(
      { id: 'session-1', cwd: process.cwd(), harness: 'fake' },
      () => undefined,
      () => undefined,
    )
    fake.emit({
      type: 'question_requested',
      turnId: 'turn-1',
      itemId: 'item-1',
      request: {
        requestId: 'request-2',
        questions: [
          {
            id: 'question-1',
            question: 'Which branch?',
            options: [
              { id: 'option-main', label: 'main' },
              { id: 'option-next', label: 'next' },
            ],
          },
        ],
      },
    })
    await handle.answerQuestion!('request-2', 'next')
    expect(fake.questionReplies).toEqual([
      {
        id: 'request-2',
        answers: {
          'question-1': { type: 'selected', optionIds: ['option-next'] },
        },
      },
    ])
    expect(fake.permissionReplies).toEqual([])
  })

  it('expires a cancelled request and forgets it', async () => {
    const fake = interactiveAdapter()
    const received: any[] = []
    const handle = await nativeHarness(fake.adapter).spawn(
      { id: 'session-1', cwd: process.cwd(), harness: 'fake' },
      (value) => received.push(value),
      () => undefined,
    )
    fake.emit({
      type: 'permission_requested',
      turnId: 'turn-1',
      itemId: 'item-1',
      request: {
        requestId: 'request-3',
        toolCallId: null,
        title: 'Run the command?',
        options: [{ id: 'allow_once', label: 'Allow once' }],
      },
    })
    fake.emit({ type: 'request_cancelled', requestId: 'request-3' })
    expect(received.at(-1)).toEqual({
      type: 'user_answer',
      questionId: 'request-3',
      expired: true,
    })
    expect(() => handle.answerQuestion!('request-3', 'Allow once')).toThrow(
      /Unknown native question/,
    )
    expect(fake.permissionReplies).toEqual([])
  })
})
