import { createHash } from 'node:crypto'

export function immutableData<T>(input: T, maximum = 1024 * 1024): T {
  return copyData(input, maximum) as T
}
export function immutableNumericData(
  input: unknown,
  numeric: (path: string, value: number) => string,
  maximum = 1024 * 1024,
): unknown {
  return copyData(input, maximum, numeric)
}
function copyData(
  input: unknown,
  maximum: number,
  numeric?: (path: string, value: number) => string,
): unknown {
  let bytes = 0,
    nodes = 0
  const ancestors = new Set<object>()
  const copy = (value: unknown, depth: number, path: string): unknown => {
    if (++nodes > 65536 || depth > 64)
      throw Error('ACP value exceeds structure limit')
    if (value === null || value === undefined || typeof value === 'boolean')
      return value
    if (typeof value === 'number') {
      if (numeric) return copy(numeric(path, value), depth, path)
      if (!Number.isFinite(value)) throw Error('ACP value must be finite')
      return value
    }
    if (typeof value === 'string') {
      bytes += Buffer.byteLength(value)
      if (bytes > maximum) throw Error('ACP value exceeds byte limit')
      return value
    }
    if (typeof value !== 'object' || ancestors.has(value))
      throw Error('ACP value must be plain acyclic data')
    const proto = Object.getPrototypeOf(value)
    if (!Array.isArray(value) && proto !== Object.prototype && proto !== null)
      throw Error('ACP value must be plain data')
    ancestors.add(value)
    const entries = Object.getOwnPropertyDescriptors(value)
    if (Reflect.ownKeys(entries).length > 65536)
      throw Error('ACP value exceeds structure limit')
    const result: Record<string, unknown> | unknown[] = Array.isArray(value)
      ? []
      : Object.create(null)
    if (Array.isArray(value)) {
      if (value.length > 65536) throw Error('ACP array exceeds structure limit')
      for (let index = 0; index < value.length; index++)
        if (
          !entries[String(index)] ||
          entries[String(index)]!.value === undefined
        )
          throw Error('ACP array holes and undefined are unsupported')
    }
    for (const key of Reflect.ownKeys(entries)) {
      if (typeof key !== 'string')
        throw Error('ACP symbol keys are unsupported')
      if (Array.isArray(value) && key === 'length') continue
      if (
        Array.isArray(value) &&
        (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)
      )
        throw Error('ACP array properties are unsupported')
      const descriptor = entries[key]!
      if (!('value' in descriptor)) throw Error('ACP accessors are unsupported')
      bytes += Buffer.byteLength(key)
      if (bytes > maximum) throw Error('ACP value exceeds byte limit')
      Object.defineProperty(result, key, {
        value: copy(
          descriptor.value,
          depth + 1,
          numeric
            ? path + '/' + key.replaceAll('~', '~0').replaceAll('/', '~1')
            : '',
        ),
        enumerable: true,
      })
    }
    ancestors.delete(value)
    return Object.freeze(result)
  }
  return copy(input, 0, '')
}
function encode(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(encode).join(',') + ']'
  return (
    '{' +
    Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map(
        (key) =>
          JSON.stringify(key) +
          ':' +
          encode((value as Record<string, unknown>)[key]),
      )
      .join(',') +
    '}'
  )
}
export function canonical(value: unknown): string {
  if (value === undefined) throw Error('ACP root undefined is unsupported')
  return encode(immutableData(value, 4 * 1024 * 1024))
}
export const digest = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex')
