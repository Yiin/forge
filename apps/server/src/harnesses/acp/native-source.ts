import type { createAcpContent } from './content.js'
import { immutableData, immutableNumericData } from './data.js'
import type { AcpContentOwner, AcpRecordInput } from './ingestion.js'
import type { AcpResourceHost } from './limits.js'
import type { NumericCapture } from './numbers.js'

const MiB = 1024 * 1024
const numeric = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/

function rejectBinary(value: unknown) {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) rejectBinary(item)
    return
  }
  const record = value as Record<string, unknown>
  if (
    ((record.type === 'image' || record.type === 'audio') &&
      typeof record.data === 'string') ||
    (record.type === 'resource' &&
      record.resource &&
      typeof record.resource === 'object' &&
      'blob' in record.resource)
  )
    throw Error('ACP binary content requires a content artifact')
  for (const child of Object.values(record)) rejectBinary(child)
}

/** Persist native evidence without assigning a display meaning to unknown fields. */
export function createAcpNativeSource(options: {
  content: Pick<ReturnType<typeof createAcpContent>, 'source'>
  host: AcpResourceHost
  instanceId: string
}) {
  const { host, instanceId } = options
  const putSource = options.content.source.bind(options.content)
  return {
    async source(
      input: AcpContentOwner,
      method: string,
      params: unknown,
      capture: NumericCapture,
      signal: AbortSignal,
    ): Promise<AcpRecordInput> {
      signal.throwIfAborted()
      const release = host.reserve(instanceId, 'retained', 16 * MiB)
      try {
        const subject = immutableData(input, 16384)
        if (subject.owner.providerInstanceId !== instanceId)
          throw Error('ACP source owner mismatch')
        if (
          typeof method !== 'string' ||
          !method ||
          Buffer.byteLength(method) > 512 ||
          method.includes('\0')
        )
          throw Error('Invalid ACP source method')
        const captured = immutableData(capture, MiB)
        if (!Array.isArray(captured.numbers) || captured.numbers.length > 16384)
          throw Error('ACP numeric source limit')
        const tokens = new Map<string, NumericCapture['numbers'][number]>()
        for (const token of captured.numbers) {
          if (
            typeof token.path !== 'string' ||
            typeof token.text !== 'string' ||
            !numeric.test(token.text) ||
            !Number.isSafeInteger(token.offset) ||
            token.offset < 0
          )
            throw Error('Invalid ACP numeric source')
          if (token.path !== '/params' && !token.path.startsWith('/params/'))
            continue
          if (tokens.has(token.path))
            throw Error('Duplicate ACP numeric source')
          tokens.set(token.path, token)
        }
        const used = new Set<string>()
        const preserved = immutableNumericData(
          params,
          (path, value) => {
            const key = '/params' + path
            const token = tokens.get(key)
            if (!token || !Object.is(Number(token.text), value))
              throw Error('ACP numeric source mismatch')
            used.add(key)
            return token.text
          },
          MiB,
        )
        if (used.size !== tokens.size)
          throw Error('ACP numeric source does not match params')
        rejectBinary(preserved)
        const metadata = {
          method,
          params: preserved,
          numbers: [...tokens.values()],
        }
        const reference = await putSource(subject, metadata, signal)
        const { owner: _owner, ...recordSubject } = subject
        return Object.freeze({
          subject: Object.freeze(recordSubject),
          value: Object.freeze({
            kind: 'disposition',
            status: 'ignored',
            code: 'native_source_only',
          }),
          sourceRefs: Object.freeze([reference]),
        })
      } finally {
        release()
      }
    },
  }
}
