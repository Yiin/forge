import { randomUUID } from 'node:crypto'
import { NativeCleanupError } from '../native-cleanup.js'
import {
  harnessEventSchema,
  type TerminalOutcome,
} from '@forge/protocol/harness'
import { zStopReason } from '@agentclientprotocol/sdk/dist/schema/zod.gen.js'
import {
  createCompletionHandle,
  type HarnessAdapter,
  type HarnessEvent,
  type HarnessHandle,
  type HarnessSession,
  type HarnessReceipt,
  type DispatchOptions,
  type PromptInput,
  type RejectingCompletionProducer,
} from '../types.js'
import type { JsonRpcRequest } from '../jsonrpc.js'
import { AcpConnection, type AcpFrame } from './connection.js'
import {
  AcpChildren,
  type AcpChildHistory,
  type AcpChildAdmission,
} from './children.js'
import { AcpInteractions, type AcpInteractionBroker } from './interactions.js'
import { createAcpContent } from './content.js'
import { AcpNormalizer } from './normalize.js'
import { openGrokPolicySession, captureAcpPrompt } from './policy.js'
import { AcpResponses } from './responses.js'
import { createAcpNativeSource } from './native-source.js'
import { nativeModeSelectorId } from './config.js'
import {
  createAcpTerminalHistory,
  type AcpTerminalHistory,
} from './terminal-history.js'
import {
  createAcpAttachments,
  type AcpAttachmentResolver,
} from './attachments.js'
import { immutableData, digest } from './data.js'
import {
  acpProviderDescriptors,
  captureLaunch,
  type AcpLaunch,
  type AcpProfile,
} from './profiles.js'
import type { AcpResourceHost } from './limits.js'
import type {
  AcpContentStore,
  AcpIngestionFactory,
  AcpLiveOwner,
  AcpReplayOwner,
  AcpRecordInput,
  AcpRecordOwner,
} from './ingestion.js'

export type AcpClientService = {
  receive(request: JsonRpcRequest, owner: AcpLiveOwner): Promise<boolean>
  close(): Promise<void>
}
export type AcpRuntimeDependencies = {
  profile: AcpProfile
  launch: AcpLaunch
  host: AcpResourceHost
  ingestion: AcpIngestionFactory
  contentStore: AcpContentStore
  authorizedAttachment: AcpAttachmentResolver
  broker: AcpInteractionBroker
  grokRail?: 'public' | 'comet'
  childHistory?: AcpChildHistory
  saveChildHistory?(
    session: HarnessSession,
    history: AcpChildHistory,
  ): Promise<void>
  services(
    connection: AcpConnection,
    terminalHistory: AcpTerminalHistory,
  ): Promise<{ filesystem: AcpClientService; terminals: AcpClientService }>
  failure(error: unknown): void
}
function candidate() {
  let resolve!: (value: TerminalOutcome) => void
  const promise = new Promise<TerminalOutcome>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
type Root = {
  owner: AcpLiveOwner
  receipt: HarnessReceipt
  completion: RejectingCompletionProducer
  controller: AbortController
  input: PromptInput[] | string
  options: DispatchOptions | undefined
  release: () => void
  releaseOwner: () => void
  credits: ReturnType<AcpConnection['journal']['reserveCredits']>
  notificationSelected?: boolean
  submitted: boolean
  candidate: ReturnType<typeof candidate>
  execution?: Promise<void>
  accepted: Promise<void>
  cancelled: boolean
  sealed: boolean
  events: number
  bytes: number
  queuedAt: number
}
const stop = (reason: string): TerminalOutcome =>
  reason === 'end_turn'
    ? { status: 'completed' }
    : reason === 'cancelled'
      ? { status: 'interrupted' }
      : {
          status: 'failed',
          code: `acp_${reason}`,
          message: 'ACP prompt did not complete',
        }

export function createTypedAcpAdapter(
  deps: AcpRuntimeDependencies,
): HarnessAdapter {
  deps = Object.freeze({
    ...deps,
    launch: captureLaunch(deps.profile, deps.launch),
  })
  const renewalRequired = new WeakSet<HarnessHandle>()
  const replacements = new WeakMap<
    HarnessHandle,
    (policy: 'manual' | 'yolo') => Promise<void>
  >()
  const profile = deps.profile
  const open = async (
    session: HarnessSession,
    emit: (event: HarnessEvent) => void,
    load: boolean,
    initialPolicy: 'manual' | 'yolo' = 'manual',
  ): Promise<HarnessHandle> => {
    session = immutableData(session)
    const instanceId = deps.launch.providerInstanceId
    const createdAt = Date.now()
    const content = createAcpContent({
      host: deps.host,
      instanceId,
      store: deps.contentStore,
    })
    const normalizer = new AcpNormalizer(content, deps.host, instanceId)
    const nativeSource = createAcpNativeSource({
      content,
      host: deps.host,
      instanceId,
    })
    const responses = new AcpResponses({
      content,
      host: deps.host,
      instanceId,
      record: (subject, body, refs) => normalizer.record(subject, body, refs),
      item: (subject, kind) => normalizer.itemId(subject, kind),
    })
    const attachments = createAcpAttachments({
      host: deps.host,
      instanceId,
      authorizedAttachment: deps.authorizedAttachment,
    })
    let connection: AcpConnection | undefined,
      services:
        Awaited<ReturnType<AcpRuntimeDependencies['services']>> | undefined,
      interactions: AcpInteractions | undefined
    let terminalHistory: AcpTerminalHistory | undefined
    let closePromise: Promise<void> | undefined
    let current: Root | undefined,
      closing = false,
      failed: unknown,
      contentChain = Promise.resolve(),
      published = 0,
      publishedBytes = 0,
      rootCount = 0,
      nativeMode: string | undefined,
      configurationPending = false
    const roots = new Map<string, Root>(),
      prompts = new Map<string, AcpLiveOwner>(),
      queue: Root[] = [],
      handlers = new Set<Promise<void>>()
    const dispatch = (options: Partial<DispatchOptions>) => {
      if (profile === 'grok') {
        if ((options.permissionMode ?? 'manual') !== initialPolicy)
          throw Error('ACP permission policy requires a new runtime')
        return connection!.catalog.dispatch({
          ...options,
          permissionMode: undefined,
        })
      }
      return connection!.catalog.dispatch(options, nativeMode)
    }
    let retireSealedRoot: (
      owner: AcpLiveOwner | AcpReplayOwner,
    ) => void = () => {}
    const replayOwners = new Map<string, AcpReplayOwner>()
    const modelWaiters = new Set<() => void>()
    const event = (owner: AcpLiveOwner, body: Record<string, unknown>) =>
      harnessEventSchema.parse({
        ...body,
        runId: owner.runId,
        turnId: owner.turnId,
        runtimeGeneration: owner.runtimeGeneration,
        deliveryId: randomUUID(),
      })
    const publish = (value: HarnessEvent) => {
      if (failed && value.type !== 'turn_completed')
        throw Error('ACP publication is fenced')
      const release = deps.host.reserve(instanceId, 'retained', 8 * 1024 * 1024)
      try {
        const bytes = Buffer.byteLength(JSON.stringify(value))
        const root = [...roots.values()].find(
          (root) =>
            root.owner.runId === value.runId &&
            root.owner.turnId ===
              ('turnId' in value ? value.turnId : root.owner.turnId),
        )
        if (
          bytes > 2 * 1024 * 1024 ||
          ++published > 100000 ||
          (publishedBytes += bytes) > 128 * 1024 * 1024 ||
          (root &&
            (++root.events > 20000 || (root.bytes += bytes) > 32 * 1024 * 1024))
        )
          throw Error('ACP publication limit')
        emit(value)
      } finally {
        release()
      }
    }
    const fail = (error: unknown) => {
      failed ??= error
      for (const notify of modelWaiters) notify()
      current?.candidate.resolve({
        status: 'failed',
        code: 'acp_runtime_failed',
        message: 'ACP runtime failed',
      })
      try {
        deps.failure(error)
      } catch {
        /* Preserve the original failure. */
      }
    }
    const children = new AcpChildren({
      profile,
      host: deps.host,
      instanceId,
      grokRail: deps.grokRail,
      restoredHistory: load ? (deps.childHistory ?? 'unavailable') : 'new',
      makeEvent: event,
    })
    const finishFrame = async (frame: AcpFrame, records: AcpRecordInput[]) => {
      try {
        frame.ticket.finish(
          records.length
            ? records
            : [{ value: { kind: 'disposition', status: 'ignored' } }],
        )
      } catch (error) {
        try {
          frame.ticket.failAdmission()
        } catch {
          /* Existing finished slots keep their original commit authority. */
        }
        throw error
      }
      await frame.ticket.committed
      for (const record of records)
        if (record.value.kind === 'event') publish(record.value.event)
    }
    const owned = (owner: AcpRecordOwner) =>
      owner.phase === 'live' ? roots.get(digest(owner)) : undefined
    const incoming = async (
      message: Parameters<
        NonNullable<import('./connection.js').AcpConnectionOptions['incoming']>
      >[0],
      frame: AcpFrame,
      io: AcpConnection,
    ) => {
      const owner = frame.owner
      if (message.type === 'request') {
        if (failed) {
          io.rpc.dismiss(message)
          await finishFrame(frame, [
            { value: { kind: 'disposition', status: 'failed' } },
          ])
          return
        }
        if (owner.phase !== 'live' || !owned(owner) || owned(owner)!.sealed) {
          io.rpc.dismiss(message)
          await finishFrame(frame, [])
          return
        }
        if (
          message.method === 'session/request_permission' ||
          (profile === 'grok' && message.method === '_x.ai/ask_user_question')
        ) {
          interactions ??= new AcpInteractions({
            profile,
            rpc: io.rpc,
            transportGeneration: io.transportGeneration,
            journal: io.journal,
            host: deps.host,
            instanceId,
            broker: deps.broker,
            event: (owner, body) =>
              event(owner, { ...body, itemId: randomUUID() }),
            emit: publish,
            fail,
          })
          await interactions.receive(message, owner, frame.ticket)
          return
        }
        if (
          (await services?.filesystem.receive(message, owner)) ||
          (await services?.terminals.receive(message, owner))
        ) {
          await finishFrame(frame, [])
          return
        }
        const reply = io.rpc.respondErrorWithSubmission(
          message,
          -32601,
          'Unsupported ACP method',
        )
        await reply.submission
        await reply.logical
        await finishFrame(frame, [])
        return
      }
      const process = async () => {
        if (failed) {
          await finishFrame(frame, [
            { value: { kind: 'disposition', status: 'failed' } },
          ])
          return
        }
        const params = message.params as Record<string, unknown> | undefined
        const nativeUpdate = params?.update as
          Record<string, unknown> | undefined
        const publicCompletion =
          deps.grokRail === 'public' &&
          message.method === '_x.ai/session/update' &&
          nativeUpdate?.sessionUpdate === 'turn_completed'
        if (
          profile === 'grok' &&
          (message.method === '_x.ai/session/prompt_complete' ||
            publicCompletion)
        ) {
          const promptId = publicCompletion
            ? nativeUpdate?.prompt_id
            : params?.promptId
          const reason = publicCompletion
            ? nativeUpdate?.stop_reason
            : params?.stopReason
          const original =
            typeof promptId === 'string' ? prompts.get(promptId) : undefined
          const root = original && owned(original)
          const eligible =
            root &&
            root.submitted &&
            !root.sealed &&
            owner.phase === 'live' &&
            digest(owner) === digest(original) &&
            params?.sessionId === original.binding.providerSessionId
          const outcome = eligible
            ? stop(reason === 'error' ? reason : zStopReason.parse(reason))
            : undefined
          const records =
            eligible && publicCompletion
              ? await normalizer.usage(
                  nativeUpdate?.usage,
                  'grok_prompt',
                  frame.numbers,
                  '/params/update/usage',
                  { owner: original },
                  root.controller.signal,
                )
              : []
          if (owner.phase === 'live' || owner.phase === 'load_replay')
            records.push(
              await nativeSource.source(
                { owner, itemId: `native-${frame.wireOrdinal}` },
                message.method,
                params,
                frame.numbers,
                new AbortController().signal,
              ),
            )
          await finishFrame(frame, records)
          if (outcome) {
            root!.notificationSelected = true
            root!.candidate.resolve(outcome)
          }
          return
        }
        const records: AcpRecordInput[] = []
        if (frame.childAdmission)
          records.push(
            ...children.update(
              message.method,
              message.params,
              owner,
              frame.wireOrdinal,
              frame.childAdmission,
            ),
          )
        if (
          records.length &&
          (owner.phase === 'live' || owner.phase === 'load_replay')
        )
          records.push(
            await nativeSource.source(
              { owner, itemId: `native-${frame.wireOrdinal}` },
              message.method,
              params,
              frame.numbers,
              new AbortController().signal,
            ),
          )
        const update = params?.update as Record<string, unknown> | undefined
        const child = frame.childAdmission
          ? children.context(params, frame.childAdmission)
          : null
        const childOnly =
          frame.childAdmission && children.isChild(frame.childAdmission)
        const subject =
          owner.phase === 'live' || owner.phase === 'load_replay'
            ? {
                owner,
                ...(child
                  ? { childId: child.childId, intervalId: child.intervalId }
                  : {}),
              }
            : null
        if (
          profile === 'grok' &&
          deps.grokRail === 'public' &&
          message.method === '_x.ai/session/update' &&
          update &&
          subject
        ) {
          const retained =
            typeof update.message_id === 'string' &&
            typeof params?.sessionId === 'string'
              ? responses.owner(params.sessionId, update.message_id)
              : null
          const selected = retained ?? (!childOnly || child ? subject : null)
          if (selected)
            records.push(
              ...(await responses.update(
                params,
                frame.numbers,
                selected,
                child?.childSessionId ??
                  selected.owner.binding.providerSessionId,
                owned(owner)?.controller.signal ?? new AbortController().signal,
              )),
            )
          if (!records.length)
            records.push(
              await nativeSource.source(
                {
                  ...(selected ?? subject),
                  itemId: `native-${frame.wireOrdinal}`,
                },
                message.method,
                params,
                frame.numbers,
                new AbortController().signal,
              ),
            )
          await finishFrame(frame, records)
          return
        }
        if (message.method === 'session/update' && update) {
          if (update.sessionUpdate === 'config_option_update') {
            io.catalog.update({ configOptions: update.configOptions })
            for (const notify of modelWaiters) notify()
          }
          if (
            (owner.phase === 'live' || owner.phase === 'load_replay') &&
            (!childOnly || child) &&
            params?.sessionId ===
              (child?.childSessionId ?? owner.binding.providerSessionId)
          ) {
            records.push(
              ...(await normalizer.update(
                update,
                frame.numbers,
                responses.current(
                  subject!,
                  update.sessionUpdate === 'agent_thought_chunk'
                    ? 'thought'
                    : 'assistant',
                ) ?? subject!,
                owned(owner)?.controller.signal ?? new AbortController().signal,
              )),
            )
          }
        }
        if (!records.length && subject)
          records.push(
            await nativeSource.source(
              { ...subject, itemId: `native-${frame.wireOrdinal}` },
              message.method,
              params,
              frame.numbers,
              new AbortController().signal,
            ),
          )
        await finishFrame(
          frame,
          failed
            ? [{ value: { kind: 'disposition', status: 'failed' } }]
            : records,
        )
      }
      const work = contentChain.then(process)
      contentChain = work.catch((error) => {
        fail(error)
        try {
          frame.ticket.failAdmission()
        } catch {
          /* Preserve finished ticket authority. */
        }
      })
      await work
    }
    try {
      connection = await AcpConnection.open(
        {
          profile,
          initialPolicy,
          launch: deps.launch,
          host: deps.host,
          ingestion: deps.ingestion,
          failure: fail,
          async prepareClient(io) {
            terminalHistory ??= createAcpTerminalHistory(
              deps.host,
              instanceId,
              io.generation,
            )
            services = await deps.services(io, terminalHistory)
            return {
              fs: { readTextFile: true, writeTextFile: true },
              terminal: true,
            }
          },
          route(strings, fallback, numbers, wireOrdinal, transportGeneration) {
            const promptId =
              strings['/params/promptId'] ?? strings['/params/update/prompt_id']
            const promptOwner =
              fallback.phase !== 'load_replay' && profile === 'grok' && promptId
                ? prompts.get(promptId)
                : undefined
            const responseOwner =
              fallback.phase !== 'load_replay' &&
              profile === 'grok' &&
              deps.grokRail === 'public' &&
              strings['/method'] === '_x.ai/session/update'
                ? responses.owner(
                    strings['/params/sessionId'] ?? '',
                    strings['/params/update/message_id'] ?? '',
                  )?.owner
                : undefined
            const admittedFallback = promptOwner ?? responseOwner ?? fallback
            const admission: AcpChildAdmission = {
              strings,
              numbers,
              wireOrdinal,
              transportGeneration,
              fallbackOwner: admittedFallback,
              exclusiveSubmittedRoot: Boolean(
                fallback.phase === 'live' &&
                current?.submitted &&
                !current.sealed &&
                digest(fallback) === digest(current.owner) &&
                digest(admittedFallback) === digest(current.owner),
              ),
              rootForPrompt: (id) => prompts.get(id) ?? null,
            }
            const child = children.route(admission)
            let owner = promptOwner ?? responseOwner ?? child ?? fallback
            if (children.isChild(admission)) {
              if (!child) owner = connection?.control ?? fallback
            } else if (
              !promptOwner &&
              !responseOwner &&
              owner.phase === 'live' &&
              (!owned(owner)?.submitted || owned(owner)?.sealed)
            )
              owner = connection?.control ?? fallback
            return { owner, childAdmission: admission }
          },
          incoming(message, frame, io) {
            if (frame.owner.phase === 'load_replay')
              replayOwners.set(digest(frame.owner), frame.owner)
            const work = incoming(message, frame, io)
            handlers.add(work)
            void work
              .finally(() => {
                handlers.delete(work)
                if (frame.owner.phase !== 'control')
                  retireSealedRoot(frame.owner)
              })
              .catch(fail)
            return work
          },
        },
        session,
        load,
      )
    } catch (error) {
      const cleanup = async () => {
        await Promise.allSettled(handlers)
        await contentChain.catch(() => {})
        const results = await Promise.allSettled([
          services?.filesystem.close(),
          services?.terminals.close(),
          attachments.close(),
          content.close(),
          ...(error instanceof NativeCleanupError
            ? [error.retryCleanup()]
            : []),
        ])
        const failed = results.filter((result) => result.status === 'rejected')
        if (failed.length)
          throw new AggregateError(
            failed.map((result) => result.reason),
            'ACP startup cleanup remains unresolved',
          )
        await terminalHistory?.close()
        normalizer.close()
        responses.close()
        children.close()
      }
      try {
        await cleanup()
      } catch {
        throw new NativeCleanupError(cleanup)
      }
      throw error
    }
    let io = connection
    const writeEvents = async (
      root: Root,
      bodies: Record<string, unknown>[],
      terminal = false,
    ) => {
      root.credits.consume()
      const events = bodies.map((body) => event(root.owner, body))
      const ticket = io.journal.reserve(
        root.owner,
        { kind: terminal ? 'terminal' : 'local', producerTicket: randomUUID() },
        terminal,
      )
      try {
        ticket.finish(
          events.map((event) => ({ value: { kind: 'event', event } })),
        )
      } catch (error) {
        ticket.failAdmission()
        throw error
      }
      await ticket.committed
      if (!terminal) for (const value of events) publish(value)
      return events
    }
    retireSealedRoot = (owner: AcpLiveOwner | AcpReplayOwner) => {
      const root = owned(owner)
      if (
        (owner.phase === 'live' &&
          (!root?.sealed || children.hasLive(owner))) ||
        !io.journal.canRetireOwner(owner)
      )
        return
      normalizer.retireOwner(owner)
      content.retireRoot(owner)
      io.journal.retireOwner(owner)
      if (owner.phase === 'load_replay') replayOwners.delete(digest(owner))
    }
    for (const owner of replayOwners.values()) retireSealedRoot(owner)
    const finalize = async (root: Root, outcome: TerminalOutcome) => {
      if (root.sealed) return
      root.sealed = true
      try {
        await interactions?.retireOwner(root.owner)
        await contentChain
      } catch (error) {
        outcome = {
          status: 'failed',
          code: 'acp_cleanup_failed',
          message: 'ACP cleanup failed',
        }
        fail(error)
      }
      try {
        const terminalEvents = await writeEvents(
          root,
          [{ type: 'turn_completed', outcome }],
          true,
        )
        root.completion.settle({
          ...outcome,
          runId: root.owner.runId,
          turnId: root.owner.turnId,
        })
        try {
          for (const value of terminalEvents) publish(value)
        } catch (error) {
          fail(error)
        }
        try {
          retireSealedRoot(root.owner)
        } catch (error) {
          fail(error)
        }
      } catch (error) {
        root.completion.reject(
          io.journal.completionFailure(root.owner, {
            receiptId: root.receipt.receiptId,
            completionId: root.completion.handle.completionId,
          }),
        )
        fail(error)
      } finally {
        root.release()
      }
    }
    const execute = async (root: Root) => {
      current = root
      let prepared: Awaited<ReturnType<typeof attachments.prepare>> | undefined
      try {
        await root.accepted
        if (root.cancelled) {
          await finalize(root, { status: 'interrupted' })
          return
        }
        if (failed) throw Error('ACP runtime failed')
        if (Date.now() - root.queuedAt > 300000)
          throw Error('ACP queued prompt expired')
        for (const change of dispatch(root.options ?? {}))
          await io.controlCall(
            change.method,
            { sessionId: io.binding!.providerSessionId, ...change.params },
            root.owner,
          )
        prepared = await attachments.prepare(
          session.id,
          root.input,
          io.promptCapabilities,
          root.controller.signal,
        )
        const call = io.call(
          'session/prompt',
          {
            sessionId: io.binding!.providerSessionId,
            prompt: prepared.blocks,
            ...(profile === 'grok'
              ? {
                  _meta: {
                    promptId: root.receipt.receiptId,
                    ...(deps.grokRail === 'comet'
                      ? { requestId: root.receipt.receiptId }
                      : {}),
                  },
                }
              : {}),
          },
          root.owner,
          {
            signal: root.controller.signal,
            timeoutMs: 1800000,
            onHandoff() {
              root.submitted = true
              io.setOwner(root.owner)
              prompts.set(root.receipt.receiptId, root.owner)
            },
          },
        )
        void call.submission.then(() => prepared?.release()).catch(fail)
        const native = call.response.then(async ({ value, frame }) => {
          try {
            const stopReason = zStopReason.parse(
              (value as Record<string, unknown>)?.stopReason,
            )
            const records = await normalizer.usage(
              (value as Record<string, unknown>).usage,
              profile === 'grok' ? 'grok_prompt' : 'standard',
              frame.numbers,
              '/result/usage',
              { owner: root.owner },
              root.controller.signal,
            )
            await finishFrame(frame, records)
            return stop(stopReason)
          } catch (error) {
            try {
              await finishFrame(frame, [
                { value: { kind: 'disposition', status: 'failed' } },
              ])
            } catch {
              /* Journal preserves its original failure. */
            }
            throw error
          }
        })
        void native.catch(() => {})
        const candidate = await Promise.race([native, root.candidate.promise])
        if (root.cancelled)
          await io.rpc.notify('session/cancel', {
            sessionId: root.owner.binding.providerSessionId,
          })
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            native,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(Error('ACP prompt response did not drain')),
                2000,
              )
            }),
          ])
        } catch (error) {
          if (!root.notificationSelected || profile !== 'grok') throw error
          await io.retireProcess()
          await native.catch(() => {})
          renewalRequired.add(handle)
        } finally {
          clearTimeout(timer)
        }
        await call.submission
        await finalize(root, candidate)
      } catch (error) {
        root.controller.abort()
        let cleanupFailed = false
        if (root.submitted) {
          try {
            await io.rpc.notify('session/cancel', {
              sessionId: root.owner.binding.providerSessionId,
            })
          } catch {
            /* Retire the original process even when cancellation cannot be written. */
          }
          try {
            await io.retireProcess()
          } catch (cleanupError) {
            cleanupFailed = true
            fail(cleanupError)
          }
        }
        await finalize(
          root,
          cleanupFailed
            ? {
                status: 'failed',
                code: 'acp_cleanup_failed',
                message: 'ACP cleanup failed',
              }
            : root.cancelled
              ? { status: 'interrupted' }
              : {
                  status: 'failed',
                  code: 'acp_prompt_failed',
                  message: 'ACP prompt failed',
                },
        )
        if (root.submitted) fail(error)
      } finally {
        await prepared?.release()
        if (current === root) {
          current = undefined
          io.setOwner(null)
        }
      }
    }
    let pumping = false
    let draining: Promise<void> = Promise.resolve()
    const pump = () => {
      if (pumping) return
      pumping = true
      draining = (async () => {
        try {
          while (queue.length) {
            const root = queue.shift()!
            root.execution = execute(root)
            await root.execution
          }
        } catch (error) {
          fail(error)
          for (const root of queue.splice(0)) {
            try {
              await finalize(root, {
                status: 'failed',
                code: 'acp_runtime_failed',
                message: 'ACP runtime failed',
              })
            } catch (finalError) {
              fail(finalError)
            }
          }
        } finally {
          pumping = false
          retireExpired()
        }
      })()
    }
    const waitModel = async (id: string) => {
      if (typeof id !== 'string' || !id || Buffer.byteLength(id) > 512)
        throw Error('Invalid ACP model identity')
      try {
        return io.catalog.model(id)
      } catch (error) {
        if (profile !== 'devin') throw error
      }
      const release = deps.host.reserve(
        instanceId,
        'retained',
        Buffer.byteLength(id) * 2 + 1024,
      )
      try {
        return await new Promise<ReturnType<typeof io.catalog.model>>(
          (resolve, reject) => {
            const check = () => {
              if (closing || failed) {
                done()
                reject(Error('ACP session is unavailable'))
                return
              }
              try {
                const change = io.catalog.model(id)
                done()
                resolve(change)
              } catch {
                /* Await exact advertisement. */
              }
            }
            const timer = setTimeout(() => {
              done()
              reject(Error('ACP model advertisement timed out'))
            }, 10000)
            const done = () => {
              clearTimeout(timer)
              modelWaiters.delete(check)
            }
            modelWaiters.add(check)
            check()
          },
        )
      } finally {
        release()
      }
    }
    let lifetimeExpired = false
    let retirementScheduled = false
    const retireExpired = () => {
      if (rootCount >= 256 || Date.now() - createdAt >= 24 * 60 * 60 * 1000)
        lifetimeExpired = true
      if (
        lifetimeExpired &&
        !current &&
        !queue.length &&
        !configurationPending &&
        !closing &&
        !retirementScheduled
      ) {
        retirementScheduled = true
        void Promise.resolve()
          .then(() => handle.kill())
          .catch(fail)
      }
    }
    const lifetimeTimer = setTimeout(
      retireExpired,
      Math.max(0, createdAt + 24 * 60 * 60 * 1000 - Date.now()),
    )
    lifetimeTimer.unref?.()
    const handle: HarnessHandle = {
      get binding() {
        return io.binding
      },
      prompt(input, options, identity) {
        const releaseCapture = deps.host.reserve(
          instanceId,
          'retained',
          32 * 1024 * 1024,
        )
        try {
          if (closing || failed) throw Error('ACP session is unavailable')
          if (
            rootCount >= 256 ||
            Date.now() - createdAt >= 24 * 60 * 60 * 1000 ||
            lifetimeExpired
          ) {
            lifetimeExpired = true
            retireExpired()
            throw Error('ACP session prompt limit')
          }
          if (queue.length >= 8) throw Error('ACP session queue limit')
          const captured = captureAcpPrompt(input, options, identity)
          if (configurationPending)
            throw Error('ACP configuration change is pending')
          dispatch(captured.options ?? {})
          const owner: AcpLiveOwner = immutableData({
            phase: 'live',
            sessionId: session.id,
            providerInstanceId: instanceId,
            account: io.account,
            runtimeGeneration: io.generation,
            binding: io.binding!,
            runId: captured.identity?.runId ?? randomUUID(),
            turnId: captured.identity?.turnId ?? randomUUID(),
          })
          const key = digest(owner)
          if (roots.has(key)) throw Error('ACP root identity is already used')
          const completion = createCompletionHandle(
            {
              completionId: randomUUID(),
              runId: owner.runId,
              turnId: owner.turnId,
            },
            { persistenceRejection: true },
          )
          const releases: Array<() => void> = []
          let credits: Root['credits'], releaseOwner: () => void
          try {
            releases.push(deps.host.reserve(instanceId, 'turns'))
            releases.push(
              deps.host.reserve(
                instanceId,
                'retained',
                Buffer.byteLength(JSON.stringify(captured)) * 2 + 1024,
              ),
            )
            releaseOwner = deps.host.reserve(
              instanceId,
              'retained',
              Buffer.byteLength(JSON.stringify(owner)) * 2 + 2048,
            )
            releases.push(releaseOwner)
            credits = io.journal.reserveCredits(2)
          } catch (error) {
            releases.reverse().forEach((release) => release())
            throw error
          }
          const receipt = {
            receiptId: randomUUID(),
            runId: owner.runId,
            turnId: owner.turnId,
            completion: completion.handle,
          }
          let released = false
          const root: Root = {
            owner,
            receipt,
            completion,
            input: captured.input,
            options: captured.options,
            controller: new AbortController(),
            releaseOwner,
            credits,
            release() {
              if (released) return
              released = true
              root.input = ''
              root.options = undefined
              credits.release()
              releases[1]!()
              releases[0]!()
            },
            submitted: false,
            cancelled: false,
            sealed: false,
            events: 0,
            bytes: 0,
            queuedAt: Date.now(),
            candidate: candidate(),
            accepted: Promise.resolve(),
          }
          roots.set(key, root)
          rootCount++
          root.accepted = writeEvents(root, [
            { type: 'run_started' },
            { type: 'turn_started' },
            { type: 'prompt_accepted', receiptId: receipt.receiptId },
          ]).then(() => {})
          void root.accepted.catch(() => {})
          queue.push(root)
          pump()
          return receipt
        } finally {
          releaseCapture()
        }
      },
      async cancel() {
        for (const root of [current, ...queue])
          if (root && !root.sealed) {
            root.cancelled = true
            root.candidate.resolve({ status: 'interrupted' })
            if (!root.submitted) root.controller.abort()
          }
        await draining
      },
      kill() {
        closePromise ??= (async () => {
          closing = true
          clearTimeout(lifetimeTimer)
          for (const notify of modelWaiters) notify()
          await handle.cancel()
          await Promise.allSettled(
            [...roots.values()].map((root) => root.execution),
          )
          await Promise.all([
            services!.filesystem.close(),
            services!.terminals.close(),
          ])
          await io.close()
          await Promise.allSettled(handlers)
          await attachments.close()
          await content.close()
          normalizer.close()
          responses.close()
          await terminalHistory?.close()
          await deps.saveChildHistory?.(session, children.snapshot())
          children.close()
          for (const root of roots.values()) root.releaseOwner()
          roots.clear()
          prompts.clear()
        })().catch((error) => {
          closePromise = undefined
          throw error
        })
        return closePromise
      },
      replyPermission(reply) {
        if (!interactions) throw Error('ACP request is unavailable')
        return interactions.replyPermission(reply)
      },
      replyQuestion(id, answers) {
        if (!interactions) throw Error('ACP request is unavailable')
        return interactions.replyQuestion(id, answers)
      },
      configOptions() {
        return io.catalog.snapshot()
      },
      get availableModels() {
        return io.catalog.availableModels()
      },
      async setModel(id) {
        if (
          (current && !current.sealed) ||
          queue.length ||
          configurationPending ||
          closing ||
          lifetimeExpired ||
          failed
        )
          throw Error('ACP model change requires an idle session')
        configurationPending = true
        try {
          await current?.execution
          if (closing || failed) throw Error('ACP session is unavailable')
          const change = await waitModel(id)
          const result = await io.controlCall(change.method, {
            sessionId: io.binding!.providerSessionId,
            ...change.params,
          })
          if (!result || typeof result !== 'object' || Array.isArray(result))
            throw Error('Invalid ACP configuration response')
          io.catalog.update(result)
        } finally {
          configurationPending = false
          retireExpired()
        }
      },
      async setConfigOption(id, value) {
        if (
          (current && !current.sealed) ||
          queue.length ||
          configurationPending ||
          closing ||
          lifetimeExpired ||
          failed
        )
          throw Error('ACP configuration requires an idle session')
        configurationPending = true
        try {
          await current?.execution
          if (closing || failed) throw Error('ACP session is unavailable')
          const change = io.catalog.config(id, value)
          const result = await io.controlCall(change.method, {
            sessionId: io.binding!.providerSessionId,
            ...change.params,
          })
          if (!result || typeof result !== 'object' || Array.isArray(result))
            throw Error('Invalid ACP configuration response')
          io.catalog.update(result)
          if (id === nativeModeSelectorId) nativeMode = String(value)
        } finally {
          configurationPending = false
          retireExpired()
        }
      },
    }
    replacements.set(handle, async (policy) => {
      if (
        closing ||
        lifetimeExpired ||
        failed ||
        (current && !current.sealed) ||
        queue.length ||
        configurationPending
      )
        throw Error('ACP replacement requires an idle session')
      configurationPending = true
      try {
        await current?.execution
        await io.retireProcess()
        await Promise.allSettled(handlers)
        await contentChain
        await Promise.all([
          services!.filesystem.close(),
          services!.terminals.close(),
        ])
        interactions = undefined
        const replacement = await io.replace(policy)
        io = connection = replacement
        for (const owner of replayOwners.values()) retireSealedRoot(owner)
        initialPolicy = policy
        renewalRequired.delete(handle)
      } catch (error) {
        fail(error)
        throw error
      } finally {
        configurationPending = false
      }
    })
    return handle
  }
  return {
    kind: profile === 'custom-acp' ? 'custom' : 'acp',
    capabilities: {
      loadSession: acpProviderDescriptors[profile].load,
      steer: false,
      queue: true,
      cancel: true,
      permissions: true,
      questions: profile === 'grok',
      models: true,
    },
    spawn: (session, emit) =>
      profile === 'grok'
        ? openGrokPolicySession(
            open,
            session,
            emit,
            false,
            deps.host,
            deps.launch.providerInstanceId,
            (handle) => renewalRequired.has(handle),
            (handle, policy) => replacements.get(handle)!(policy),
          )
        : open(session, emit, false),
    ...(acpProviderDescriptors[profile].load
      ? {
          load: (
            session: HarnessSession,
            emit: (event: HarnessEvent) => void,
          ) =>
            profile === 'grok'
              ? openGrokPolicySession(
                  open,
                  session,
                  emit,
                  true,
                  deps.host,
                  deps.launch.providerInstanceId,
                  (handle) => renewalRequired.has(handle),
                  (handle, policy) => replacements.get(handle)!(policy),
                )
              : open(session, emit, true),
        }
      : {}),
  }
}
