import type { HarnessHandle, HarnessSession, HarnessEvent } from '../types.js'
import type { AcpResourceHost } from './limits.js'
import { immutableData } from './data.js'
import {
  promptInputSchema,
  dispatchOptionsSchema,
  completionIdentityIdSchema,
} from '@forge/protocol/harness'

type Policy = 'manual' | 'yolo'
type Open = (
  session: HarnessSession,
  emit: (event: HarnessEvent) => void,
  load: boolean,
  policy: Policy,
) => Promise<HarnessHandle>

/** A policy change owns a new process before it admits another root. */
export async function openGrokPolicySession(
  open: Open,
  session: HarnessSession,
  emit: (event: HarnessEvent) => void,
  load: boolean,
  host: AcpResourceHost,
  instanceId: string,
  needsRenewal: (handle: HarnessHandle) => boolean,
  replace: (handle: HarnessHandle, policy: Policy) => Promise<void>,
): Promise<HarnessHandle> {
  const capturedSession = immutableData(session)
  const current = await open(capturedSession, emit, load, 'manual')
  let policy: Policy = 'manual',
    closed = false,
    fenced: unknown,
    pending = 0,
    cancelEpoch = 0
  let admission = Promise.resolve(),
    closeWork: Promise<void> | undefined
  const completions = new Set<Promise<unknown>>()
  const unavailable = () => {
    if (closed || fenced) throw Error('ACP policy session is unavailable')
  }
  const deadline = <T>(work: Promise<T>, expire: () => void) => {
    let timer: ReturnType<typeof setTimeout>
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expire()
        reject(Error('ACP policy admission expired'))
      }, 300000)
    })
    void work.finally(() => clearTimeout(timer)).catch(() => {})
    return Promise.race([work, timeout])
  }
  const control = (
    method: 'setModel' | 'setConfigOption',
    id: string,
    value?: string | boolean,
  ) => {
    unavailable()
    if (pending >= 9) throw Error('ACP policy admission limit')
    const releaseCapture = host.reserve(instanceId, 'retained', 1024 * 1024)
    let captured: { id: string; value?: string | boolean }, release: () => void
    try {
      captured = immutableData({ id, value }, 16 * 1024)
      release = host.reserve(
        instanceId,
        'retained',
        Buffer.byteLength(JSON.stringify(captured)) * 2 + 1024,
      )
    } finally {
      releaseCapture()
    }
    const originalEpoch = cancelEpoch
    let expired = false
    pending++
    const work = admission
      .then(async () => {
        unavailable()
        if (originalEpoch !== cancelEpoch || expired)
          throw Error('ACP policy admission was cancelled')
        if (method === 'setModel') await current.setModel?.(captured.id)
        else await current.setConfigOption?.(captured.id, captured.value!)
      })
      .finally(() => {
        pending--
        release()
      })
    admission = work.then(
      () => {},
      () => {},
    )
    return deadline(work, () => {
      expired = true
    })
  }
  const handle: HarnessHandle = {
    get requiresResume() {
      return current.requiresResume
    },
    get binding() {
      return current.binding
    },
    prompt(input, options, identity) {
      unavailable()
      if (pending >= 9) throw Error('ACP policy admission limit')
      const release = host.reserve(instanceId, 'retained', 32 * 1024 * 1024)
      let captured: ReturnType<typeof captureAcpPrompt>,
        releaseSnapshot: () => void
      try {
        captured = captureAcpPrompt(input, options, identity)
        if (captured.options?.permissionMode === 'auto')
          throw Error('ACP auto permission mode is unsupported')
        releaseSnapshot = host.reserve(
          instanceId,
          'retained',
          Buffer.byteLength(JSON.stringify(captured)) * 2 + 1024,
        )
      } finally {
        release()
      }
      const originalEpoch = cancelEpoch
      let expired = false
      const live = () => {
        unavailable()
        if (cancelEpoch !== originalEpoch || expired)
          throw Error('ACP policy admission was cancelled')
      }
      const requested: Policy =
        captured.options?.permissionMode === 'yolo' ? 'yolo' : 'manual'
      pending++
      const work = admission
        .then(async () => {
          live()
          await Promise.allSettled(completions)
          live()
          if (requested !== policy || needsRenewal(current)) {
            const binding = immutableData(current.binding)
            if (!binding)
              throw Error('ACP policy change requires a confirmed session')
            try {
              await replace(current, requested)
              live()
              policy = requested
            } catch (error) {
              fenced ??= error
              throw error
            }
          }
          live()
          const receipt = await current.prompt(
            captured.input,
            captured.options,
            captured.identity,
          )
          const completion = Promise.resolve(receipt.completion)
          completions.add(completion)
          void completion
            .finally(() => completions.delete(completion))
            .catch(() => {})
          return receipt
        })
        .finally(() => {
          pending--
          releaseSnapshot()
        })
      admission = work.then(
        () => {},
        () => {},
      )
      return deadline(work, () => {
        expired = true
      })
    },
    async cancel() {
      cancelEpoch++
      await current.cancel()
    },
    kill() {
      if (closeWork) return closeWork
      closed = true
      closeWork = Promise.resolve()
        .then(async () => {
          await current.cancel()
          await admission
          await current.kill()
        })
        .catch((error) => {
          closeWork = undefined
          throw error
        })
      return closeWork
    },
    replyPermission: (reply) => current.replyPermission?.(reply),
    replyQuestion: (id, answers) => current.replyQuestion?.(id, answers),
    configOptions: () => current.configOptions?.() ?? [],
    get availableModels() {
      return current.availableModels
    },
    setModel: (id) => control('setModel', id),
    setConfigOption: (id, value) => control('setConfigOption', id, value),
  }
  return handle
}
export function captureAcpPrompt(
  input: Parameters<HarnessHandle['prompt']>[0],
  options: Parameters<HarnessHandle['prompt']>[1],
  identity: Parameters<HarnessHandle['prompt']>[2],
) {
  const captured = immutableData({ input, options, identity }, 2 * 1024 * 1024)
  if (typeof captured.input !== 'string') {
    if (!Array.isArray(captured.input) || captured.input.length > 128)
      throw Error('Invalid ACP prompt input')
    for (const part of captured.input) promptInputSchema.parse(part)
  }
  if (captured.options !== undefined) {
    dispatchOptionsSchema.parse(captured.options)
    if (
      captured.options.approvalPolicy != null ||
      captured.options.sandboxPolicy != null ||
      captured.options.serviceTier != null
    )
      throw Error('ACP dispatch policy is unsupported')
  }
  if (captured.identity !== undefined) {
    completionIdentityIdSchema.parse(captured.identity.runId)
    completionIdentityIdSchema.parse(captured.identity.turnId)
  }
  return captured
}
