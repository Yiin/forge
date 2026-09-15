import { createAcpFilesystem } from '../harnesses/acp/filesystem.js'
import { createAcpTerminals } from '../harnesses/acp/terminals.js'
import { immutableData } from '../harnesses/acp/data.js'
import type { AcpResourceHost } from '../harnesses/acp/limits.js'
import type { AcpRuntimeDependencies } from '../harnesses/acp/runtime.js'
import type { AcpAttachmentResolver } from '../harnesses/acp/attachments.js'
import { NativeCleanupError } from '../harnesses/native-cleanup.js'
import type { createNativeAttachmentLoader } from '../uploads/native.js'

export function createProductionAcpServices(options: {
  host: AcpResourceHost
  instanceId: string
  approvedEnv: Readonly<Record<string, string | undefined>>
}): AcpRuntimeDependencies['services'] {
  const { host, instanceId } = options
  const approvedEnv = immutableData(options.approvedEnv)
  return async (connection, history) => {
    const account = immutableData(connection.account)
    const authority = {
      session: immutableData(connection.session),
      runtimeGeneration: connection.generation,
      transportGeneration: connection.transportGeneration,
      binding: () => connection.binding,
      rpc: connection.rpc,
      host,
      instanceId,
    }
    const filesystem = await createAcpFilesystem(authority)
    try {
      const terminals = await createAcpTerminals({
        ...authority,
        account,
        history,
        approvedEnv,
      })
      return { filesystem, terminals }
    } catch (error) {
      try {
        await filesystem.close()
      } catch {
        throw new NativeCleanupError(async () => {
          const results = await Promise.allSettled([
            Promise.resolve().then(() => filesystem.close()),
            ...(error instanceof NativeCleanupError
              ? [error.retryCleanup()]
              : []),
          ])
          for (const result of results)
            if (result.status === 'rejected') throw result.reason
        })
      }
      throw error
    }
  }
}

/** Reads completed uploads through their exact session and original descriptor revision. */
export function createAcpAttachmentResolver(
  loadAttachment: ReturnType<typeof createNativeAttachmentLoader>,
): AcpAttachmentResolver {
  return async (sessionId, attachmentId, { signal, maxBytes }) => {
    signal.throwIfAborted()
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 0 ||
      maxBytes > 8 * 1024 * 1024
    )
      throw Error('Invalid ACP attachment read limit')
    const controller = new AbortController()
    const abort = () => controller.abort(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    try {
      const file = await loadAttachment(
        sessionId,
        attachmentId,
        controller.signal,
      )
      controller.signal.throwIfAborted()
      if (file.sizeBytes > maxBytes)
        throw Error('ACP attachment exceeds read limit')
      let closed = false
      let work: Promise<{ bytes: Uint8Array; eof: boolean }> | undefined
      let closing: Promise<void> | undefined
      return {
        sessionId,
        attachmentId,
        status: 'ready',
        mime: file.mime,
        size: file.sizeBytes,
        sha256: file.sha256,
        uri: `forge-attachment:${encodeURIComponent(sessionId)}/${encodeURIComponent(attachmentId)}`,
        reader: {
          read(limit, readSignal) {
            if (closed || work)
              return Promise.reject(
                Error('ACP attachment reader is unavailable'),
              )
            if (!Number.isSafeInteger(limit) || limit < file.sizeBytes + 1)
              return Promise.reject(
                Error('ACP attachment read requires EOF capacity'),
              )
            const readAbort = () => controller.abort(readSignal.reason)
            readSignal.addEventListener('abort', readAbort, { once: true })
            if (readSignal.aborted) readAbort()
            work = Promise.resolve()
              .then(async () => {
                controller.signal.throwIfAborted()
                const bytes = await file.readBytes()
                controller.signal.throwIfAborted()
                return { bytes, eof: true }
              })
              .finally(() => readSignal.removeEventListener('abort', readAbort))
            return work
          },
          close() {
            if (closing) return closing
            closed = true
            controller.abort()
            signal.removeEventListener('abort', abort)
            closing = Promise.resolve().then(async () => {
              try {
                await work
              } catch (error) {
                if (error instanceof NativeCleanupError)
                  await error.retryCleanup()
              }
              work = undefined
            })
            const pending = closing
            void pending.catch(() => {
              if (closing === pending) closing = undefined
            })
            return pending
          },
        },
      }
    } catch (error) {
      signal.removeEventListener('abort', abort)
      controller.abort()
      throw error
    }
  }
}
