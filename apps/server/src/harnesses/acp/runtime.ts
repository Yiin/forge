import { randomUUID } from 'node:crypto'
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
  services(
    connection: AcpConnection,
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
  const profile = deps.profile
  const open = async (
    session: HarnessSession,
    emit: (event: HarnessEvent) => void,
    load: boolean,
  ): Promise<HarnessHandle> => {
    session = immutableData(session)
    const instanceId = deps.launch.providerInstanceId
    const content = createAcpContent({
      host: deps.host,
      instanceId,
      store: deps.contentStore,
    })
    const normalizer = new AcpNormalizer(content, deps.host, instanceId)
    const attachments = createAcpAttachments({
      host: deps.host,
      instanceId,
      authorizedAttachment: deps.authorizedAttachment,
    })
    let connection: AcpConnection | undefined,
      services:
        Awaited<ReturnType<AcpRuntimeDependencies['services']>> | undefined,
      interactions: AcpInteractions | undefined
    let closePromise: Promise<void> | undefined
    let current: Root | undefined,
      closing = false,
      failed: unknown,
      contentChain = Promise.resolve(),
      published = 0,
      publishedBytes = 0,
      rootCount = 0
    const roots = new Map<string, Root>(),
      prompts = new Map<string, AcpLiveOwner>(),
      queue: Root[] = [],
      handlers = new Set<Promise<void>>()
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
        if (
          profile === 'grok' &&
          message.method === '_x.ai/session/prompt_complete'
        ) {
          const value = immutableData(params)
          const promptId = value?.promptId
          if (
            typeof promptId === 'string' &&
            typeof value?.stopReason === 'string'
          ) {
            const original = prompts.get(promptId),
              root = original && owned(original)
            if (
              root &&
              root.submitted &&
              !root.sealed &&
              value?.sessionId === original.binding.providerSessionId
            )
              root.candidate.resolve(stop(value.stopReason))
          }
          await finishFrame(frame, [])
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
        const update = params?.update as Record<string, unknown> | undefined
        if (message.method === 'session/update' && update) {
          if (update.sessionUpdate === 'config_option_update')
            io.catalog.update({ configOptions: update.configOptions })
          const child = frame.childAdmission
            ? children.context(params, frame.childAdmission)
            : null
          const childOnly =
            frame.childAdmission && children.isChild(frame.childAdmission)
          if (
            (owner.phase === 'live' || owner.phase === 'load_replay') &&
            (!childOnly || child)
          ) {
            records.push(
              ...(await normalizer.update(
                update,
                frame.numbers,
                {
                  owner,
                  ...(child
                    ? { childId: child.childId, intervalId: child.intervalId }
                    : {}),
                },
                owned(owner)?.controller.signal ?? new AbortController().signal,
              )),
            )
          }
        }
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
          launch: deps.launch,
          host: deps.host,
          ingestion: deps.ingestion,
          failure: fail,
          async prepareClient(io) {
            services = await deps.services(io)
            return {
              fs: { readTextFile: true, writeTextFile: true },
              terminal: true,
            }
          },
          route(strings, fallback, numbers, wireOrdinal) {
            const admission: AcpChildAdmission = {
              strings,
              numbers,
              wireOrdinal,
              fallbackOwner: fallback,
              exclusiveSubmittedRoot: Boolean(
                current?.submitted && !current.sealed,
              ),
              rootForPrompt: (id) => prompts.get(id) ?? null,
            }
            const child = children.route(admission)
            let owner = child ?? fallback
            if (children.isChild(admission)) {
              if (!child) owner = connection?.control ?? fallback
            } else if (
              owner.phase === 'live' &&
              (!owned(owner)?.submitted || owned(owner)?.sealed)
            )
              owner = connection?.control ?? fallback
            return { owner, childAdmission: admission }
          },
          incoming(message, frame, io) {
            const work = incoming(message, frame, io)
            handlers.add(work)
            void work.finally(() => handlers.delete(work)).catch(() => {})
            return work
          },
        },
        session,
        load,
      )
    } catch (error) {
      await Promise.allSettled(handlers)
      await contentChain.catch(() => {})
      await Promise.allSettled([
        services?.filesystem.close(),
        services?.terminals.close(),
        attachments.close(),
        content.close(),
      ])
      normalizer.close()
      children.close()
      throw error
    }
    const io = connection
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
          if (!children.hasLive(root.owner)) {
            normalizer.retire({ owner: root.owner })
            content.retireRoot(root.owner)
            io.journal.retireOwner(root.owner)
          }
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
        for (const change of io.catalog.dispatch(root.options ?? {}))
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
              ? { _meta: { promptId: root.receipt.receiptId } }
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
        }
      })()
    }
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
          if (queue.length >= 8 || rootCount >= 256)
            throw Error('ACP session prompt limit')
          const captured = immutableData(
            { input, options, identity },
            2 * 1024 * 1024,
          )
          io.catalog.dispatch(captured.options ?? {})
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
        if (current || queue.length)
          throw Error('ACP model change requires an idle session')
        const change = io.catalog.model(id)
        const result = await io.controlCall(change.method, {
          sessionId: io.binding!.providerSessionId,
          ...change.params,
        })
        if (!result || typeof result !== 'object' || Array.isArray(result))
          throw Error('Invalid ACP configuration response')
        io.catalog.update(result)
      },
      async setConfigOption(id, value) {
        if (current || queue.length)
          throw Error('ACP configuration requires an idle session')
        const change = io.catalog.config(id, value)
        const result = await io.controlCall(change.method, {
          sessionId: io.binding!.providerSessionId,
          ...change.params,
        })
        if (!result || typeof result !== 'object' || Array.isArray(result))
          throw Error('Invalid ACP configuration response')
        io.catalog.update(result)
      },
    }
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
    spawn: (session, emit) => open(session, emit, false),
    ...(acpProviderDescriptors[profile].load
      ? {
          load: (
            session: HarnessSession,
            emit: (event: HarnessEvent) => void,
          ) => open(session, emit, true),
        }
      : {}),
  }
}
