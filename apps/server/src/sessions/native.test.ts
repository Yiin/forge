import { DatabaseSync } from 'node:sqlite'
import { migrate } from '../db/migrate.js'
import { createProject, createSession } from '../db/queries.js'
import { EventBus } from '../events/bus.js'
import { NativeInteractions } from './native-interactions.js'
import { describe, expect, it, vi } from 'vitest'
import {
  createCompletionHandle,
  type HarnessAdapter,
} from '../harnesses/types.js'
import { nativeHarness } from './native.js'

describe('native session bridge', () => {
  it('keeps the provider completion authoritative and translates typed events', async () => {
    let expired = false
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
          get requiresResume() {
            return expired
          },
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
    expect(handle.requiresResume).toBe(false)
    expired = true
    expect(handle.requiresResume).toBe(true)
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
  it('calls forwarded handle methods on the provider handle', async () => {
    class Provider {
      private model = 'default'
      private options = new Map<string, string | boolean>()
      async setModel(model: string) {
        this.model = model
      }
      configOptions() {
        return [...this.options].map(([id, value]) => ({
          id,
          name: id,
          type: 'select' as const,
          currentValue: String(value),
          options: [],
        }))
      }
      async setConfigOption(id: string, value: string | boolean) {
        this.options.set(id, value)
      }
      currentModel() {
        return this.model
      }
      prompt() {
        throw new Error('unused')
      }
      cancel() {}
      kill() {}
    }
    const provider = new Provider()
    const adapter = {
      kind: 'native',
      capabilities: {
        loadSession: false,
        steer: false,
        queue: false,
        cancel: true,
        permissions: false,
        questions: false,
        models: true,
      },
      spawn: async () => provider,
    } as unknown as HarnessAdapter
    const handle = await nativeHarness(adapter).spawn(
      { id: 'session-1', cwd: process.cwd(), harness: 'fake' },
      () => undefined,
      () => undefined,
    )
    await handle.setModel!('opus')
    await handle.setConfigOption!('effort', 'high')
    expect(provider.currentModel()).toBe('opus')
    expect(handle.configOptions!()).toMatchObject([
      { id: 'effort', currentValue: 'high' },
    ])
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

  it('keeps the code and message of a failed turn', async () => {
    const fake = interactiveAdapter()
    const received: any[] = []
    await nativeHarness(fake.adapter).spawn(
      { id: 'session-1', cwd: process.cwd(), harness: 'fake' },
      (value) => received.push(value),
      () => {},
    )
    fake.emit({
      type: 'turn_completed',
      turnId: 'turn-1',
      outcome: {
        status: 'failed',
        code: 'auth_required',
        message: 'Failed to authenticate: OAuth session expired',
      },
    })
    expect(received).toEqual([
      {
        type: 'turn_interrupted',
        reason: 'failed',
        code: 'auth_required',
        message: 'Failed to authenticate: OAuth session expired',
        turnId: 'turn-1',
      },
    ])
  })

  it('rejects a foreign typed option before durable reply admission', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const project = createProject(db, { name: 'native', path: '/tmp' })
    const session = createSession(db, {
      projectId: project.id,
      harness: 'mock',
      title: 'native',
      cwd: '/tmp',
    })
    const service = new NativeInteractions(db, new EventBus())
    const fake = interactiveAdapter()
    const handle = await nativeHarness(fake.adapter, undefined, service).spawn(
      { id: session.id, cwd: '/tmp', harness: 'mock' },
      () => {},
      () => {},
    )
    try {
      fake.emit({
        type: 'permission_requested',
        runtimeGeneration: 'original-generation',
        turnId: 'turn',
        itemId: 'item',
        request: {
          requestId: 'original',
          toolCallId: null,
          title: 'Allow?',
          options: [{ id: 'allow', label: 'Allow' }],
        },
      })
      await expect(
        service.answerQuestion(session.id, 'original', {
          answer: { type: 'selected', optionId: 'unknown' },
        }),
      ).rejects.toMatchObject({ status: 400 })
      expect(
        db.prepare('SELECT status FROM native_interactions').get()?.status,
      ).toBe('pending')
      expect(fake.permissionReplies).toEqual([])
      await service.answerQuestion(session.id, 'original', {
        answer: { type: 'selected', optionId: 'allow' },
      })
      expect(fake.permissionReplies).toEqual([
        { type: 'selected', requestId: 'original', optionId: 'allow' },
      ])
    } finally {
      await handle.kill()
      db.close()
    }
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

  it('approves a permission request in yolo mode and surfaces it in manual mode', async () => {
    const fake = interactiveAdapter()
    const items: unknown[] = []
    const handle = await nativeHarness(fake.adapter).spawn(
      { id: 'session-1', cwd: process.cwd(), harness: 'fake' },
      (item) => items.push(item),
      () => undefined,
    )
    const request = (requestId: string) =>
      fake.emit({
        type: 'permission_requested',
        turnId: 'turn-1',
        itemId: requestId,
        request: {
          requestId,
          toolCallId: null,
          title: 'Run the command?',
          options: [
            { id: 'no', label: 'Reject', kind: 'reject_once' },
            { id: 'yes', label: 'Allow once', kind: 'allow_once' },
          ],
        },
      })
    expect(handle.configOptions!()).toContainEqual(
      expect.objectContaining({ id: 'permissionMode', currentValue: 'yolo' }),
    )
    request('request-1')
    await vi.waitFor(() =>
      expect(fake.permissionReplies).toEqual([
        { type: 'selected', requestId: 'request-1', optionId: 'yes' },
      ]),
    )
    expect(items).toEqual([])
    await handle.setConfigOption!('permissionMode', 'manual')
    request('request-2')
    await Promise.resolve()
    expect(fake.permissionReplies).toHaveLength(1)
    expect(items).toHaveLength(1)
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

  it('replays events an adapter emitted before its handle resolved', async () => {
    const received: any[] = []
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
        callback({ type: 'turn_started', turnId: 'turn-1' })
        callback({
          type: 'text_delta',
          turnId: 'turn-1',
          itemId: 'item-1',
          text: 'early',
        })
        expect(received).toEqual([])
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
        }
      },
    } as unknown as HarnessAdapter
    await nativeHarness(adapter).spawn(
      { id: 'session-1', cwd: process.cwd(), harness: 'fake' },
      (value) => received.push(value),
      () => undefined,
    )
    expect(received).toEqual([
      { type: 'turn_start', turnId: 'turn-1' },
      { type: 'text_delta', turnId: 'turn-1', itemId: 'item-1', text: 'early' },
    ])
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
